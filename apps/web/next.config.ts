import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const apiOrigin = (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  experimental: {
    isrFlushToDisk: false,
    proxyTimeout: 180_000,
  },
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/health', destination: `${apiOrigin}/health` },
      { source: '/ready', destination: `${apiOrigin}/ready` },
    ]);
  },

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
      {
        source: '/import',
        headers: [{ key: 'cross-origin-opener-policy', value: 'unsafe-none' }],
      },
    ]);
  },
};

export default nextConfig;
