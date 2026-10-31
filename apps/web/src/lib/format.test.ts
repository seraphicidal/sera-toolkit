import { describe, expect, it } from 'vitest';
import {
  cx,
  formatBytes,
  formatCodecBadge,
  formatDuration,
  formatEta,
  formatSpeed,
  isRunning,
  optionBadges,
  PIPELINE_STEPS,
  pluralize,
  resolvePipelineStepIndex,
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

describe('formatCodecBadge and optionBadges', () => {
  it('normalizes video and audio codec identifiers into readable badges', () => {
    expect(formatCodecBadge('av01.0.08M.08')).toBe('AV1');
    expect(formatCodecBadge('avc1.640028')).toBe('H.264');
    expect(formatCodecBadge('hev1.1.6.L120')).toBe('HEVC');
    expect(formatCodecBadge('vp09.00.41.08')).toBe('VP9');
    expect(formatCodecBadge('opus')).toBe('Opus');
    expect(formatCodecBadge('mp4a.40.2')).toBe('AAC');
    expect(formatCodecBadge('mp3')).toBe('MP3');
  });

  it('derives deduplicated codec and bitrate badges from option fields and detail', () => {
    expect(
      optionBadges({
        container: 'mp4',
        videoCodec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
        audioBitrateKbps: 320,
        fps: 60,
        detail: 'MP4 · H.264 · AAC 320kbps',
      }),
    ).toEqual(['H.264', 'AAC', '320kbps', '60fps']);
  });
});

describe('resolvePipelineStepIndex', () => {
  it('maps job state and step text to the 5-step pipeline', () => {
    expect(PIPELINE_STEPS).toEqual(['Resolving', 'Downloading', 'Transcoding', 'Tagging', 'Done']);
    expect(resolvePipelineStepIndex('queued', 'Queued')).toBe(0);
    expect(resolvePipelineStepIndex('resolving', 'Resolving media')).toBe(0);
    expect(resolvePipelineStepIndex('downloading', 'Downloading video')).toBe(1);
    expect(resolvePipelineStepIndex('converting', 'Transcoding with FFmpeg')).toBe(2);
    expect(resolvePipelineStepIndex('packaging', 'Tagging metadata')).toBe(3);
    expect(resolvePipelineStepIndex('ready', 'Done')).toBe(4);
  });
});
