import { describe, expect, it } from 'vitest';
import {
  assertSafeFilename,
  buildFilename,
  contentDispositionValue,
  dedupeFilename,
  mediaFilename,
  sanitizeExtension,
  sanitizeStem,
} from './filename.js';

describe('sanitizeStem', () => {
  it('keeps ordinary titles readable', () => {
    expect(sanitizeStem('My Great Video')).toBe('My Great Video');
    expect(sanitizeStem('Track 01 - Intro')).toBe('Track 01 - Intro');
    expect(sanitizeStem('日本語のタイトル')).toBe('日本語のタイトル');
    expect(sanitizeStem('Café — naïve')).toBe('Café — naïve');
  });

  it('removes every path separator rather than escaping it', () => {
    expect(sanitizeStem('../../etc/passwd')).toBe('etc passwd');
    expect(sanitizeStem('..\\..\\windows\\system32')).toBe('windows system32');
    expect(sanitizeStem('/absolute/path')).toBe('absolute path');
    // The drive letter survives as an ordinary character; the colon and slashes, which
    // are what would make it a path, do not.
    expect(sanitizeStem('C:\\Users\\me')).toBe('C Users me');
  });

  it('removes the characters filesystems reject', () => {
    expect(sanitizeStem('a<b>c:d"e|f?g*h')).toBe('a b c d e f g h');
    expect(sanitizeStem('null\u0000byte')).toBe('null byte');
    expect(sanitizeStem('bell\u0007char')).toBe('bell char');
  });

  it('removes characters that could disguise an extension', () => {
    // A right-to-left override can make "exe.txt" render as "txt.exe".
    expect(sanitizeStem('report\u202Egpj.exe')).toBe('reportgpj.exe');
    expect(sanitizeStem('zero\u200Bwidth')).toBe('zerowidth');
  });

  it('refuses names Windows reserves', () => {
    expect(sanitizeStem('CON')).toBe('media');
    expect(sanitizeStem('con')).toBe('media');
    expect(sanitizeStem('PRN')).toBe('media');
    expect(sanitizeStem('COM1')).toBe('media');
    expect(sanitizeStem('LPT9')).toBe('media');
    expect(sanitizeStem('NUL')).toBe('media');
  });

  it('never yields a leading dot or dash', () => {
    expect(sanitizeStem('.hidden')).toBe('hidden');
    expect(sanitizeStem('...dots')).toBe('dots');
    expect(sanitizeStem('-rf')).toBe('rf');
    expect(sanitizeStem('trailing.')).toBe('trailing');
  });

  it('falls back when nothing usable survives', () => {
    expect(sanitizeStem('')).toBe('media');
    expect(sanitizeStem('///')).toBe('media');
    expect(sanitizeStem('...')).toBe('media');
    expect(sanitizeStem('   ')).toBe('media');
    expect(sanitizeStem('', 'custom')).toBe('custom');
  });

  it('truncates long titles on a word boundary', () => {
    const long = 'word '.repeat(60);
    const result = sanitizeStem(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(' ')).toBe(false);
    expect(result.endsWith('-')).toBe(false);
  });
});

describe('sanitizeExtension', () => {
  it('normalizes to a bare lowercase token', () => {
    expect(sanitizeExtension('.MP4')).toBe('mp4');
    expect(sanitizeExtension('mp4')).toBe('mp4');
    expect(sanitizeExtension('..mp4')).toBe('mp4');
  });

  it('falls back for anything unusable', () => {
    expect(sanitizeExtension('')).toBe('bin');
    expect(sanitizeExtension('../../sh')).toBe('sh');
    expect(sanitizeExtension('averylongextension')).toBe('bin');
    expect(sanitizeExtension('!!!')).toBe('bin');
  });
});

describe('mediaFilename', () => {
  it('uses the conventional creator - title form', () => {
    expect(mediaFilename({ author: 'Creator', title: 'Post title', container: 'mp4' })).toBe(
      'Creator - Post title.mp4',
    );
  });

  it('omits the separator when a part is missing', () => {
    expect(mediaFilename({ title: 'Only title', container: 'mp3' })).toBe('Only title.mp3');
    expect(mediaFilename({ author: 'Only author', container: 'mp3' })).toBe('Only author.mp3');
  });

  it('numbers the parts of a collection', () => {
    expect(mediaFilename({ author: 'A', title: 'B', container: 'jpg', index: 2 })).toBe(
      'A - B (2).jpg',
    );
  });

  it('still produces a usable name from hostile metadata', () => {
    const name = mediaFilename({ author: '../..', title: '\u0000\u0000', container: 'mp4' });
    expect(name).toBe('media.mp4');
    expect(() => assertSafeFilename(name)).not.toThrow();
  });
});

describe('dedupeFilename', () => {
  it('numbers collisions and leaves the first name alone', () => {
    const taken = new Set<string>();
    expect(dedupeFilename('a.mp4', taken)).toBe('a.mp4');
    expect(dedupeFilename('a.mp4', taken)).toBe('a (2).mp4');
    expect(dedupeFilename('a.mp4', taken)).toBe('a (3).mp4');
    expect(dedupeFilename('b.mp4', taken)).toBe('b.mp4');
  });

  it('treats names that differ only in case as colliding', () => {
    const taken = new Set<string>();
    dedupeFilename('A.mp4', taken);
    expect(dedupeFilename('a.mp4', taken)).toBe('a (2).mp4');
  });
});

describe('assertSafeFilename', () => {
  it('accepts a bare filename', () => {
    expect(assertSafeFilename('video.mp4')).toBe('video.mp4');
    expect(assertSafeFilename('Creator - Title (2).jpg')).toBe('Creator - Title (2).jpg');
  });

  it('rejects anything that could name a path', () => {
    for (const value of [
      '../secret',
      '..',
      '.',
      'a/b.mp4',
      'a\\b.mp4',
      '/etc/passwd',
      'C:\\Windows\\x.mp4',
      'x\u0000.mp4',
      '',
      'a'.repeat(300),
    ]) {
      expect(() => assertSafeFilename(value), value).toThrow();
    }
  });
});

describe('contentDispositionValue', () => {
  it('provides both an ASCII fallback and the encoded name', () => {
    const value = contentDispositionValue('café.mp4');
    expect(value).toContain('attachment;');
    expect(value).toContain("filename*=UTF-8''caf%C3%A9.mp4");
    expect(value).toMatch(/filename="caf.\.mp4"/);
  });

  it('cannot be used to inject a header quote', () => {
    const value = contentDispositionValue('evil".mp4');
    expect(value).toMatch(/filename="evil_\.mp4"/);
    // Exactly one quoted filename parameter, so no second directive can be smuggled in.
    expect(value.match(/"/g)).toHaveLength(2);
  });
});

describe('buildFilename', () => {
  it('joins a sanitized stem and extension', () => {
    expect(buildFilename('My Video', 'MP4')).toBe('My Video.mp4');
    expect(buildFilename('../x', '.mp4')).toBe('x.mp4');
  });
});
