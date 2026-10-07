import type { SourceUsage, UsageDay } from '@sera/engine';
import { formatUsage } from './stats.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) =>
    args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

  const token = process.env.SERA_ADMIN_TOKEN ?? '';
  if (!token) {
    console.error('[stats] SERA_ADMIN_TOKEN is not set; see deploy/ORACLE.md');
    process.exitCode = 2;
    return;
  }

  const api = value('--api') ?? `http://127.0.0.1:${process.env.SERA_PORT ?? '4000'}`;
  const days = value('--days') ?? '7';
  const response = await fetch(`${api}/api/admin/usage?days=${encodeURIComponent(days)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.error(`[stats] the API answered ${String(response.status)}`);
    process.exitCode = 1;
    return;
  }
  const body = (await response.json()) as {
    days: UsageDay[];
    totals: Record<string, SourceUsage>;
  };
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify(body, null, 2)}\n`
      : formatUsage(body.days, body.totals),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
