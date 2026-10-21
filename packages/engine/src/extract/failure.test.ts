import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seraError } from '../errors.js';
import { classifyFailure, FAILURE_BY_CODE, isEgressProblem } from './failure.js';

describe('classifyFailure', () => {
  it('recognises the two failures a different network could fix', () => {
    expect(classifyFailure(seraError('SOURCE_BLOCKED'))).toBe('DATACENTER_BLOCKED');
    expect(
      classifyFailure(
        seraError('LOGIN_REQUIRED', { detail: "Sign in to confirm you're not a bot" }),
      ),
    ).toBe('BOT_DETECTION');
    expect(classifyFailure(seraError('PROVIDER_UNAVAILABLE', { detail: 'unusual traffic' }))).toBe(
      'BOT_DETECTION',
    );
  });

  it('separates a refused media URL from a refused page', () => {
    const refused = classifyFailure(
      seraError('NETWORK_ERROR', { detail: 'unable to download video data: HTTP Error 403' }),
    );
    expect(refused).toBe('STREAM_403');
    expect(isEgressProblem(refused)).toBe(false);
  });

  it('separates a login wall from a misconfigured server', () => {
    expect(
      classifyFailure(
        seraError('LOGIN_REQUIRED', { detail: 'The web client only works when logged-in' }),
      ),
    ).toBe('LOGIN_REQUIRED');
    expect(classifyFailure(seraError('PROVIDER_AUTH_REQUIRED'))).toBe('LOGIN_REQUIRED');
    expect(classifyFailure(seraError('PROVIDER_CONFIGURATION_ERROR'))).toBe(
      'AUTH_CONFIGURATION_ERROR',
    );
  });

  it('separates gone from private from geo-blocked', () => {
    expect(classifyFailure(seraError('MEDIA_UNAVAILABLE'))).toBe('DELETED_CONTENT');
    expect(classifyFailure(seraError('PRIVATE_CONTENT'))).toBe('PRIVATE_CONTENT');
    expect(classifyFailure(seraError('AGE_RESTRICTED'))).toBe('AGE_RESTRICTED');
    expect(classifyFailure(seraError('GEO_RESTRICTED'))).toBe('GEO_BLOCKED');
    expect(
      classifyFailure(
        seraError('PROVIDER_UNAVAILABLE', { detail: 'not available in your country' }),
      ),
    ).toBe('GEO_BLOCKED');
  });

  it('separates a bad link from unsupported media', () => {
    expect(classifyFailure(seraError('INVALID_URL'))).toBe('UNSUPPORTED_URL');
    expect(classifyFailure(seraError('BLOCKED_ADDRESS'))).toBe('UNSUPPORTED_URL');
    expect(classifyFailure(seraError('UNSUPPORTED_SOURCE'))).toBe('UNSUPPORTED_MEDIA');
    expect(classifyFailure(seraError('ROBOTS_DISALLOWED'))).toBe('UNSUPPORTED_MEDIA');
  });

  it('separates our output problems from theirs', () => {
    expect(classifyFailure(seraError('CONVERSION_FAILED'))).toBe('OUTPUT_ERROR');
    expect(classifyFailure(seraError('TOO_LARGE'))).toBe('OUTPUT_ERROR');
    expect(classifyFailure(seraError('TIMEOUT'))).toBe('UPSTREAM_TIMEOUT');
    expect(
      classifyFailure(seraError('NETWORK_ERROR', { detail: 'HTTP Error 503 Service Unavailable' })),
    ).toBe('SOURCE_ERROR');
  });

  it('degrades an unknown failure to an extractor bug, not a network one', () => {
    expect(classifyFailure(new Error('something nobody has seen'))).toBe('EXTRACTOR_BUG');
    expect(isEgressProblem(classifyFailure(new Error('x')))).toBe(false);
  });
});

describe('routing predicates', () => {
  it('sends only address-shaped failures to another network', () => {
    expect(isEgressProblem('DATACENTER_BLOCKED')).toBe(true);
    expect(isEgressProblem('BOT_DETECTION')).toBe(true);
    for (const other of [
      'STREAM_403',
      'RATE_LIMITED',
      'LOGIN_REQUIRED',
      'AUTH_CONFIGURATION_ERROR',
      'PRIVATE_CONTENT',
      'DELETED_CONTENT',
      'GEO_BLOCKED',
      'UNSUPPORTED_URL',
      'UNSUPPORTED_MEDIA',
      'EXTRACTOR_BUG',
      'SOURCE_ERROR',
      'UPSTREAM_TIMEOUT',
      'NETWORK_ERROR',
      'OUTPUT_ERROR',
    ] as const) {
      expect(isEgressProblem(other), other).toBe(false);
    }
  });
});

describe('the taxonomy against the error codes it has to cover', () => {
  const contract = readFileSync(
    new URL('../../../contracts/src/types.ts', import.meta.url),
    'utf8',
  );
  const codes = [
    ...contract
      .slice(contract.indexOf('export type ErrorCode'))
      .split(';')[0]!
      .matchAll(/'([A-Z_]+)'/g),
  ].map((match) => match[1]!);

  it('found the code list', () => {
    expect(codes.length).toBeGreaterThan(20);
    expect(codes).toContain('LIVE_IN_PROGRESS');
  });

  it('gives every code a mapping somebody chose', () => {
    for (const code of codes) {
      expect(FAILURE_BY_CODE[code], `${code} has no mapping`).toBeDefined();
    }
  });

  it('sends only one code to another network', () => {
    const egress = codes.filter((code) =>
      isEgressProblem(classifyFailure(seraError(code as Parameters<typeof seraError>[0]))),
    );
    expect(egress).toEqual(['SOURCE_BLOCKED']);
  });

  it('treats a visitor leaving as its own answer', () => {
    const cancelled = classifyFailure(seraError('CANCELLED'));
    expect(cancelled).toBe('CANCELLED');
    expect(isEgressProblem(cancelled)).toBe(false);
  });

  it('says a live stream is unsupported media, not a bug', () => {
    const live = classifyFailure(seraError('LIVE_IN_PROGRESS'));
    expect(live).toBe('UNSUPPORTED_MEDIA');
    expect(isEgressProblem(live)).toBe(false);
  });

  it('keeps "the server is full" separate from "the source refused us"', () => {
    const full = classifyFailure(seraError('QUEUE_FULL'));
    expect(full).toBe('RATE_LIMITED');
    expect(isEgressProblem(full)).toBe(false);
  });
});
