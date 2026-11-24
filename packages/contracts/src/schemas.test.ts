import { describe, expect, it } from 'vitest';
import {
  apiErrorBodySchema,
  errorCodeSchema,
  isSafeYoutubeExtraArgs,
  mediaKindSchema,
  progressSchema,
  resolvedPlanSchema,
  ServiceInfoSchema,
  youtubeExtraArgsSchema,
  youtubeHotConfigSchema,
} from './schemas.js';

describe('contracts schemas hardening', () => {
  it('supports VALIDATION_ERROR, FORBIDDEN, and apiErrorBodySchema', () => {
    expect(errorCodeSchema.parse('VALIDATION_ERROR')).toBe('VALIDATION_ERROR');
    expect(errorCodeSchema.parse('FORBIDDEN')).toBe('FORBIDDEN');
    expect(
      apiErrorBodySchema.parse({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid field.', retryable: false },
      }),
    ).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid field.', retryable: false },
    });
  });

  it('supports file MediaKind and remote speed/eta progress fields', () => {
    expect(mediaKindSchema.parse('file')).toBe('file');
    expect(
      progressSchema.parse({
        percent: 42,
        step: 'Downloading',
        bytesDownloaded: 1024,
        bytesTotal: 4096,
        speedBytesPerSecond: 512.5,
        etaSeconds: 6,
      }),
    ).toEqual({
      percent: 42,
      step: 'Downloading',
      bytesDownloaded: 1024,
      bytesTotal: 4096,
      speedBytesPerSecond: 512.5,
      etaSeconds: 6,
    });
  });

  it('validates ServiceInfoSchema with nodeAvailability telemetry', () => {
    const parsed = ServiceInfoSchema.parse({
      name: 'SERA.toolkit',
      version: '1.8.0',
      providers: [],
      limits: {
        maxFilesizeBytes: 1024,
        maxDurationSeconds: 60,
        maxItemsPerJob: 10,
        retentionSeconds: 600,
      },
      nodeAvailability: {
        enabled: true,
        totalNodes: 2,
        healthyNodes: 1,
        residentialNodes: 1,
        features: ['trim', 'subtitles'],
        providers: ['youtube'],
      },
    });
    expect(parsed.nodeAvailability?.healthyNodes).toBe(1);
  });

  it('enforces strict allowlist on youtubeHotConfig.extraArgs', () => {
    expect(
      youtubeExtraArgsSchema.safeParse(['--sleep-requests', '1', '--force-ipv4']).success,
    ).toBe(true);
    expect(
      youtubeExtraArgsSchema.safeParse(['--extractor-args=youtube:player_client=tv,web']).success,
    ).toBe(true);

    const dangerous: string[][] = [
      ['--exec', 'id'],
      ['--exe', 'id'],
      ['--downloader', 'aria2c'],
      ['--external-downloader', 'curl'],
      ['--ffmpeg-location', '/tmp/evil'],
      ['--js-runtimes', 'node:/tmp/evil'],
      ['--print-to-file', 'title', '/tmp/pwn'],
      ['--postprocessor-args', 'ffmpeg:-i /etc/passwd'],
      ['--no-check-certificates'],
      ['--proxy', 'http://127.0.0.1:8080'],
      ['--cookies', '/etc/passwd'],
      ['-o/tmp/pwn'],
      ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'],
      ['--sleep-requests'],
    ];
    for (const candidate of dangerous) {
      expect(isSafeYoutubeExtraArgs(candidate), candidate.join(' ')).toBe(false);
      expect(
        youtubeHotConfigSchema.safeParse({
          playerClients: ['web'],
          extraArgs: candidate,
          remoteComponents: ['ejs:github'],
        }).success,
        candidate.join(' '),
      ).toBe(false);
    }
  });

  it('enforces strict allowlists on resolvedPlanSchema', () => {
    const valid = {
      kind: 'video',
      container: 'mp4',
      label: '1080p',
      requiresConversion: false,
      recommended: true,
      fetch: {
        via: 'ytdlp',
        selector: '137+140/best',
        merge: 'mp4',
        extractorArgs: ['youtube:player_client=tv'],
        useExtractors: 'default,-generic',
      },
    };
    expect(resolvedPlanSchema.safeParse(valid).success).toBe(true);
    expect(resolvedPlanSchema.safeParse({ ...valid, container: '../../etc' }).success).toBe(false);
    expect(
      resolvedPlanSchema.safeParse({
        ...valid,
        fetch: { ...valid.fetch, selector: '--exec id' },
      }).success,
    ).toBe(false);
    expect(
      resolvedPlanSchema.safeParse({
        ...valid,
        fetch: {
          ...valid.fetch,
          extractorArgs: ['youtubepot-bgutilhttp:base_url=http://169.254.169.254'],
        },
      }).success,
    ).toBe(false);
    expect(
      resolvedPlanSchema.safeParse({
        ...valid,
        fetch: { via: 'direct', url: 'https://user:pass@example.com/a.mp4' },
      }).success,
    ).toBe(false);
  });
});
