#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'scripts', 'tools.manifest.json');
const DOCKERFILE_PATH = join(ROOT, 'docker', 'api.Dockerfile');

const write = process.argv.includes('--write');

async function latestRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      'user-agent': 'sera-toolkit/update-providers',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repo}`);
  const release = await response.json();
  return release.tag_name;
}

function readDockerfileVersion() {
  const text = readFileSync(DOCKERFILE_PATH, 'utf8');
  return /^ARG YTDLP_VERSION=(.+)$/m.exec(text)?.[1]?.trim();
}

function pin(version) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.ytdlp.version = version;
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
  writeFileSync(
    DOCKERFILE_PATH,
    dockerfile.replace(/^ARG YTDLP_VERSION=.+$/m, `ARG YTDLP_VERSION=${version}`),
  );
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const pinned = manifest.ytdlp.version;
  const inDockerfile = readDockerfileVersion();

  console.log(`yt-dlp pinned in manifest:   ${pinned}`);
  console.log(`yt-dlp pinned in Dockerfile: ${inDockerfile ?? '(not found)'}`);

  if (inDockerfile && inDockerfile !== pinned) {
    console.log('\n! The two pins disagree. Run with --write to bring them back in step.');
  }

  const latest = await latestRelease(manifest.ytdlp.repo);
  console.log(`latest release:              ${latest}`);

  if (latest === pinned && inDockerfile === pinned) {
    console.log('\nUp to date.');
    return;
  }

  if (!write) {
    console.log('\nA newer release is available. To pin it:');
    console.log('  npm run update-providers -- --write');
    console.log('  npm run tools:fetch -- --force');
    console.log('  npm test');
    console.log('\nThen check a few real links before deploying:');
    console.log('  node scripts/smoke-live.mjs <url> [<url> ...]');
    return;
  }

  pin(latest);
  console.log(`\nPinned ${latest} in scripts/tools.manifest.json and docker/api.Dockerfile.`);
  console.log('Next:');
  console.log('  npm run tools:fetch -- --force');
  console.log('  npm test && node scripts/smoke-live.mjs');
}

main().catch((error) => {
  console.error(`[update-providers] ${error?.message ?? error}`);
  process.exit(1);
});
