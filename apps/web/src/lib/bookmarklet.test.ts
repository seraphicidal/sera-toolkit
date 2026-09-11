import { describe, expect, it } from 'vitest';
import { buildBookmarklet } from './bookmarklet';
import { FRAGMENT_VERSION } from './import-handshake';

/**
 * The bookmarklet is a string that becomes code in someone else's browser, so the things worth
 * pinning are the ones that would fail silently: that it targets the right SERA origin, hands the
 * post over the way /import reads it, loads and evaluates no code, and decodes a shortcode to the
 * id Instagram actually uses.
 *
 * Transport v2: it navigates the same tab to `/import#v=2&p=…` instead of opening a popup and
 * posting a message. The absence of `window.open`/`postMessage` is asserted deliberately — that
 * is what makes it work on iOS Safari and behind cross-origin COOP.
 */

describe('buildBookmarklet', () => {
  const origin = 'https://sera.example';
  const href = buildBookmarklet(origin);
  const source = decodeURIComponent(href.replace(/^javascript:/, ''));

  it('is a self-contained javascript: URL', () => {
    expect(href.startsWith('javascript:')).toBe(true);
    expect(source).not.toMatch(/import\s+[\w{*]|\brequire\(|createElement\(['"]script/);
  });

  it('loads no code and evaluates nothing — the whole trust boundary', () => {
    // It runs on instagram.com with the visitor's session. If it could pull or run code from
    // SERA, a compromised SERA server would be a compromise of every user's Instagram account.
    expect(source).not.toMatch(
      /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimport\s*\(|importScripts|document\.write|inner(HTML|Text)|outerHTML|insertAdjacent|\bsrc\s*=|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/,
    );
  });

  it('opens no popup and posts no message — it navigates the same tab', () => {
    // The v1 mechanism the phones rejected. Its absence is the point of v2.
    expect(source).not.toMatch(/window\.open|\.postMessage|addEventListener\(\s*['"]message/);
  });

  it('hands the post to /import in the URL fragment the page reads', () => {
    expect(source).toContain(`'/import#v='+"${FRAGMENT_VERSION}"+'&p='`);
    expect(source).toContain('location.href=SERA+');
    expect(source).toContain('encodeURIComponent(JSON.stringify(payload))');
  });

  it('makes its one request to Instagram, never to the SERA origin', () => {
    expect((source.match(/\bfetch\s*\(/g) ?? []).length).toBe(1);
    expect(source).toContain("fetch('/api/v1/media/'+");
    expect(source).not.toMatch(/fetch\s*\(\s*SERA|fetch\s*\(\s*['"]https?:/);
    // The SERA origin is only ever a navigation target, never used to build a URL that loads code.
    expect(source).toContain('location.href=SERA+');
    expect(source).not.toMatch(/(?:src|href)\s*=\s*[^;]*SERA\s*\+\s*[^;]*\.(?:js|json)\b/);
  });

  it('sends only to the SERA origin it was built for, with no trailing slash', () => {
    const trimmed = decodeURIComponent(
      buildBookmarklet('https://sera.example/').replace(/^javascript:/, ''),
    );
    expect(trimmed).toContain('var SERA="https://sera.example";');
    expect(trimmed).not.toContain('sera.example/"');
  });

  it('reads the media-info endpoint with the web app id and the session cookie', () => {
    expect(source).toContain('\'x-ig-app-id\':"936619743392459"');
    expect(source).toContain("credentials:'include'");
  });

  it('trims each slide to its widest rendition, keeping the payload small enough for a URL', () => {
    // Sending every candidate size would bloat the fragment; the server only ever offers the
    // widest, so one per slide is all that travels.
    expect(source).toContain('function widest(');
    expect(source).toContain('out.image_versions2={candidates:[img]}');
    expect(source).toContain('out.video_versions=[vid]');
  });

  it('carries a shortcode→id decode that matches Instagram’s own numbering', () => {
    expect(source).toContain("'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'");
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let pk = 0n;
    for (const ch of 'DcOX3hWFiey') pk = pk * 64n + BigInt(alphabet.indexOf(ch));
    expect(pk.toString()).toBe('3967213292204992434');
  });

  it('only fires on a single post, not a profile or the feed', () => {
    expect(source).toContain('(?:p|reel|reels|tv)');
    expect(source).toContain('location.pathname.match');
  });
});
