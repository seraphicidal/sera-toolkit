#!/usr/bin/env node

import { loadConfig, MediaResolver, SeraError } from '../packages/engine/dist/index.js';

const DEFAULT_URLS = ['https://www.youtube.com/watch?v=aqz-KE-bpKQ'];

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;

const config = loadConfig({
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  SERA_SECRET: 'smoke-check',
  SERA_DATA_DIR: '.data/smoke',
});

const resolver = new MediaResolver({ config });

let failures = 0;

for (const url of urls) {
  const started = Date.now();
  try {
    const info = await resolver.resolve(url);
    const elapsed = Date.now() - started;

    console.log(`\n✓ ${url}`);
    console.log(`  provider  ${info.provider} (${info.providerLabel})  ·  ${elapsed} ms`);
    console.log(`  title     ${info.title}`);
    console.log(`  author    ${info.author ?? '(none)'}`);
    console.log(`  type      ${info.type}, ${info.items.length} item(s)`);

    for (const item of info.items.slice(0, 3)) {
      console.log(
        `  item ${item.index}  ${item.kind}${item.duration ? ` · ${Math.round(item.duration)}s` : ''}`,
      );
      for (const option of item.options) {
        console.log(
          `      ${option.recommended ? '*' : ' '} ${option.kind.padEnd(5)} ${option.container.padEnd(5)} ${option.label.padEnd(14)} ${option.detail ?? ''}`,
        );
      }
    }
    if (info.items.length > 3) console.log(`  … and ${info.items.length - 3} more items`);
  } catch (error) {
    failures += 1;
    if (error instanceof SeraError) {
      console.log(`\n✗ ${url}`);
      console.log(`  ${error.code}: ${error.message}`);
      if (error.detail) console.log(`  detail: ${error.detail.slice(0, 400)}`);
    } else {
      console.log(`\n✗ ${url}`);
      console.log(`  ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
}

console.log(`\n${urls.length - failures}/${urls.length} resolved`);
process.exit(failures ? 1 : 0);
