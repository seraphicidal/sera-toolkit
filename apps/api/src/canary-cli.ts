import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canaryCases, runCanary } from './canary.js';

/**
 * Runs the canary and prints its results as JSON on stdout.
 *
 * Meant to run inside the API container, where it can reach the API on loopback:
 *
 *   docker exec sera-api-1 node apps/api/dist/canary-cli.js [--only=youtube-shorts,vimeo]
 *
 * deploy/canary.sh does exactly that from the daily timer, and keeps the history. The
 * links come from scripts/provider-cases.json — the cases with a `canary` field.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) =>
    args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

  const token = process.env.SERA_CANARY_TOKEN ?? '';
  if (!token) {
    console.error('[canary] SERA_CANARY_TOKEN is not set; the API would rate-limit the canary');
    process.exitCode = 2;
    return;
  }

  const casesPath = resolve(value('--cases') ?? 'scripts/provider-cases.json');
  const parsed = JSON.parse(await readFile(casesPath, 'utf8')) as unknown[];
  const only = value('--only')?.split(',');
  const cases = canaryCases(parsed).filter((entry) => !only || only.includes(entry.id));

  const results = await runCanary({
    apiUrl: value('--api') ?? `http://127.0.0.1:${process.env.SERA_PORT ?? '4000'}`,
    token,
    cases,
    timeoutMs: Number(value('--timeout') ?? 180) * 1000,
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
