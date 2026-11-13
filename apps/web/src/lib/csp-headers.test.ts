import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

interface HeaderRule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

async function rules(): Promise<HeaderRule[]> {
  return nextConfig.headers!();
}

const keys = (rule: HeaderRule) => rule.headers.map((h) => h.key).sort();
const value = (rule: HeaderRule, key: string) => rule.headers.find((h) => h.key === key)?.value;

describe('the site-wide COOP policy', () => {
  it('does not relax COOP for /import or any other route', async () => {
    const importRules = (await rules()).filter((r) => r.source.includes('/import'));
    expect(importRules).toEqual([]);
  });

  it('enforces the site-wide security headers, including same-origin COOP', async () => {
    const site = (await rules()).find((r) => r.source === '/:path*')!;
    expect(site).toBeDefined();
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
});

describe('the installable app under the site-wide policy', () => {
  const directive = (csp: string, name: string) =>
    csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `));

  it('adds no header rule beyond the site rule', async () => {
    expect((await rules()).map((r) => r.source)).toEqual(['/:path*']);
  });

  it('serves the manifest, icons and /share under the strict policy, with nothing relaxed', async () => {
    const csp = value(
      (await rules()).find((r) => r.source === '/:path*')!,
      'content-security-policy',
    )!;
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

describe('the /api rewrite', () => {
  it('waits long enough for a slow resolve, rather than answering 500 after 30 s', () => {
    expect(nextConfig.experimental?.proxyTimeout).toBeGreaterThanOrEqual(120_000);
  });
});
