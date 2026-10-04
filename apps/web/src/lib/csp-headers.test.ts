import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

/**
 * The one place a security header is relaxed, and the guard that it stays one place.
 *
 * `/import` is served `Cross-Origin-Opener-Policy: unsafe-none` so a bookmarklet-opened popup
 * keeps its `window.opener` and the handshake can run — verified in a real browser to be the
 * only policy that works. This asserts the relaxation is scoped to exactly `/import`, changes
 * only that one header, and leaves every other security header (and every other path) untouched.
 * If someone widens the `source` to `/import/:path*` or drops a header, this fails.
 */

interface HeaderRule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

async function rules(): Promise<HeaderRule[]> {
  return nextConfig.headers!();
}

const keys = (rule: HeaderRule) => rule.headers.map((h) => h.key).sort();
const value = (rule: HeaderRule, key: string) => rule.headers.find((h) => h.key === key)?.value;

describe('the /import COOP exception', () => {
  it('is scoped to exactly /import, and nothing broader', async () => {
    const importRules = (await rules()).filter((r) => r.source.includes('/import'));
    // Not /import*, not /import/:path*, not /importer — the exact path only.
    expect(importRules.map((r) => r.source)).toEqual(['/import']);
  });

  it('changes only the opener policy, and only to unsafe-none', async () => {
    const rule = (await rules()).find((r) => r.source === '/import')!;
    expect(keys(rule)).toEqual(['cross-origin-opener-policy']);
    expect(value(rule, 'cross-origin-opener-policy')).toBe('unsafe-none');
  });

  it('leaves the site-wide security headers in force, including the default same-origin COOP', async () => {
    const site = (await rules()).find((r) => r.source === '/:path*')!;
    expect(site).toBeDefined();
    // The full set the whole site gets, /import included, before the one override.
    for (const key of [
      'content-security-policy',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
      'permissions-policy',
      'cross-origin-opener-policy',
      'strict-transport-security',
    ]) {
      expect(keys(site), key).toContain(key);
    }
    expect(value(site, 'cross-origin-opener-policy')).toBe('same-origin');
  });

  it('applies the override after the site rule, so the later rule wins for that key', async () => {
    // Next merges matching rules and the last one wins per key; order is what makes the
    // override effective rather than shadowed.
    const all = await rules();
    const site = all.findIndex((r) => r.source === '/:path*');
    const imp = all.findIndex((r) => r.source === '/import');
    expect(site).toBeGreaterThanOrEqual(0);
    expect(imp).toBeGreaterThan(site);
  });
});

/**
 * The installable app adds a manifest, icons and a share target. None of it gets a header
 * of its own: it is all same-origin, so the strict site-wide policy already allows it, and
 * a relaxation added "to make the PWA work" would be one nobody needed.
 */
describe('the installable app under the site-wide policy', () => {
  const directive = (csp: string, name: string) =>
    csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `));

  it('adds no header rule beyond the site rule and the /import exception', async () => {
    expect((await rules()).map((r) => r.source)).toEqual(['/:path*', '/import']);
  });

  it('serves the manifest, icons and /share under the strict policy, with nothing relaxed', async () => {
    const csp = value(
      (await rules()).find((r) => r.source === '/:path*')!,
      'content-security-policy',
    )!;
    // No manifest-src or worker-src of its own: both fall back to default-src 'self'.
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'manifest-src')).toBeUndefined();
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('names only same-origin paths in the manifest, and shares into /share', async () => {
    const { default: manifest } = await import('../app/manifest');
    const m = manifest();
    const paths = [
      m.start_url,
      m.scope,
      ...(m.icons ?? []).map((icon) => icon.src),
      m.share_target?.action,
    ];
    for (const path of paths) expect(path, String(path)).toMatch(/^\/(?!\/)/);
    expect(m.share_target).toMatchObject({ action: '/share', method: 'GET' });
    expect(m.icons?.map((icon) => `${icon.sizes ?? ''} ${icon.purpose ?? ''}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });
});
