#!/usr/bin/env node
/**
 * Every provider, against the real sites, from whatever network this runs on.
 *
 * The offline suite proves the code does what it was written to do. This answers the
 * question it cannot: do these platforms still answer the way the providers expect, from
 * here, today. The two failures worth telling apart are "SERA is broken" and "this
 * address is refused", and the failure class in each row is which.
 *
 *   npm run check:providers                    # metadata for every case
 *   npm run check:providers -- --download      # …and run the declared jobs through to bytes
 *   npm run check:providers -- youtube vimeo   # only these cases
 *
 * A case that expects a refusal counts a refusal as a pass. Instagram carousels need a
 * session and Reddit needs an app registration; on an installation with neither, saying
 * so accurately *is* the correct behaviour, and pretending otherwise is what this file
 * exists to prevent.
 *
 * A failure prints what a report needs and a stack trace does not: which provider, which
 * link, which strategy answered, the failure class, and what the ladder tried on the way
 * there.
 */

import { readFile, rm } from 'node:fs/promises';
import { classifyFailure } from '../packages/engine/dist/extract/failure.js';
import { loadConfig, SeraEngine, SeraError } from '../packages/engine/dist/index.js';

/**
 * The links under test, in provider-cases.json, which the server's daily canary shares: the
 * cases with a `canary` field are the ones it downloads from (deploy/ORACLE.md, "The canary").
 *
 * `expect` is either the media that should come back or the failure class that should.
 * Every URL here is public and was serving at the time it was added; a case that starts
 * reporting DELETED_CONTENT needs a new link, not a code change.
 */
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

/** Credentials the operator has configured are used if present, and never required. */
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

/** Magic bytes, because an extension is a claim and the bytes are the fact. */
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

/** The first option of a kind, so a case can ask for "the audio" without an index. */
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
  // A client key, as the API passes one for every visitor: it is what per-client limits count
  // against. One key for the whole run, so the matrix is limited like a single visitor.
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
      // What a report needs, which a stack trace does not have: which link, which
      // ladder, and what the next thing to do about it would be.
      console.log(`          url        ${entry.url}`);
      console.log(`          expected   ${expected ?? 'media'}`);
      console.log(`          detail     ${(sera.detail ?? sera.message).slice(0, 160)}`);
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
await engine.close?.();
process.exit(failed ? 1 : 0);
