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
