#!/usr/bin/env node

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
const MANIFEST_REPO = process.env.SERA_MANIFEST_REPO ?? 'seraphicidal/sera-toolkit';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const PIN_FROM = args.find((a) => a.startsWith('--pin-from='))?.slice('--pin-from='.length);

const PLATFORM_KEY = process.env.SERA_TOOLS_PLATFORM ?? `${process.platform}-${process.arch}`;
const EXE = PLATFORM_KEY.startsWith('win32-') ? '.exe' : '';
const ZIPAPP = PLATFORM_KEY.startsWith('android-');
const TERMUX_PREFIX = process.env.PREFIX ?? '/data/data/com.termux/files/usr';

function log(...parts) {
  console.log('[tools]', ...parts);
}

class ToolsError extends Error {}

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
  if (!EXE) chmodSync(staging, 0o755);
  if (existsSync(target)) {
    const previous = `${target}.old`;
    rmSync(previous, { force: true, maxRetries: 2 });
    if (existsSync(previous)) rmSync(target, { force: true });
    else renameSync(target, previous);
  }
  renameSync(staging, target);
  return target;
}

async function pinnedOn(branch) {
  const url = `https://raw.githubusercontent.com/${MANIFEST_REPO}/${encodeURIComponent(branch)}/scripts/tools.manifest.json`;
  const manifest = JSON.parse((await fetchBuffer(url, `manifest on ${branch}`)).toString('utf8'));
  const version = manifest?.ytdlp?.version;
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

  if (ZIPAPP) {
    const staging = join(TOOLS_DIR, 'yt-dlp.pyz.download');
    writeFileSync(staging, binary);
    installBinary(staging, 'yt-dlp.pyz');
    const launcher = join(TOOLS_DIR, 'yt-dlp.launcher');
    writeFileSync(
      launcher,
      [
        `#!${TERMUX_PREFIX}/bin/sh`,
        "# Written by scripts/fetch-tools.mjs: the yt-dlp zipapp, run by Termux's Python.",
        `exec "${TERMUX_PREFIX}/bin/python3" "\${0%/*}/yt-dlp.pyz" "$@"`,
        '',
      ].join('\n'),
    );
    installBinary(launcher, 'yt-dlp');
  } else {
    const staging = join(TOOLS_DIR, `yt-dlp${EXE}.download`);
    writeFileSync(staging, binary);
    installBinary(staging, `yt-dlp${EXE}`);
  }
  writeFileSync(versionFile, `${spec.version}\n`);
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
