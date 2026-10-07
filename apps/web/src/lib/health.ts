import type { HealthReport } from '@sera/contracts/types';

export type HealthLight = 'unknown' | 'green' | 'amber' | 'red';

export interface HealthState {
  readonly light: HealthLight;
  readonly report?: HealthReport;
  readonly failures: number;
}

export type HealthObservation =
  { readonly ok: true; readonly report: HealthReport } | { readonly ok: false };

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
  readonly note: string;
}

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

export function showsLight(state: HealthState): boolean {
  return state.light !== 'unknown';
}

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
