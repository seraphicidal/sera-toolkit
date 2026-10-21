import { describe, expect, it } from 'vitest';
import {
  cx,
  formatBytes,
  formatDuration,
  formatEta,
  formatSpeed,
  isRunning,
  pluralize,
} from './format';

describe('formatBytes', () => {
  it('stays silent when there is no valid size to show', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('writes whole bytes up to a kilobyte, then one decimal under ten and whole numbers above', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
  });

  it('drops the decimal when rounding crosses ten and steps up a unit when rounding reaches 1024', () => {
    expect(formatBytes(10_235)).toBe('10 KB');
    expect(formatBytes(9.995 * 1024)).toBe('10 KB');
    expect(formatBytes(1_048_500)).toBe('1.0 MB');
    expect(formatBytes(1023.95 * 1024)).toBe('1.0 MB');
  });
});

describe('formatDuration', () => {
  it('formats seconds as m:ss or h:mm:ss and ignores invalid durations', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3661)).toBe('1:01:01');
  });
});

describe('formatEta', () => {
  it('pads short estimates to five characters and hides nonsensical ones', () => {
    expect(formatEta(undefined)).toBe('');
    expect(formatEta(-1)).toBe('');
    expect(formatEta(0.4)).toBe('00:00');
    expect(formatEta(9)).toBe('00:09');
    expect(formatEta(125)).toBe('02:05');
    expect(formatEta(90_000)).toBe('');
  });
});

describe('formatSpeed', () => {
  it('appends per-second to a byte rate and hides zero or missing rates', () => {
    expect(formatSpeed(undefined)).toBe('');
    expect(formatSpeed(0)).toBe('');
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
  });
});

describe('pluralize', () => {
  it('pairs the count with the singular for one and the plural otherwise', () => {
    expect(pluralize(1, 'file')).toBe('1 file');
    expect(pluralize(0, 'file')).toBe('0 files');
    expect(pluralize(3, 'item')).toBe('3 items');
    expect(pluralize(2, 'match', 'matches')).toBe('2 matches');
  });
});

describe('isRunning', () => {
  it('is true while a job is still working and false once it settles', () => {
    expect(isRunning('queued')).toBe(true);
    expect(isRunning('downloading')).toBe(true);
    expect(isRunning('converting')).toBe(true);
    expect(isRunning('ready')).toBe(false);
    expect(isRunning('failed')).toBe(false);
    expect(isRunning('cancelled')).toBe(false);
    expect(isRunning('expired')).toBe(false);
  });
});

describe('cx', () => {
  it('joins truthy class names with single spaces', () => {
    expect(cx('a', false, undefined, null, '', 'b')).toBe('a b');
  });
});
