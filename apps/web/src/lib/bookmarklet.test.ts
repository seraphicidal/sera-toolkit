import { describe, expect, it } from 'vitest';
import { buildBookmarklet } from './bookmarklet';
import { PAYLOAD, READY } from './import-handshake';

/**
 * The bookmarklet is a string that becomes code in someone else's browser, so the things worth
 * pinning are the ones that would fail silently: that it targets the right SERA origin, speaks
 * the same handshake the /import page listens for, and decodes a shortcode to the id Instagram
 * actually uses.
 */

describe('buildBookmarklet', () => {
  const origin = 'https://sera.example';
  const href = buildBookmarklet(origin);
  const source = decodeURIComponent(href.replace(/^javascript:/, ''));

  it('is a self-contained javascript: URL', () => {
    expect(href.startsWith('javascript:')).toBe(true);
    // No module import, no require, no injected <script> — instagram.com's CSP blocks a
    // loaded script, and a bookmarklet is exempt only while it stays inline. ("/import" and
    // "sera-import-*" are strings, not an import statement, so the guard is deliberately narrow.)
    expect(source).not.toMatch(/import\s+[\w{*]|\brequire\(|createElement\(['"]script/);
  });

  it('loads no code and evaluates nothing — the whole trust boundary', () => {
    // It runs on instagram.com with the visitor's session. If it could pull or run code from
    // SERA, a compromised SERA server would be a compromise of every user's Instagram account.
    // So: no eval, no Function constructor, no dynamic import, no script injection, no writing
    // markup, and no scheduling a string.
    expect(source).not.toMatch(
      /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimport\s*\(|importScripts|document\.write|inner(HTML|Text)|outerHTML|insertAdjacent|\bsrc\s*=|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/,
    );
  });

  it('makes its one request to Instagram, never to the SERA origin', () => {
    // The single fetch reads Instagram's own media-info endpoint, same-origin on instagram.com,
    // for DATA. Nothing is ever fetched from SERA — SERA only receives, over postMessage.
    expect((source.match(/\bfetch\s*\(/g) ?? []).length).toBe(1);
    expect(source).toContain("fetch('/api/v1/media/'+");
    expect(source).not.toMatch(/fetch\s*\(\s*SERA|fetch\s*\(\s*['"]https?:/);
    // The SERA origin is used only as a window.open target, a postMessage targetOrigin, and the
    // origin the reply is checked against — never to build a URL that fetches or loads code.
    expect(source).toContain("window.open(SERA+'/import'");
    expect(source).toContain(',SERA)'); // postMessage targetOrigin
    expect(source).toContain('e.origin===SERA');
    expect(source).not.toMatch(/(?:src|href)\s*=\s*[^;]*SERA|SERA\s*\+\s*[^;]*\.(?:js|json)\b/);
  });

  it('sends only to the SERA origin it was built for, with no trailing slash', () => {
    const trimmed = decodeURIComponent(
      buildBookmarklet('https://sera.example/').replace(/^javascript:/, ''),
    );
    expect(trimmed).toContain('var SERA="https://sera.example";');
    expect(trimmed).not.toContain('sera.example/"');
  });

  it('speaks the same handshake the /import page listens for', () => {
    expect(source).toContain(JSON.stringify(READY));
    expect(source).toContain(JSON.stringify(PAYLOAD));
  });

  it('reads the media-info endpoint once, with the web app id and the session cookie', () => {
    expect(source).toContain('\'x-ig-app-id\':"936619743392459"');
    expect(source).toContain("credentials:'include'");
    expect((source.match(/fetch\(/g) ?? []).length).toBe(1);
  });

  it('carries a shortcode→id decode that matches Instagram’s own numbering', () => {
    // The alphabet and base the bookmarklet uses, run here against a known post: the same pk
    // Instagram's oEmbed returns for /p/DcOX3hWFiey/ (…_528817151).
    expect(source).toContain("'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'");
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let pk = 0n;
    for (const ch of 'DcOX3hWFiey') pk = pk * 64n + BigInt(alphabet.indexOf(ch));
    expect(pk.toString()).toBe('3967213292204992434');
  });

  it('only fires on a single post, not a profile or the feed', () => {
    // The path guard the bookmarklet applies before doing anything.
    expect(source).toContain('(?:p|reel|reels|tv)');
    expect(source).toContain('location.pathname.match');
  });
});
