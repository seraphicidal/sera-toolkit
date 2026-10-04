import type { HealthReport } from '@sera/contracts/types';

/**
 * The status light in the header, as a small state machine.
 *
 * It is fed one observation per poll — a report, or the fact that none came back — and
 * decides what the light says. The rule that matters is the second one: a single failed
 * request is a phone changing networks or a deploy restarting the API, not an outage, so
 * the light only goes red after two failures in a row. Until then it keeps saying what it
 * said before.
 */

export type HealthLight = 'unknown' | 'green' | 'amber' | 'red';

export interface HealthState {
  readonly light: HealthLight;
  /** The last report that arrived, kept through a single failure. */
  readonly report?: HealthReport;
  /** Requests in a row that got no report. */
  readonly failures: number;
}

export type HealthObservation =
  { readonly ok: true; readonly report: HealthReport } | { readonly ok: false };

/** Failures in a row before the light says the service is down. */
export const FAILURES_BEFORE_DOWN = 2;

export const initialHealth: HealthState = { light: 'unknown', failures: 0 };

export function nextHealth(state: HealthState, observation: HealthObservation): HealthState {
  if (observation.ok) {
    return { light: lightFor(observation.report), report: observation.report, failures: 0 };
  }
  const failures = state.failures + 1;
  if (failures < FAILURES_BEFORE_DOWN) return { ...state, failures };
  return { light: 'red', failures };
}

function lightFor(report: HealthReport): HealthLight {
  if (report.status === 'ok') return 'green';
  if (report.status === 'degraded') return 'amber';
  return 'red';
}

/** Whether a response body is a health report, rather than a proxy's error page. */
export function isHealthReport(body: unknown): body is HealthReport {
  if (!body || typeof body !== 'object') return false;
  const { status, checks } = body as { status?: unknown; checks?: unknown };
  if (status !== 'ok' && status !== 'degraded' && status !== 'error') return false;
  if (!Array.isArray(checks)) return false;
  return (checks as unknown[]).every((check) => {
    if (!check || typeof check !== 'object') return false;
    const { name, status: checkStatus } = check as { name?: unknown; status?: unknown };
    return typeof name === 'string' && (checkStatus === 'ok' || checkStatus === 'error');
  });
}

export interface HealthLine {
  readonly label: string;
  readonly ok: boolean;
  /** What it means for someone using the site, rather than the check's own detail. */
  readonly note: string;
}

/**
 * The report in words a visitor can use.
 *
 * The checks are named for operators (`yt-dlp`, `queue`); the popover names what each one
 * is for. The checks' own details — node names, storage use — are left out: they are
 * there for whoever runs the server.
 */
const CHECKS: Record<string, { label: string; ok: string; error: string }> = {
  'yt-dlp': {
    label: 'Media extractor',
    ok: 'Reading links normally',
    error: 'Most sources will fail',
  },
  ffmpeg: { label: 'Converter', ok: 'Converting normally', error: 'Conversions will fail' },
  storage: { label: 'Storage', ok: 'Available', error: 'Downloads cannot be saved' },
  queue: { label: 'Download queue', ok: 'Accepting downloads', error: 'Downloads cannot start' },
  'extraction-nodes': {
    label: 'YouTube',
    ok: 'Available through a home connection',
    error: 'Unavailable right now',
  },
};

export function describeHealth(state: HealthState): HealthLine[] {
  const lines: HealthLine[] = [
    {
      label: 'Server',
      ok: state.failures < FAILURES_BEFORE_DOWN,
      note:
        state.failures >= FAILURES_BEFORE_DOWN
          ? 'Not answering'
          : state.report
            ? 'Answering'
            : 'Checking…',
    },
  ];
  // A report from before the server stopped answering would describe a server that is
  // no longer there, so only the server line is shown while it is down.
  if (!state.report || state.failures >= FAILURES_BEFORE_DOWN) return lines;

  for (const check of state.report.checks) {
    const known = CHECKS[check.name];
    const ok = check.status === 'ok';
    lines.push({
      label: known?.label ?? check.name,
      ok,
      note: known ? (ok ? known.ok : known.error) : ok ? 'OK' : 'Not working',
    });
  }
  return lines;
}

/** The light's accessible name, which is also its tooltip. */
export function summarizeHealth(state: HealthState): string {
  switch (state.light) {
    case 'green':
      return 'Service status: everything is working';
    case 'amber':
      return 'Service status: partly working';
    case 'red':
      return state.failures >= FAILURES_BEFORE_DOWN
        ? 'Service status: not reachable'
        : 'Service status: not working';
    case 'unknown':
      return 'Service status: checking';
  }
}
