#!/usr/bin/env node
/**
 * Downloads the pinned yt-dlp and FFmpeg builds into `.tools/`.
 *
 * The engine prefers a binary here over one on PATH, so a deployment gets the exact
 * version the manifest names rather than whatever the host happens to have. Every
 * download is checked against the publisher's own checksum file before it is written
 * into place; a mismatch aborts rather than warns.
 *
 * yt-dlp is re-fetched whenever the pinned version differs from the one installed, which
 * `.tools/yt-dlp.version` records, so running this after a pin moves is the whole upgrade.
 *
 * Usage:
 *   node scripts/fetch-tools.mjs            # fetch anything missing or out of date
 *   node scripts/fetch-tools.mjs --force    # re-fetch even if present
 *   node scripts/fetch-tools.mjs --only=ytdlp
 *   node scripts/fetch-tools.mjs --only=ytdlp --pin-from=main
 *
 * `--pin-from=<branch>` takes the yt-dlp version from that branch's manifest on GitHub
 * instead of this checkout's. An extraction node uses it to follow what the deployment
 * runs without pulling the checkout it runs from; the binary is still checked against
 * yt-dlp's own published checksums, exactly as for a local pin.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, '.tools');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tools.manifest.json'), 'utf8'));
/** Where `--pin-from` reads a branch's manifest. */
const MANIFEST_REPO = process.env.SERA_MANIFEST_REPO ?? 'seraphicidal/sera-toolkit';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const PIN_FROM = args.find((a) => a.startsWith('--pin-from='))?.slice('--pin-from='.length);

const EXE = process.platform === 'win32' ? '.exe' : '';
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

function log(...parts) {
  console.log('[tools]', ...parts);
}

/** A refusal worth reporting as one line, not a stack trace. */
class ToolsError extends Error {}

/**
 * Stops the fetch. Thrown rather than `process.exit`, which on Windows can abort inside
 * libuv while a request is still being torn down, losing the message.
 */
function fail(message) {
  throw new ToolsError(message);
}

async function fetchBuffer(url, label) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'sera-toolkit/1.0 (+tools fetch)' },
    redirect: 'follow',
  });
  if (!response.ok) fail(`${label}: HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total && Date.now() - lastReport > 1000) {
      lastReport = Date.now();
      process.stdout.write(
        `\r[tools] ${label}: ${((received / total) * 100).toFixed(0)}% ` +
          `(${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)   `,
      );
    }
  }
  if (total) process.stdout.write('\r' + ' '.repeat(72) + '\r');
  return Buffer.concat(chunks);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Parses `<hash>  <filename>` lines, as produced by sha256sum. */
function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match) map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

function releaseUrl(repo, tag, asset) {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

/** The archive extractor to use: Windows' bundled bsdtar, or `tar` elsewhere. */
function bsdtar() {
  if (process.platform !== 'win32') return 'tar';
  const system32 = join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(system32)) return system32;
  fail(
    'bsdtar not found at System32\\tar.exe — install Windows 10 1803+ or extract FFmpeg manually',
  );
  return 'tar';
}

function runSync(command, commandArgs, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', shell: false });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited ${code}`)),
    );
  });
}

/** Recursively finds the first file named `name` (with the platform suffix) under `dir`. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}

function installBinary(sourcePath, targetName) {
  const target = join(TOOLS_DIR, targetName);
  const staging = `${target}.download`;
  renameSync(sourcePath, staging);
  if (process.platform !== 'win32') chmodSync(staging, 0o755);
  if (existsSync(target)) {
    // Moved aside rather than deleted: Windows will not delete an executable that is
    // running, but it will rename one, so a node mid-download keeps its copy and the next
    // spawn gets the new one. The previous leftover goes first, if nothing still holds it.
    const previous = `${target}.old`;
    rmSync(previous, { force: true, maxRetries: 2 });
    if (existsSync(previous)) rmSync(target, { force: true });
    else renameSync(target, previous);
  }
  renameSync(staging, target);
  return target;
}

/** The yt-dlp version pinned on a branch on GitHub, for `--pin-from`. */
async function pinnedOn(branch) {
  const url = `https://raw.githubusercontent.com/${MANIFEST_REPO}/${encodeURIComponent(branch)}/scripts/tools.manifest.json`;
  const manifest = JSON.parse((await fetchBuffer(url, `manifest on ${branch}`)).toString('utf8'));
  const version = manifest?.ytdlp?.version;
  // The version becomes part of a download URL; accept only the shape yt-dlp tags have.
  if (typeof version !== 'string' || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(version)) {
    fail(`manifest on ${branch} does not pin a yt-dlp version`);
  }
  return version;
}

async function fetchYtdlp() {
  const spec = { ...MANIFEST.ytdlp };
  if (PIN_FROM) {
    spec.version = await pinnedOn(PIN_FROM);
    log(`yt-dlp pinned on ${PIN_FROM}: ${spec.version}`);
  }
  const asset = spec.assets[PLATFORM_KEY];
  if (!asset) fail(`no yt-dlp asset for ${PLATFORM_KEY}`);

  const target = join(TOOLS_DIR, `yt-dlp${EXE}`);
  const versionFile = join(TOOLS_DIR, 'yt-dlp.version');
  const installed = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined;
  if (existsSync(target) && !FORCE && installed === spec.version) {
    log(`yt-dlp ${installed} already present — skipping`);
    return;
  }

  log(`fetching yt-dlp ${spec.version} (${asset})`);
  const [binary, sums] = await Promise.all([
    fetchBuffer(releaseUrl(spec.repo, spec.version, asset), 'yt-dlp'),
    fetchBuffer(releaseUrl(spec.repo, spec.version, spec.checksumAsset), 'yt-dlp checksums'),
  ]);

  const expected = parseChecksums(sums.toString('utf8')).get(asset);
  if (!expected) fail(`no checksum published for ${asset}`);
  const actual = sha256(binary);
  if (actual !== expected)
    fail(`checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`);
  log(`yt-dlp checksum verified (${actual.slice(0, 16)}…)`);

  const staging = join(TOOLS_DIR, `yt-dlp${EXE}.download`);
  writeFileSync(staging, binary);
  installBinary(staging, `yt-dlp${EXE}`);
  writeFileSync(
    versionFile,
    `${spec.version}
`,
  );
  log(`installed .tools/yt-dlp${EXE} ${spec.version}${installed ? ` (was ${installed})` : ''}`);
}

async function fetchFfmpeg() {
  const spec = MANIFEST.ffmpeg;
  const asset = spec.assets[PLATFORM_KEY];
  if (!asset) {
    log(`no pinned FFmpeg build for ${PLATFORM_KEY} — install ffmpeg and ffprobe yourself`);
    return;
  }

  const ffmpegTarget = join(TOOLS_DIR, `ffmpeg${EXE}`);
  const ffprobeTarget = join(TOOLS_DIR, `ffprobe${EXE}`);
  if (existsSync(ffmpegTarget) && existsSync(ffprobeTarget) && !FORCE) {
    log('ffmpeg and ffprobe already present — skipping');
    return;
  }

  log(`fetching FFmpeg ${spec.version} (${asset})`);
  const [archive, sums] = await Promise.all([
    fetchBuffer(releaseUrl(spec.repo, spec.release, asset), 'ffmpeg'),
    fetchBuffer(releaseUrl(spec.repo, spec.release, spec.checksumAsset), 'ffmpeg checksums'),
  ]);

  const expected = parseChecksums(sums.toString('utf8')).get(asset);
  if (!expected) fail(`no checksum published for ${asset}`);
  const actual = sha256(archive);
  if (actual !== expected)
    fail(`checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`);
  log(`ffmpeg checksum verified (${actual.slice(0, 16)}…)`);

  const staging = mkdtempSync(join(tmpdir(), 'sera-ffmpeg-'));
  try {
    const archivePath = join(staging, asset);
    writeFileSync(archivePath, archive);
    log('extracting…');
    // bsdtar ships with Windows 10+ and every mainstream Linux image, and reads both
    // .zip and .tar.xz, so one command covers every platform in the manifest. On
    // Windows it must be addressed by full path: a Git-for-Windows install puts GNU
    // tar first on PATH, and GNU tar cannot read a zip. The archive is passed as a
    // bare filename because GNU tar reads `C:\...` as a remote host specification.
    await runSync(bsdtar(), ['-xf', asset], staging);
    void archivePath;

    for (const [name, target] of [
      [`ffmpeg${EXE}`, ffmpegTarget],
      [`ffprobe${EXE}`, ffprobeTarget],
    ]) {
      const found = findFile(staging, name);
      if (!found) fail(`${name} not found inside ${asset}`);
      installBinary(found, name);
      log(`installed .tools/${name}`);
      void target;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(
    join(TOOLS_DIR, '.gitignore'),
    '# Downloaded tool binaries; recreate with `npm run tools:fetch`.\n*\n',
  );

  if (!ONLY || ONLY === 'ytdlp') await fetchYtdlp();
  if (!ONLY || ONLY === 'ffmpeg') await fetchFfmpeg();

  log('done. The API auto-detects .tools/ — no configuration needed.');
}

main().catch((error) => {
  console.error(`[tools] ${error instanceof ToolsError ? error.message : (error?.stack ?? error)}`);
  process.exitCode = 1;
});
