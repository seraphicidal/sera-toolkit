import { formatBytes, type SourceUsage, type UsageDay } from '@sera/engine';

/**
 * The usage counts as a table for a terminal: one row per source over the whole period,
 * then one row per day. `sudo sera stats` prints this.
 *
 *   Source          Resolves  failed  Downloads  failed  Delivered  Failures
 *   youtube              120       4         80       2     1.2 GB  SOURCE_BLOCKED 3, …
 */
export function formatUsage(
  days: readonly UsageDay[],
  totals: Record<string, SourceUsage>,
): string {
  if (!days.length) return 'No usage counted.\n';
  const newest = days[0]!.date;
  const oldest = days.at(-1)!.date;
  const lines = [`SERA usage, ${oldest} to ${newest} (UTC)`, ''];

  const header = ['Source', 'Resolves', 'failed', 'Downloads', 'failed', 'Delivered', 'Failures'];
  const sources = Object.entries(totals).sort(
    ([a, x], [b, y]) => weight(y) - weight(x) || a.localeCompare(b),
  );
  if (!sources.length) {
    lines.push('Nothing counted in this period.');
    return `${lines.join('\n')}\n`;
  }
  const rows = sources.map(([source, usage]) => [source, ...columns(usage), failures(usage)]);
  rows.push(['all', ...columns(sum(sources.map(([, usage]) => usage))), '']);
  lines.push(...table(header, rows));

  lines.push('');
  const dayRows = days.map((day) => [
    day.date,
    ...columns(sum(Object.values(day.sources))),
    failures(sum(Object.values(day.sources))),
  ]);
  lines.push(...table(['Day', ...header.slice(1)], dayRows));
  return `${lines.join('\n')}\n`;
}

const failedCount = (failed: Readonly<Record<string, number>>): number =>
  Object.values(failed).reduce((total, count) => total + count, 0);

const weight = (usage: SourceUsage): number =>
  usage.resolves.ok + failedCount(usage.resolves.failed);

function columns(usage: SourceUsage): string[] {
  return [
    String(usage.resolves.ok + failedCount(usage.resolves.failed)),
    String(failedCount(usage.resolves.failed)),
    String(usage.downloads.ok + failedCount(usage.downloads.failed)),
    String(failedCount(usage.downloads.failed)),
    usage.bytes ? formatBytes(usage.bytes) : '0',
  ];
}

/** Every failure code, resolves and downloads together, most frequent first. */
function failures(usage: SourceUsage): string {
  const codes: Record<string, number> = {};
  for (const failed of [usage.resolves.failed, usage.downloads.failed]) {
    for (const [code, count] of Object.entries(failed)) codes[code] = (codes[code] ?? 0) + count;
  }
  return Object.entries(codes)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([code, count]) => `${code} ${String(count)}`)
    .join(', ');
}

function sum(all: readonly SourceUsage[]): SourceUsage {
  const add = (target: Record<string, number>, source: Readonly<Record<string, number>>) => {
    for (const [code, count] of Object.entries(source)) target[code] = (target[code] ?? 0) + count;
  };
  const resolves = { ok: 0, failed: {} as Record<string, number> };
  const downloads = { ok: 0, failed: {} as Record<string, number> };
  let bytes = 0;
  for (const usage of all) {
    resolves.ok += usage.resolves.ok;
    downloads.ok += usage.downloads.ok;
    add(resolves.failed, usage.resolves.failed);
    add(downloads.failed, usage.downloads.failed);
    bytes += usage.bytes;
  }
  return { resolves, downloads, bytes };
}

/** Left-aligns the first and last columns, right-aligns the numbers between. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const last = header.length - 1;
  const line = (row: readonly string[]) =>
    row
      .map((cell, column) =>
        column === 0 || column === last
          ? cell.padEnd(column === last ? 0 : widths[column]!)
          : cell.padStart(widths[column]!),
      )
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
