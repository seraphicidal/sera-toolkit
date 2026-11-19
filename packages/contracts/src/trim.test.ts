import { describe, expect, it } from 'vitest';
import { createJobRequestSchema } from './schemas.js';
import { checkTrim, formatTimecode, parseTimecode, trimSuffix } from './types.js';

describe('timecodes', () => {
  it('reads m:ss, mm:ss and h:mm:ss', () => {
    expect(parseTimecode('0:07')).toBe(7);
    expect(parseTimecode('12:05')).toBe(725);
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode(' 3:00 ')).toBe(180);
  });

  it('refuses anything else', () => {
    for (const text of ['', '7', '1:5', '1:60', '61', '1:2:3:4', 'a:bc', '-1:00', '1.5:00']) {
      expect(parseTimecode(text), text).toBeUndefined();
    }
  });

  it('writes them back the short way', () => {
    expect(formatTimecode(7)).toBe('0:07');
    expect(formatTimecode(725)).toBe('12:05');
    expect(formatTimecode(3723)).toBe('1:02:03');
  });
});

describe('checkTrim', () => {
  const ok = (trim: { start?: string; end?: string }, duration?: number) => {
    const checked = checkTrim(trim, duration);
    if (!checked.ok) throw new Error(checked.message);
    return checked.range;
  };
  const refusal = (trim: { start?: string; end?: string }, duration?: number) => {
    const checked = checkTrim(trim, duration);
    return checked.ok ? undefined : checked.message;
  };

  it('takes a start, an end, or both', () => {
    expect(ok({ start: '0:10', end: '0:30' }, 600)).toEqual({ start: 10, end: 30 });
    expect(ok({ start: '1:00' }, 600)).toEqual({ start: 60 });
    expect(ok({ end: '0:30' }, 600)).toEqual({ start: 0, end: 30 });
  });

  it('treats an end at the reported length as the end of the media', () => {
    expect(ok({ start: '0:10', end: '10:00' }, 600)).toEqual({ start: 10 });
    expect(ok({ start: '0:10', end: '10:01' }, 600)).toEqual({ start: 10 });
  });

  it('refuses times outside the media, out of order, or too short', () => {
    expect(refusal({ start: '10:00' }, 600)).toMatch(/start is past the end/);
    expect(refusal({ start: '0:10', end: '11:00' }, 600)).toMatch(/end is past the end/);
    expect(refusal({ start: '0:30', end: '0:10' }, 600)).toMatch(/before the end/);
    expect(refusal({ start: '0:30', end: '0:30' }, 600)).toMatch(/before the end/);
  });

  it('refuses a trim that keeps everything, or gives no times', () => {
    expect(refusal({}, 600)).toMatch(/start or an end/);
    expect(refusal({ start: '0:00' }, 600)).toMatch(/nothing to trim/);
    expect(refusal({ start: '0:00', end: '10:00' }, 600)).toMatch(/nothing to trim/);
  });

  it('checks only shape and order when the length is not known', () => {
    expect(ok({ start: '5:00', end: '9:00' })).toEqual({ start: 300, end: 540 });
    expect(refusal({ start: '9:00', end: '5:00' })).toMatch(/before the end/);
  });

  it('names a bad time rather than guessing', () => {
    expect(refusal({ start: '90' }, 600)).toMatch(/m:ss or h:mm:ss/);
  });
});

describe('trimSuffix', () => {
  it('says what was kept, in the file name', () => {
    expect(trimSuffix({ start: 10, end: 30 })).toBe('-trim-0m10s-0m30s');
    expect(trimSuffix({ start: 3723 }, 7200)).toBe('-trim-1h02m03s-2h00m00s');
    expect(trimSuffix({ start: 65 })).toBe('-trim-1m05s-end');
  });
});

describe('the job request schema', () => {
  const base = { infoId: 'i', optionIds: ['o'] };

  it('accepts a request with or without a trim', () => {
    expect(createJobRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createJobRequestSchema.safeParse({ ...base, trim: { start: '0:10', end: '0:30' } }).success,
    ).toBe(true);
  });

  it('refuses a malformed or backwards trim with a sentence a visitor can read', () => {
    const malformed = createJobRequestSchema.safeParse({ ...base, trim: { start: '10s' } });
    expect(malformed.success).toBe(false);
    expect(malformed.error?.issues[0]?.message).toMatch(/m:ss or h:mm:ss/);
    const backwards = createJobRequestSchema.safeParse({
      ...base,
      trim: { start: '0:30', end: '0:10' },
    });
    expect(backwards.error?.issues[0]?.message).toMatch(/before the end/);
  });
});
