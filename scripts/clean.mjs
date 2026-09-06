#!/usr/bin/env node
/**
 * Removes build output and local runtime state.
 *
 * `.tools` is left alone by default: re-downloading FFmpeg is 160 MB, and "clean" should
 * not mean "wait five minutes". Pass --all to remove it too.
 */

import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

const targets = [
  'packages/contracts/dist',
  'packages/engine/dist',
  'apps/api/dist',
  'apps/worker/dist',
  'apps/web/.next',
  'apps/api/.data',
  'coverage',
  '.data',
  ...(all ? ['.tools', 'node_modules'] : []),
];

for (const target of targets) {
  rmSync(join(ROOT, target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}

console.log(all ? '\nClean. Run `npm install && npm run tools:fetch`.' : '\nClean.');
