import { describe, expect, it } from 'vitest';
import type { YtdlpFormat } from '../extract/ytdlp-types.js';
import {
  audioBitrateChoices,
  bestAudio,
  bestVideoPerHeight,
  estimateSize,
  fitsInMp4,
  nativeContainer,
  splitFormats,
  toUsableFormats,
} from './formats.js';

/** A realistic YouTube-shaped format list, including everything that must be filtered. */
const youtubeFormats: YtdlpFormat[] = [
  // Storyboards: images of the timeline, not media.
  { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', vcodec: 'none', acodec: 'none' },
  { format_id: 'sb1', ext: 'mhtml', protocol: 'mhtml', format_note: 'storyboard' },
  // Audio, including the loudness-normalized twins.
  {
    format_id: '140',
    ext: 'm4a',
    protocol: 'https',
    acodec: 'mp4a.40.2',
    vcodec: 'none',
    abr: 129,
    filesize: 3_000_000,
  },
  {
    format_id: '140-drc',
    ext: 'm4a',
    protocol: 'https',
    acodec: 'mp4a.40.2',
    vcodec: 'none',
    abr: 129,
  },
  {
    format_id: '251',
    ext: 'webm',
    protocol: 'https',
    acodec: 'opus',
    vcodec: 'none',
    abr: 141,
    filesize: 3_400_000,
  },
  {
    format_id: '251-drc',
    ext: 'webm',
    protocol: 'https',
    acodec: 'opus',
    vcodec: 'none',
    abr: 141,
  },
  // Video-only renditions.
  {
    format_id: '137',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'avc1.640028',
    acodec: 'none',
    width: 1920,
    height: 1080,
    fps: 30,
    tbr: 4000,
    filesize: 50_000_000,
  },
  {
    format_id: '248',
    ext: 'webm',
    protocol: 'https',
    vcodec: 'vp09.00.40.08',
    acodec: 'none',
    width: 1920,
    height: 1080,
    fps: 30,
    tbr: 3000,
    filesize: 38_000_000,
  },
  {
    format_id: '399',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'av01.0.08M.08',
    acodec: 'none',
    width: 1920,
    height: 1080,
    fps: 30,
    tbr: 2600,
    filesize: 32_000_000,
  },
  {
    format_id: '136',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'avc1.4d401f',
    acodec: 'none',
    width: 1280,
    height: 720,
    fps: 30,
    tbr: 2000,
    filesize: 25_000_000,
  },
  {
    format_id: '135',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'avc1.4d401e',
    acodec: 'none',
    width: 854,
    height: 480,
    fps: 30,
    tbr: 1000,
    filesize: 12_000_000,
  },
  // The "premium" 1080p twin, which is the same picture at a slightly higher bitrate.
  {
    format_id: '616',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'vp09.00.40.08',
    acodec: 'none',
    width: 1920,
    height: 1080,
    format_note: 'Premium',
    tbr: 4200,
  },
  // Progressive, which carries both streams.
  {
    format_id: '18',
    ext: 'mp4',
    protocol: 'https',
    vcodec: 'avc1.42001E',
    acodec: 'mp4a.40.2',
    width: 640,
    height: 360,
    fps: 30,
    tbr: 700,
    filesize: 9_000_000,
  },
  // HLS duplicate of a rendition already present.
  {
    format_id: '96',
    ext: 'mp4',
    protocol: 'm3u8_native',
    vcodec: 'avc1.640028',
    acodec: 'mp4a.40.2',
    width: 1920,
    height: 1080,
    tbr: 4500,
  },
];

describe('toUsableFormats', () => {
  const usable = toUsableFormats(youtubeFormats);

  it('drops storyboards', () => {
    expect(usable.some((f) => f.id.startsWith('sb'))).toBe(false);
  });

  it('drops the loudness-normalized audio twins', () => {
    expect(usable.some((f) => f.id.endsWith('-drc'))).toBe(false);
    // The ordinary rendition survives.
    expect(usable.some((f) => f.id === '140')).toBe(true);
  });

  it('drops the premium duplicate', () => {
    expect(usable.some((f) => f.id === '616')).toBe(false);
  });

  it('keeps every real rendition', () => {
    expect(usable.map((f) => f.id).sort()).toEqual(
      ['135', '136', '137', '140', '18', '248', '251', '399', '96'].sort(),
    );
  });

  it('records whether a size was reported or estimated', () => {
    const exact = usable.find((f) => f.id === '137');
    expect(exact?.filesize).toBe(50_000_000);
    expect(exact?.filesizeIsApproximate).toBe(false);
    const noSize = usable.find((f) => f.id === '96');
    expect(noSize?.filesize).toBeUndefined();
  });

  it('returns nothing for an empty or missing list', () => {
    expect(toUsableFormats(undefined)).toEqual([]);
    expect(toUsableFormats([])).toEqual([]);
    expect(toUsableFormats([{ ext: 'mp4' }])).toEqual([]); // no format_id
  });

  it('drops entries with neither a video nor an audio codec', () => {
    expect(toUsableFormats([{ format_id: 'x', vcodec: 'none', acodec: 'none' }])).toEqual([]);
  });
});

describe('splitFormats', () => {
  it('separates the three kinds of rendition', () => {
    const { videoOnly, audioOnly, progressive } = splitFormats(toUsableFormats(youtubeFormats));
    expect(videoOnly.map((f) => f.id).sort()).toEqual(['135', '136', '137', '248', '399']);
    expect(audioOnly.map((f) => f.id).sort()).toEqual(['140', '251']);
    expect(progressive.map((f) => f.id).sort()).toEqual(['18', '96']);
  });
});

describe('bestAudio', () => {
  const { audioOnly } = splitFormats(toUsableFormats(youtubeFormats));

  it('prefers a codec that muxes into the requested container without re-encoding', () => {
    expect(bestAudio(audioOnly, 'mp4')?.id).toBe('140'); // AAC for MP4
    expect(bestAudio(audioOnly, 'webm')?.id).toBe('251'); // Opus for WebM
  });

  it('falls back to the highest bitrate when the container does not matter', () => {
    expect(bestAudio(audioOnly, 'any')?.id).toBe('251');
  });

  it('returns nothing when there is no audio', () => {
    expect(bestAudio([])).toBeUndefined();
  });
});

describe('bestVideoPerHeight', () => {
  const { videoOnly } = splitFormats(toUsableFormats(youtubeFormats));
  const best = bestVideoPerHeight(videoOnly);

  it('offers one rendition per height, highest first', () => {
    expect(best.map((f) => f.height)).toEqual([1080, 720, 480]);
  });

  it('prefers H.264 at a given height, because it remuxes into MP4 untouched', () => {
    expect(best[0]?.id).toBe('137');
  });
});

describe('container reasoning', () => {
  it('maps codecs onto the container they belong in', () => {
    expect(nativeContainer('avc1.640028')).toBe('mp4');
    expect(nativeContainer('av01.0.08M.08')).toBe('mp4');
    expect(nativeContainer('vp09.00.40.08')).toBe('webm');
    expect(nativeContainer(undefined)).toBe('mp4');
  });

  it('knows which pairs can share an MP4', () => {
    expect(fitsInMp4('avc1.640028', 'mp4a.40.2')).toBe(true);
    expect(fitsInMp4('av01.0.08M.08', 'mp4a.40.2')).toBe(true);
    expect(fitsInMp4('avc1.640028', 'opus')).toBe(false);

    // VP9 with AAC is an MP4, and used to be called a WebM — which cannot hold AAC, so
    // the merge failed and every Instagram Reel with it failed at the download step.
    expect(fitsInMp4('vp09.00.40.08', 'mp4a.40.2')).toBe(true);
    // With Opus it is a WebM again, which is YouTube's usual pairing.
    expect(fitsInMp4('vp09.00.40.08', 'opus')).toBe(false);
    // VP8 stays off the list: legal in MP4, played by almost nothing.
    expect(fitsInMp4('vp8', 'mp4a.40.2')).toBe(false);
  });
});

describe('estimateSize', () => {
  it('uses a reported size when there is one', () => {
    const [format] = toUsableFormats([
      { format_id: 'a', ext: 'mp4', vcodec: 'avc1', filesize: 1234, tbr: 1000 },
    ]);
    expect(estimateSize(format!, 60)).toBe(1234);
  });

  it('derives a size from bitrate and duration when there is not', () => {
    const [format] = toUsableFormats([{ format_id: 'a', ext: 'mp4', vcodec: 'avc1', tbr: 1000 }]);
    // 1000 kbps for 60s = 7.5 MB.
    expect(estimateSize(format!, 60)).toBe(7_500_000);
  });

  it('gives up rather than guessing without a duration', () => {
    const [format] = toUsableFormats([{ format_id: 'a', ext: 'mp4', vcodec: 'avc1', tbr: 1000 }]);
    expect(estimateSize(format!, undefined)).toBeUndefined();
  });
});

describe('audioBitrateChoices', () => {
  it('never offers a bitrate above what the source carries', () => {
    // Claiming 320 kbps from a 64 kbps source would be a lie about quality.
    expect(audioBitrateChoices(64)[0]).toBeLessThanOrEqual(128);
    expect(audioBitrateChoices(96)[0]).toBeLessThanOrEqual(128);
  });

  it('offers the full range for a high-bitrate source', () => {
    expect(audioBitrateChoices(320)[0]).toBe(320);
    // A 256 kbps source is allowed up to 10% above itself, which is short of 320, so
    // the highest honest label is 192 — not the 320 a less careful tool would print.
    expect(audioBitrateChoices(256)[0]).toBe(192);
    expect(audioBitrateChoices(128)[0]).toBe(128);
  });

  it('assumes the best when the source bitrate is unknown', () => {
    expect(audioBitrateChoices(undefined)[0]).toBe(320);
  });
});
