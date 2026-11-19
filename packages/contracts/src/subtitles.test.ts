import { describe, expect, it } from 'vitest';
import { createJobRequestSchema } from './schemas.js';

const job = (subtitles: unknown) =>
  createJobRequestSchema.safeParse({ infoId: 'info', optionIds: ['option'], subtitles });

describe('the subtitle request', () => {
  it('takes a language, auto-generated or not, as a file, alone or embedded', () => {
    expect(job({ lang: 'en', format: 'srt' }).success).toBe(true);
    expect(job({ lang: 'en-orig', auto: true, format: 'vtt', only: true }).success).toBe(true);
    expect(job({ lang: 'de-DE', format: 'embed' }).success).toBe(true);
  });

  it('refuses a language that is not a plain code', () => {
    expect(job({ lang: 'en,all', format: 'srt' }).success).toBe(false);
    expect(job({ lang: '--exec', format: 'srt' }).success).toBe(false);
    expect(job({ lang: 'en us', format: 'srt' }).success).toBe(false);
    expect(job({ lang: '', format: 'srt' }).success).toBe(false);
  });

  it('refuses an unknown format, and an embed with nothing to embed it in', () => {
    expect(job({ lang: 'en', format: 'ass' }).success).toBe(false);
    expect(job({ lang: 'en', format: 'embed', only: true }).success).toBe(false);
  });
});
