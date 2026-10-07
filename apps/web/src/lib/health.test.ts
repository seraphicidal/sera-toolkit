import { describe, expect, it } from 'vitest';
import type { HealthReport } from '@sera/contracts/types';
import {
  describeHealth,
  initialHealth,
  isHealthReport,
  nextHealth,
  showsLight,
  summarizeHealth,
  type HealthObservation,
  type HealthState,
} from './health';

function report(status: HealthReport['status'], failing: readonly string[] = []): HealthReport {
  return {
    status,
    version: '1.0.0',
    uptimeSeconds: 60,
    checks: ['yt-dlp', 'ffmpeg', 'storage', 'queue', 'extraction-nodes'].map((name) => ({
      name,
      status: failing.includes(name) ? 'error' : 'ok',
      detail: `${name} detail`,
    })),
  };
}

const up = (r: HealthReport): HealthObservation => ({ ok: true, report: r });
const down: HealthObservation = { ok: false };

function run(...observations: HealthObservation[]): HealthState {
  return observations.reduce(nextHealth, initialHealth);
}

describe('nextHealth', () => {
  it('maps the report to green, amber and red', () => {
    expect(run(up(report('ok'))).light).toBe('green');
    expect(run(up(report('degraded', ['extraction-nodes']))).light).toBe('amber');
    expect(run(up(report('error', ['yt-dlp', 'ffmpeg']))).light).toBe('red');
  });

  it('stays unknown, not red, when the very first request fails', () => {
    expect(run(down).light).toBe('unknown');
  });

  it('keeps its last answer through one failed request', () => {
    const state = run(up(report('ok')), down);
    expect(state.light).toBe('green');
    expect(state.report?.status).toBe('ok');
  });

  it('goes red after two failures in a row', () => {
    expect(run(up(report('ok')), down, down).light).toBe('red');
  });

  it('needs the two failures to be consecutive', () => {
    expect(run(up(report('ok')), down, up(report('ok')), down).light).toBe('green');
  });

  it('recovers on the first report after an outage', () => {
    expect(run(up(report('ok')), down, down, up(report('ok'))).light).toBe('green');
  });
});

describe('showsLight', () => {
  it('draws no dot before the first answer, nor after one failed request', () => {
    expect(showsLight(initialHealth)).toBe(false);
    expect(showsLight(run(down))).toBe(false);
  });

  it('draws it once there is something to say', () => {
    expect(showsLight(run(up(report('ok'))))).toBe(true);
    expect(showsLight(run(up(report('degraded', ['queue']))))).toBe(true);
    expect(showsLight(run(down, down))).toBe(true);
  });
});

describe('isHealthReport', () => {
  it('accepts a report', () => {
    expect(isHealthReport(report('ok'))).toBe(true);
  });

  it("refuses what a proxy sends when the API is down, or anything else that isn't one", () => {
    expect(isHealthReport(undefined)).toBe(false);
    expect(isHealthReport('Internal Server Error')).toBe(false);
    expect(isHealthReport({ error: { code: 'INTERNAL' } })).toBe(false);
    expect(isHealthReport({ status: 'ok' })).toBe(false);
    expect(isHealthReport({ status: 'fine', checks: [] })).toBe(false);
    expect(isHealthReport({ status: 'ok', checks: [{ name: 'x', status: 'maybe' }] })).toBe(false);
  });
});

describe('describeHealth', () => {
  it('names each check for a visitor, without the operator detail', () => {
    const lines = describeHealth(run(up(report('degraded', ['extraction-nodes']))));
    expect(lines.map((line) => line.label)).toEqual([
      'Server',
      'Media extractor',
      'Converter',
      'Storage',
      'Download queue',
      'YouTube',
    ]);
    expect(lines.find((line) => line.label === 'YouTube')).toMatchObject({ ok: false });
    expect(JSON.stringify(lines)).not.toContain('detail');
  });

  it('shows only the server line while it is down', () => {
    const lines = describeHealth(run(up(report('ok')), down, down));
    expect(lines).toEqual([{ label: 'Server', ok: false, note: 'Not answering' }]);
  });

  it('still lists everything through a single failure', () => {
    const lines = describeHealth(run(up(report('ok')), down));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({ label: 'Server', ok: true });
  });

  it('keeps a check it does not know, by its own name', () => {
    const unusual: HealthReport = {
      ...report('ok'),
      checks: [{ name: 'something-new', status: 'ok' }],
    };
    expect(describeHealth(run(up(unusual)))[1]).toEqual({
      label: 'something-new',
      ok: true,
      note: 'OK',
    });
  });
});

describe('summarizeHealth', () => {
  it('gives the light an accessible name for every state', () => {
    expect(summarizeHealth(initialHealth)).toBe('Service status: checking');
    expect(summarizeHealth(run(up(report('ok'))))).toBe('Service status: everything is working');
    expect(summarizeHealth(run(up(report('degraded', ['queue']))))).toBe(
      'Service status: partly working',
    );
    expect(summarizeHealth(run(down, down))).toBe('Service status: not reachable');
  });
});
