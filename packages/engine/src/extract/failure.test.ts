import { describe, expect, it } from 'vitest';
import { seraError } from '../errors.js';
import {
  classifyFailure,
  isEgressProblem,
  isTransient,
  requiresOriginatingNode,
} from './failure.js';

/**
 * Every routing decision rests on this. Wrong in one direction it spends a scarce
 * residential connection re-asking about a deleted video; wrong in the other it tells
 * someone a public video is unavailable when a different network would have had it.
 */
describe('classifyFailure', () => {
  it('recognises the two failures a different network could fix', () => {
    expect(classifyFailure(seraError('SOURCE_BLOCKED'))).toBe('DATACENTER_BLOCKED');
    // Wording outranks the code: extractors report a bot challenge as a login problem.
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
    // The signed-URL case. Not fixed by another network — fixed by downloading where the
    // resolve happened, which is a different instruction entirely.
    const refused = classifyFailure(
      seraError('NETWORK_ERROR', { detail: 'unable to download video data: HTTP Error 403' }),
    );
    expect(refused).toBe('STREAM_403');
    expect(requiresOriginatingNode(refused)).toBe(true);
    expect(isEgressProblem(refused)).toBe(false);
  });

  it('separates a login wall from a misconfigured server', () => {
    // These read alike and need opposite responses: one is the visitor's answer, the
    // other is the operator's bug.
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
    expect(classifyFailure(seraError('AGE_RESTRICTED'))).toBe('PRIVATE_CONTENT');
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
    // The safe direction: an unrecognised failure must not send work to a home
    // connection on the chance that it helps.
    expect(classifyFailure(new Error('something nobody has seen'))).toBe('EXTRACTOR_BUG');
    expect(isEgressProblem(classifyFailure(new Error('x')))).toBe(false);
    expect(requiresOriginatingNode(classifyFailure(new Error('x')))).toBe(false);
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

  it('marks only the signed-URL case as needing the originating node', () => {
    expect(requiresOriginatingNode('STREAM_403')).toBe(true);
    expect(requiresOriginatingNode('DATACENTER_BLOCKED')).toBe(false);
    expect(requiresOriginatingNode('NETWORK_ERROR')).toBe(false);
  });

  it('knows which failures asking again could plausibly change', () => {
    expect(isTransient('RATE_LIMITED')).toBe(true);
    expect(isTransient('SOURCE_ERROR')).toBe(true);
    expect(isTransient('UPSTREAM_TIMEOUT')).toBe(true);
    // Retrying these unchanged is just a slower way to the same answer.
    expect(isTransient('PRIVATE_CONTENT')).toBe(false);
    expect(isTransient('DELETED_CONTENT')).toBe(false);
    expect(isTransient('UNSUPPORTED_MEDIA')).toBe(false);
  });
});
