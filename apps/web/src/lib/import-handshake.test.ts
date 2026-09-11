import { describe, expect, it } from 'vitest';
import { PAYLOAD, trustedImport } from './import-handshake';

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
