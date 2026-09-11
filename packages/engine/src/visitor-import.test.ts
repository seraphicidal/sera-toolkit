import { describe, expect, it } from 'vitest';
import type { ImportedPostNode, ImportRequest } from '@sera/contracts/types';
import { loadConfig } from './config.js';
import { SeraError } from './errors.js';
import { silentLogger } from './logging.js';
import {
  INSTAGRAM_MEDIA_HOSTS,
  type ImportedEntry,
  type MediaHostPolicy,
} from './providers/instagram-media.js';
import { MediaResolver } from './resolver.js';
import { signToken } from './util/tokens.js';

/**
 * The server's half of visitor import, with no network anywhere in it.
 *
 * A post arrives from a browser the server cannot see into, so everything here is about what
 * a hostile payload can and cannot make the server do: which URLs it will sign, for how long,
 * and whether anything it signed can be edited, or spent against a different post.
 */

const POST = 'https://www.instagram.com/p/DcOX3hWFiey/';
const hex = (epochSeconds: number) => Math.floor(epochSeconds).toString(16);

/** A URL in the shape Instagram's CDN signs, expiring `inSeconds` after `now`. */
function cdn(name: string, now: number, inSeconds = 7 * 86_400): string {
  return (
    `https://scontent-vie1-1.cdninstagram.com/v/t51.82787-15/${name}.jpg` +
    `?stp=dst-jpg_e35_tt6&_nc_ht=scontent-vie1-1.cdninstagram.com&_nc_ohc=abc` +
    `&oh=00_signature&oe=${hex(now / 1000 + inSeconds)}&_nc_sid=10d13b`
  );
}

function resolverWith(
  env: Record<string, string> = {},
  importHosts?: MediaHostPolicy,
): MediaResolver {
  return new MediaResolver({
    config: loadConfig({
      NODE_ENV: 'test',
      SERA_SECRET: 'visitor-import-secret',
      SERA_DATA_DIR: '.data/test',
      ...env,
    }),
    logger: silentLogger(),
    ...(importHosts ? { importHosts } : {}),
  });
}

const photo = (id: string, url: string): ImportedPostNode => ({
  id,
  media_type: 1,
  image_versions2: { candidates: [{ url, width: 1440, height: 1800 }] },
});

function post(...urls: string[]): ImportRequest {
  return {
    url: POST,
    node: {
      code: 'DcOX3hWFiey',
      media_type: 8,
      user: { username: 'nasa', full_name: 'NASA' },
      caption: { text: 'Three pictures' },
      carousel_media: urls.map((url, index) => photo(`slide-${index}`, url)),
    },
  };
}

function refusal(run: () => unknown): SeraError {
  try {
    run();
  } catch (error) {
    return SeraError.from(error);
  }
  throw new Error('expected a refusal');
}

describe('an imported post', () => {
  it('offers every slide, named from the post', () => {
    const now = Date.now();
    const info = resolverWith().importSubmitted(post(cdn('a', now), cdn('b', now), cdn('c', now)));

    expect(info.provider).toBe('instagram');
    expect(info.type).toBe('collection');
    expect(info.title).toBe('Three pictures');
    expect(info.author).toBe('NASA');
    expect(info.items.map((item) => item.options.map((option) => option.label))).toEqual([
      ['Original'],
      ['Original'],
      ['Original'],
    ]);
    // Thumbnails reach the browser through the proxy, like every other resolution's.
    expect(info.items[0]!.thumbnail).toMatch(/^\/api\/thumb\//);
  });

  it('is checked against Instagram’s CDN unless something says otherwise', () => {
    expect(resolverWith().importHosts).toEqual(INSTAGRAM_MEDIA_HOSTS);
  });

  it('lives no longer than the links inside it', () => {
    const now = Date.now();
    const info = resolverWith().importSubmitted(
      post(cdn('a', now), cdn('b', now, 900)),
      undefined,
      now,
    );
    expect(info.expiresIn).toBe(900);
  });

  it('lives the ordinary option lifetime when the links outlast that', () => {
    const now = Date.now();
    const info = resolverWith().importSubmitted(post(cdn('a', now)), undefined, now);
    expect(info.expiresIn).toBe(3600);
  });

  it('gets only a short window when a link carries no expiry', () => {
    const now = Date.now();
    const unsigned = cdn('a', now).replace(/&oe=[0-9a-f]+/, '');
    const info = resolverWith().importSubmitted(post(unsigned), undefined, now);
    expect(info.expiresIn).toBe(600);
  });

  it('refuses links that have already run out, and says how to get fresh ones', () => {
    const now = Date.now();
    const error = refusal(() =>
      resolverWith().importSubmitted(post(cdn('a', now), cdn('b', now, -60)), undefined, now),
    );
    expect(error.code).toBe('EXPIRED');
    expect(error.hint).toBe('Open the post on Instagram again and send it to SERA again.');
  });
});

describe('what an import will not sign', () => {
  const now = Date.now();

  it.each([
    ['another host', 'https://evil.example/a.jpg'],
    ['a lookalike host', 'https://cdninstagram.com.evil.example/a.jpg'],
    ['a host that merely ends the same way', 'https://evilcdninstagram.com/a.jpg'],
    ['plain HTTP on the right host', 'http://scontent-vie1-1.cdninstagram.com/a.jpg'],
    ['a port on the right host', 'https://scontent-vie1-1.cdninstagram.com:8443/a.jpg'],
    ['credentials on the right host', 'https://user:pass@scontent-vie1-1.cdninstagram.com/a.jpg'],
    ['something that is not a URL', 'not a url'],
  ])('media on %s', (_, url) => {
    const error = refusal(() => resolverWith().importSubmitted(post(cdn('a', now), url)));
    expect(error.code).toBe('BLOCKED_ADDRESS');
    // The log is told which entry, and never what it said.
    expect(error.detail).toBe('import: url 1 is not on the media hosts');
  });

  it('checks the thumbnails too, because the proxy fetches them', () => {
    const request: ImportRequest = {
      url: POST,
      node: {
        code: 'DcOX3hWFiey',
        media_type: 2,
        video_versions: [
          { url: cdn('clip', now).replace('.jpg', '.mp4'), width: 720, height: 1280 },
        ],
        image_versions2: { candidates: [{ url: 'https://evil.example/cover.jpg', width: 720 }] },
      },
    };
    expect(refusal(() => resolverWith().importSubmitted(request)).code).toBe('BLOCKED_ADDRESS');
  });

  it('takes Instagram posts and nothing else', () => {
    const error = refusal(() =>
      resolverWith().importSubmitted({
        ...post(cdn('a', now)),
        url: 'https://x.com/NASA/status/2095585125627003244',
      }),
    );
    expect(error.code).toBe('UNSUPPORTED_SOURCE');
  });

  it('wants a single post, not a profile', () => {
    const error = refusal(() =>
      resolverWith().importSubmitted({
        ...post(cdn('a', now)),
        url: 'https://www.instagram.com/nasa/',
      }),
    );
    expect(error.code).toBe('UNSUPPORTED_SOURCE');
  });

  it('notices a post that is not the one in the link', () => {
    const error = refusal(() =>
      resolverWith().importSubmitted({
        ...post(cdn('a', now)),
        url: 'https://www.instagram.com/p/SomethingElse/',
      }),
    );
    expect(error.code).toBe('INVALID_URL');
  });

  it('refuses more slides than one download may carry', () => {
    const error = refusal(() =>
      resolverWith({ SERA_MAX_ITEMS_PER_JOB: '2' }).importSubmitted(
        post(cdn('a', now), cdn('b', now), cdn('c', now)),
      ),
    );
    expect(error.code).toBe('TOO_LARGE');
  });

  it('refuses to mint a token too long to come back', () => {
    const padded = Array.from(
      { length: 30 },
      (_, index) => `${cdn(`slide-${index}`, now)}&pad=${'x'.repeat(1_800)}`,
    );
    const error = refusal(() => resolverWith().importSubmitted(post(...padded)));
    expect(error.code).toBe('TOO_LARGE');
    expect(error.detail).toMatch(/^import: a resolution token of \d+ characters$/);
  });

  it('says a post with nothing downloadable has nothing downloadable', () => {
    const error = refusal(() =>
      resolverWith().importSubmitted({ url: POST, node: { code: 'DcOX3hWFiey', media_type: 1 } }),
    );
    expect(error.code).toBe('MEDIA_UNAVAILABLE');
  });
});

describe('the token an import is signed into', () => {
  const now = Date.now();
  const entry: ImportedEntry = {
    s: 'slide-0',
    kind: 'image',
    url: cdn('a', now),
    container: 'jpg',
  };

  it('cannot be edited to name different media', () => {
    const resolver = resolverWith();
    const info = resolver.importSubmitted(post(cdn('a', now)));
    const [body, signature] = info.id.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
      m: { url: string }[];
    };
    payload.m[0]!.url = cdn('something-else', now);
    const edited = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    const error = refusal(() => resolver.verifyInfoId(edited));
    expect(error.code).toBe('EXPIRED');
    expect(error.detail).toBe('bad token signature');
  });

  it('identifies the media it approved, not only the link', () => {
    const resolver = resolverWith();
    const hashOf = (infoId: string) => {
      const payload = resolver.verifyInfoId(infoId);
      return resolver.resolutionHash(payload.u, payload.p, payload.m);
    };
    const first = resolver.importSubmitted(post(cdn('a', now)));
    const other = resolver.importSubmitted(post(cdn('b', now)));
    const same = resolver.importSubmitted(post(cdn('a', now)));

    expect(hashOf(first.id)).not.toBe(hashOf(other.id));
    expect(hashOf(first.id)).toBe(hashOf(same.id));
    // And never the resolution the same link gets when it is analyzed the ordinary way.
    const { u, p } = resolver.verifyInfoId(first.id);
    expect(hashOf(first.id)).not.toBe(resolver.resolutionHash(u, p));
  });

  it('says how to refresh an expired import, which analyzing the link again cannot do', () => {
    const resolver = resolverWith();
    const lapsed = signToken(
      { u: POST, p: 'instagram', o: 'visitor', m: [entry], t: 'A post' },
      resolver.config.secret,
      -10,
    );
    const error = refusal(() => resolver.verifyInfoId(lapsed));
    expect(error.code).toBe('EXPIRED');
    expect(error.hint).toBe('Open the post on Instagram again and send it to SERA again.');
  });

  it('refuses a signed import in a shape this server does not make', () => {
    const resolver = resolverWith();
    const odd = signToken(
      {
        u: POST,
        p: 'instagram',
        o: 'visitor',
        m: [{ ...entry, kind: 'document', container: 'exe' }],
        t: 'A post',
      },
      resolver.config.secret,
      60,
    );
    expect(refusal(() => resolver.verifyInfoId(odd)).detail).toBe('malformed import token');
  });

  it('stops being spendable when the host list tightens after it was made', () => {
    const loose = resolverWith(
      {},
      { hosts: ['cdninstagram.com', 'example.org'], requireHttps: true },
    );
    const info = loose.importSubmitted(
      post(`https://media.example.org/a.jpg?oe=${hex(now / 1000 + 3_600)}`),
    );
    const strict = new MediaResolver({ config: loose.config, logger: silentLogger() });
    expect(refusal(() => strict.verifyInfoId(info.id)).code).toBe('BLOCKED_ADDRESS');
  });
});
