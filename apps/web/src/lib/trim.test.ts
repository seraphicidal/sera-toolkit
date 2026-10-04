import { describe, expect, it } from 'vitest';
import { endPlaceholder, summarizeTrim } from './trim';

/**
 * The trim fields' summary: nothing until a time is typed, the server's own reason when a
 * time is wrong, and otherwise how much is kept and roughly how big it will be.
 */

describe('summarizeTrim', () => {
  it('is nothing until a time is typed', () => {
    expect(summarizeTrim('', '', 600, 60_000_000)).toEqual({ state: 'none' });
    expect(summarizeTrim(' ', '', 600, undefined)).toEqual({ state: 'none' });
  });

  it('gives the length kept and a size in proportion', () => {
    expect(summarizeTrim('0:10', '0:30', 600, 60_000_000)).toEqual({
      state: 'ok',
      request: { start: '0:10', end: '0:30' },
      keptSeconds: 20,
      estimatedBytes: 2_000_000,
    });
  });

  it('runs a missing end to the end of the media', () => {
    const summary = summarizeTrim('9:00', '', 600, 60_000_000);
    expect(summary).toMatchObject({ state: 'ok', keptSeconds: 60, estimatedBytes: 6_000_000 });
  });

  it("says what is wrong in the server's own words", () => {
    expect(summarizeTrim('0:30', '0:10', 600, undefined)).toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/before the end/),
    });
    expect(summarizeTrim('12:00', '', 600, undefined)).toMatchObject({ state: 'invalid' });
    expect(summarizeTrim('1m', '', 600, undefined)).toMatchObject({ state: 'invalid' });
  });

  it('leaves out what it cannot know', () => {
    expect(summarizeTrim('0:10', '0:30', undefined, undefined)).toEqual({
      state: 'ok',
      request: { start: '0:10', end: '0:30' },
      keptSeconds: 20,
    });
    expect(summarizeTrim('0:10', '', undefined, undefined)).toEqual({
      state: 'ok',
      request: { start: '0:10' },
    });
  });

  it('shows the length as the end placeholder', () => {
    expect(endPlaceholder(754)).toBe('12:34');
    expect(endPlaceholder(undefined)).toBe('End');
  });
});
