import { describe, expect, it } from 'vitest';
import { seraError } from '../errors.js';
import { classifyFailure, isEgressProblem } from './failure.js';

/**
 * The routing decision rests entirely on this. Getting it wrong in one direction spends
 * a scarce residential connection re-asking about a deleted video; in the other it tells
 * someone a public video is unavailable when a different network would have had it.
 */
describe('classifyFailure', () => {
  it('recognises the two failures a different network could fix', () => {
    expect(classifyFailure(seraError('SOURCE_BLOCKED'))).toBe('DATACENTER_BLOCKED');
    // The wording wins over the code: a bot challenge is network-shaped whatever the
    // extractor decided to call it.
    expect(
      classifyFailure(
        seraError('LOGIN_REQUIRED', { detail: "Sign in to confirm you're not a bot" }),
      ),
    ).toBe('BOT_DETECTION');
    expect(classifyFailure(seraError('PROVIDER_UNAVAILABLE', { detail: 'unusual traffic' }))).toBe(
      'BOT_DETECTION',
    );
  });

  it('keeps a genuine login wall apart from a bot challenge', () => {
    // Vimeo's web client needs an account from every address; retrying it elsewhere is
    // a waste of the one home connection this deployment might have.
    expect(
      classifyFailure(
        seraError('LOGIN_REQUIRED', { detail: 'The web client only works when logged-in' }),
      ),
    ).toBe('AUTH_REQUIRED');
    expect(classifyFailure(seraError('PROVIDER_AUTH_REQUIRED'))).toBe('AUTH_REQUIRED');
  });

  it('maps the outcomes that are the same from everywhere', () => {
    expect(classifyFailure(seraError('PRIVATE_CONTENT'))).toBe('PRIVATE_CONTENT');
    expect(classifyFailure(seraError('AGE_RESTRICTED'))).toBe('PRIVATE_CONTENT');
    expect(classifyFailure(seraError('MEDIA_UNAVAILABLE'))).toBe('MEDIA_NOT_FOUND');
    expect(classifyFailure(seraError('RATE_LIMITED'))).toBe('PROVIDER_RATE_LIMITED');
    expect(classifyFailure(seraError('UNSUPPORTED_SOURCE'))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(classifyFailure(seraError('NETWORK_ERROR'))).toBe('NETWORK_FAILURE');
  });

  it('degrades an unknown failure to an extractor problem, not a network one', () => {
    // The safe direction: an unrecognised failure must not send work to a home
    // connection on the chance that it helps.
    expect(classifyFailure(new Error('something nobody has seen'))).toBe('EXTRACTOR_FAILURE');
    expect(isEgressProblem(classifyFailure(new Error('x')))).toBe(false);
  });
});

describe('isEgressProblem', () => {
  it('is true only for the network-shaped classes', () => {
    expect(isEgressProblem('DATACENTER_BLOCKED')).toBe(true);
    expect(isEgressProblem('BOT_DETECTION')).toBe(true);
    for (const other of [
      'AUTH_REQUIRED',
      'PRIVATE_CONTENT',
      'MEDIA_NOT_FOUND',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_TEMPORARY_FAILURE',
      'UNSUPPORTED_MEDIA_TYPE',
      'EXTRACTOR_FAILURE',
      'NETWORK_FAILURE',
    ] as const) {
      expect(isEgressProblem(other), other).toBe(false);
    }
  });
});
