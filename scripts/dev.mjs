#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const withWorker = process.argv.includes('--worker');

const children = [];
let shuttingDown = false;

function start(label, command, args, colour) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const prefix = `\u001b[${colour}m${label.padEnd(7)}\u001b[0m │ `;
  const relay = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);

  child.on('close', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('tsc', NPX, ['tsc', '--build', '--watch', '--preserveWatchOutput'], '36');

setTimeout(() => {
  if (shuttingDown) return;
  start('api', 'node', ['--enable-source-maps', '--watch', 'apps/api/dist/index.js'], '32');
  if (withWorker) {
    start('worker', 'node', ['--enable-source-maps', '--watch', 'apps/worker/dist/index.js'], '33');
  }
}, 2500);

start('web', NPM, ['run', 'dev', '--workspace', '@sera/web'], '35');

console.log('SERA.toolkit dev — API on :4000, web on :3200. Ctrl-C to stop.\n');
