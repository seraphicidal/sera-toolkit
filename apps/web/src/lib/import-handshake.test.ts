import { describe, expect, it } from 'vitest';
import { FRAGMENT_VERSION, PAYLOAD, readImportFragment, trustedImport } from './import-handshake';

/**
 * The gate on the /import handshake, tested as pure input.
 *
 * The DOM plumbing around it is thin; what earns a test is the decision of whose post to
 * believe, because getting it wrong would let any page that can reach this window choose what
 * SERA fetches.
 */

const opener = { name: 'opener' } as unknown as Window;
const post = {
  type: PAYLOAD,
  url: 'https://www.instagram.com/p/DcOX3hWFiey/',
  node: { code: 'DcOX3hWFiey', media_type: 1 },
};

/** A MessageEvent stand-in; jsdom is not loaded, and only these three fields are read. */
const event = (over: { origin?: string; source?: unknown; data?: unknown }): MessageEvent =>
  ({
    origin: over.origin ?? 'https://www.instagram.com',
    source: 'source' in over ? over.source : opener,
    data: 'data' in over ? over.data : post,
  }) as MessageEvent;

describe('trustedImport', () => {
  it('accepts a post from the opener on instagram.com', () => {
    expect(trustedImport(event({}), opener)).toEqual({ url: post.url, node: post.node });
    expect(trustedImport(event({ origin: 'https://instagram.com' }), opener)).toBeDefined();
  });

  it('ignores a message from any other origin', () => {
    for (const origin of [
      'https://instagram.com.evil.example',
      'http://www.instagram.com',
      'https://www.example.com',
      'null',
    ]) {
      expect(trustedImport(event({ origin }), opener), origin).toBeUndefined();
    }
  });

  it('ignores a message from a window that is not the opener', () => {
    expect(trustedImport(event({ source: { name: 'someone-else' } }), opener)).toBeUndefined();
    // And when there is no opener at all, nothing is ever trusted.
    expect(trustedImport(event({}), null)).toBeUndefined();
  });

  it('ignores anything that is not a well-formed post', () => {
    expect(
      trustedImport(event({ data: { type: 'something-else', url: post.url, node: {} } }), opener),
    ).toBeUndefined();
    expect(
      trustedImport(event({ data: { type: PAYLOAD, url: 42, node: {} } }), opener),
    ).toBeUndefined();
    expect(
      trustedImport(event({ data: { type: PAYLOAD, url: post.url } }), opener),
    ).toBeUndefined();
    expect(
      trustedImport(event({ data: { type: PAYLOAD, url: post.url, node: [] } }), opener),
    ).toBeUndefined();
    expect(trustedImport(event({ data: undefined }), opener)).toBeUndefined();
  });
});

/**
 * Transport v2: the post arrives in the URL fragment instead of over a popup message. The reader
 * must accept a well-formed one, refuse anything else, and — every time — clear the fragment from
 * history so the signed media links it carries do not linger in the URL.
 */
describe('readImportFragment', () => {
  const POST = 'https://www.instagram.com/p/DcOX3hWFiey/';
  const cdn = 'https://scontent-vie1-1.cdninstagram.com/v/t51/x.jpg?oe=6AAA5674';
  const image = (url: string) => ({
    url: POST,
    node: { code: 'DcOX3hWFiey', media_type: 1, image_versions2: { candidates: [{ url }] } },
  });
  const onCdn = image(cdn);
  const noMedia = { url: POST, node: { code: 'DcOX3hWFiey', media_type: 1 } };
  const frag = (payload: unknown) =>
    `#v=${FRAGMENT_VERSION}&p=${encodeURIComponent(JSON.stringify(payload))}`;

  function windowWith(hash: string): { win: Window; replacedTo: () => string | undefined } {
    const replaced: string[] = [];
    const win = {
      location: { hash, pathname: '/import', search: '' },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
    } as unknown as Window;
    return { win, replacedTo: () => replaced.at(-1) };
  }

  it('reads an on-CDN post and clears the fragment from history', () => {
    const { win, replacedTo } = windowWith(frag(onCdn));
    expect(readImportFragment(win)).toEqual({ ok: true, request: onCdn });
    // The hash is gone from the current history entry.
    expect(replacedTo()).toBe('/import');
    // fbcdn.net is admitted too.
    expect(
      readImportFragment(windowWith(frag(image('https://instagram.xx.fbcdn.net/v/a.mp4'))).win),
    ).toEqual({ ok: true, request: image('https://instagram.xx.fbcdn.net/v/a.mp4') });
  });

  it('admits a post with no media URLs — the server decides it is empty, it is not an abuse vector', () => {
    expect(readImportFragment(windowWith(frag(noMedia)).win)).toEqual({
      ok: true,
      request: noMedia,
    });
  });

  it('refuses (ok:false) a post whose media is not on Instagram’s CDN, so nothing is POSTed', () => {
    for (const bad of [
      'https://evil.example/x.jpg',
      'http://scontent.cdninstagram.com/x.jpg', // not https
      'https://scontent.cdninstagram.com:8443/x.jpg', // a port
      'https://user:pw@scontent.cdninstagram.com/x.jpg', // credentials
      'https://cdninstagram.com.evil.example/x.jpg', // lookalike host
      'not-a-url',
    ]) {
      expect(readImportFragment(windowWith(frag(image(bad))).win), bad).toEqual({ ok: false });
    }
  });

  it('checks video and nested carousel URLs, not only the first image', () => {
    const mixed = {
      url: POST,
      node: {
        code: 'DcOX3hWFiey',
        media_type: 8,
        carousel_media: [
          { media_type: 1, image_versions2: { candidates: [{ url: cdn }] } },
          { media_type: 2, video_versions: [{ url: 'https://evil.example/v.mp4' }] },
        ],
      },
    };
    expect(readImportFragment(windowWith(frag(mixed)).win)).toEqual({ ok: false });
  });

  it('refuses an oversized fragment before decoding it, and still clears it', () => {
    const { win, replacedTo } = windowWith(`#v=${FRAGMENT_VERSION}&p=${'A'.repeat(70_000)}`);
    expect(readImportFragment(win)).toBeUndefined();
    expect(replacedTo()).toBe('/import');
  });

  it('ignores a fragment that is not this transport version', () => {
    expect(
      readImportFragment(windowWith(`#v=1&p=${encodeURIComponent('{}')}`).win),
    ).toBeUndefined();
    expect(readImportFragment(windowWith('#something-else').win)).toBeUndefined();
    expect(readImportFragment(windowWith('').win)).toBeUndefined();
  });

  it('refuses a malformed payload but still clears it from history', () => {
    const { win, replacedTo } = windowWith(`#v=${FRAGMENT_VERSION}&p=%7Bnot-json`);
    expect(readImportFragment(win)).toBeUndefined();
    expect(replacedTo()).toBe('/import');
  });

  it('refuses a payload that is not shaped like a post', () => {
    for (const bad of [{ url: 42, node: {} }, { url: POST }, { url: POST, node: [] }, {}]) {
      expect(readImportFragment(windowWith(frag(bad)).win), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
