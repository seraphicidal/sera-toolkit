#!/usr/bin/env node

import { readFile, rm } from 'node:fs/promises';
import { classifyFailure } from '../packages/engine/dist/extract/failure.js';
import { loadConfig, SeraEngine, SeraError } from '../packages/engine/dist/index.js';

const CASES = JSON.parse(await readFile(new URL('./provider-cases.json', import.meta.url), 'utf8'));

const CLIENT_KEY = 'check-providers';

const args = process.argv.slice(2);
const wantDownloads = args.includes('--download');
const only = args.filter((arg) => !arg.startsWith('--'));
const cases = only.length ? CASES.filter((entry) => only.includes(entry.id)) : CASES;

const dataDir = '.data/matrix';
await rm(dataDir, { recursive: true, force: true });

const engine = await SeraEngine.create({
  config: loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    SERA_SECRET: 'provider-matrix',
    SERA_DATA_DIR: dataDir,
    ...envPassthrough(),
  }),
});
if (wantDownloads) engine.startWorker();

function envPassthrough() {
  const keys = [
    'SERA_REDDIT_CLIENT_ID',
    'SERA_REDDIT_CLIENT_SECRET',
    'SERA_INSTAGRAM_SESSION_ID',
    'SERA_YOUTUBE_PLAYER_CLIENTS',
    'SERA_YOUTUBE_POT_PROVIDER_URL',
    'SERA_NETWORK_CLASS',
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key]).map((k) => [k, process.env[k]]));
}

let passed = 0;
let failed = 0;

function report(id, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(18)} ${detail}`);
}

function sniff(bytes) {
  const ascii = (offset, text) =>
    bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (ascii(1, 'PNG')) return 'png';
  if (ascii(0, 'GIF8')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(4, 'ftyp')) return 'mp4';
  if (ascii(0, 'ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  if (bytes[0] === 0x1a && bytes[1] === 0x45) return 'webm';
  if (ascii(0, 'PK')) return 'zip';
  return `?${bytes.subarray(0, 4).toString('latin1')}`;
}

function pickOption(info, want) {
  const options = info.items.flatMap((item) => item.options);
  if (typeof want === 'number') return options[want];
  return options.find(
    (option) =>
      option.kind === want.kind && (!want.container || option.container === want.container),
  );
}

async function runJob(info, want) {
  const option = pickOption(info, want);
  if (!option) return { ok: false, detail: `no option matching ${JSON.stringify(want)}` };
  const job = await engine.jobs.create({ infoId: info.id, optionIds: [option.id] }, CLIENT_KEY);

  const deadline = Date.now() + 5 * 60_000;
  let state = job;
  while (Date.now() < deadline) {
    state = (await engine.jobs.get(job.id)) ?? state;
    if (state.state === 'ready' || state.state === 'failed' || state.state === 'cancelled') break;
    await new Promise((done) => setTimeout(done, 400));
  }
  if (state.state !== 'ready') {
    return { ok: false, detail: `job ${state.state}: ${state.error?.message ?? ''}` };
  }

  const bytes = await readFile(`${dataDir}/${job.id}/out/${state.result.filename}`);
  const magic = sniff(bytes);
  return {
    ok: bytes.length > 0 && !magic.startsWith('?'),
    detail: `${option.kind}/${option.label} → ${bytes.length} bytes ${magic}`,
  };
}

console.log(
  `\n  ${cases.length} case(s)${wantDownloads ? ', with downloads' : ', metadata only'}\n`,
);

for (const entry of cases) {
  const started = Date.now();
  try {
    const info = await engine.resolver.resolve(entry.url);
    const kinds = [...new Set(info.items.map((item) => item.kind))];
    const elapsed = `${Date.now() - started}ms`;

    if (entry.expect.failure) {
      report(entry.id, false, `expected ${entry.expect.failure}, got ${info.items.length} item(s)`);
      continue;
    }

    const problems = [];
    if (entry.expect.minItems && info.items.length < entry.expect.minItems) {
      problems.push(`wanted ${entry.expect.minItems}+ items, got ${info.items.length}`);
    }
    for (const kind of entry.expect.kinds ?? []) {
      if (!kinds.includes(kind)) problems.push(`no ${kind} among ${kinds.join('+') || 'nothing'}`);
    }

    if (problems.length) {
      report(entry.id, false, problems.join('; '));
      continue;
    }

    const strategy = info.metadata?.extractionStrategy ?? info.metadata?.source;
    let detail =
      `${info.items.length} item(s) ${kinds.join('+')} · ${elapsed}` +
      (strategy ? ` · via ${strategy}` : '') +
      (info.metadata?.degraded ? ` · degraded:${info.metadata.degraded}` : '');

    const wanted = entry.download === undefined ? [] : [entry.download].flat();
    if (wantDownloads && wanted.length) {
      const outcomes = [];
      for (const want of wanted) outcomes.push(await runJob(info, want));
      detail += ` · ${outcomes.map((outcome) => outcome.detail).join(' · ')}`;
      report(
        entry.id,
        outcomes.every((outcome) => outcome.ok),
        detail,
      );
      continue;
    }
    report(entry.id, true, detail);
  } catch (error) {
    const sera = SeraError.from(error);
    const failure = classifyFailure(sera);
    const expected = entry.expect.failure ?? entry.expect.orFailure;
    const ok = failure === expected;
    report(entry.id, ok, `${failure} / ${sera.code}`);
    if (!ok) {
      console.log(`          url        ${entry.url}`);
      console.log(`          expected   ${expected ?? 'media'}`);
      console.log(`          detail     ${(sera.detail ?? sera.message).slice(0, 160)}`);
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
await engine.close?.();
process.exit(failed ? 1 : 0);
