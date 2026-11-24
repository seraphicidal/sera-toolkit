import { describe, expect, it } from 'vitest';
import type { Job } from '@sera/contracts/types';
import { mergeJobUpdate } from './use-job';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job1',
    state: 'downloading',
    step: 'Downloading',
    progress: {
      percent: 50,
      bytesDownloaded: 5_000,
      bytesTotal: 10_000,
      speedBytesPerSecond: 1_000,
      etaSeconds: 5,
    },
    provider: 'youtube',
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:05.000Z',
    ...overrides,
  };
}

describe('mergeJobUpdate', () => {
  it('keeps fresh speed/bytes/eta while clamping percent dips within the same state', () => {
    const prev = makeJob({
      progress: {
        percent: 85,
        bytesDownloaded: 42_000,
        bytesTotal: 42_000,
        speedBytesPerSecond: 8_000,
        etaSeconds: 0,
      },
    });
    const next = makeJob({
      progress: {
        percent: 12,
        bytesDownloaded: 1_200,
        bytesTotal: 10_000,
        speedBytesPerSecond: 2_500,
        etaSeconds: 4,
      },
    });
    const merged = mergeJobUpdate(prev, next);
    expect(merged.progress.percent).toBe(85);
    expect(merged.progress.bytesDownloaded).toBe(1_200);
    expect(merged.progress.speedBytesPerSecond).toBe(2_500);
    expect(merged.progress.etaSeconds).toBe(4);
  });

  it('does not clamp across state transitions or file index changes', () => {
    const prev = makeJob({
      state: 'downloading',
      progress: { percent: 85, currentFile: 1, totalFiles: 2 },
    });
    const converting = makeJob({
      state: 'converting',
      progress: { percent: 10 },
    });
    expect(mergeJobUpdate(prev, converting).progress.percent).toBe(10);

    const nextFile = makeJob({
      state: 'downloading',
      progress: { percent: 5, currentFile: 2, totalFiles: 2 },
    });
    expect(mergeJobUpdate(prev, nextFile).progress.percent).toBe(5);
  });

  it('always accepts terminal job transitions', () => {
    const prev = makeJob({ progress: { percent: 85 } });
    const failed = makeJob({ state: 'failed', progress: { percent: 0 } });
    expect(mergeJobUpdate(prev, failed)).toEqual(failed);
  });
});
