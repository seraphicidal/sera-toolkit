#!/usr/bin/env node
/**
 * Downloads the pinned yt-dlp and FFmpeg builds into `.tools/`.
 *
 * The engine prefers a binary here over one on PATH, so a deployment gets the exact
 * version the manifest names rather than whatever the host happens to have. Every
 * download is checked against the publisher's own checksum file before it is written
 * into place; a mismatch aborts rather than warns.
 *
 * Usage:
 *   node scripts/fetch-tools.mjs            # fetch anything missing
 *   node scripts/fetch-tools.mjs --force    # re-fetch even if present
 *   node scripts/fetch-tools.mjs --only=ytdlp
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, '.tools');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tools.manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const EXE = process.platform === 'win32' ? '.exe' : '';
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

function log(...parts) {
  console.log('[tools]', ...parts);
}

function fail(message) {
  console.error(`[tools] ${message}`);
  process.exit(1);
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
  if (existsSync(target)) rmSync(target, { force: true });
  renameSync(staging, target);
  return target;
}

async function fetchYtdlp() {
  const spec = MANIFEST.ytdlp;
  const asset = spec.assets[PLATFORM_KEY];
  if (!asset) fail(`no yt-dlp asset for ${PLATFORM_KEY}`);

  const target = join(TOOLS_DIR, `yt-dlp${EXE}`);
  if (existsSync(target) && !FORCE) {
    log(`yt-dlp already present (${(statSync(target).size / 1048576).toFixed(1)} MB) — skipping`);
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
  log(`installed .tools/yt-dlp${EXE}`);
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

main().catch((error) => fail(error?.stack ?? String(error)));
