import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { buildCspHeader } from './src/lib/csp';

const csp = buildCspHeader();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  experimental: {
    isrFlushToDisk: false,
    proxyTimeout: 600_000,
  },
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'content-security-policy', value: csp },
          { key: 'referrer-policy', value: 'no-referrer' },
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'x-frame-options', value: 'DENY' },
          {
            key: 'permissions-policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          { key: 'cross-origin-opener-policy', value: 'same-origin' },
          {
            key: 'strict-transport-security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
    ]);
  },
};

export default nextConfig;
