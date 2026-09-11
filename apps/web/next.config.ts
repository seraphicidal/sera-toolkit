import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * The API is reached through a rewrite rather than from the browser directly.
 *
 * That makes every request same-origin: no CORS configuration to get wrong, no preflight
 * on the hot path, and — the reason that matters most here — the visitor's browser never
 * opens a connection to the media backend or to any platform CDN. A strict CSP can then
 * forbid outbound connections entirely.
 */
const apiOrigin = (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const csp = [
  "default-src 'self'",
  // Next's inline bootstrap needs 'unsafe-inline'; nothing evaluates strings.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Thumbnails are proxied through the API, so no third-party image host is needed.
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
  // A self-contained server bundle, so the container does not ship node_modules.
  output: 'standalone',
  // fileURLToPath, not URL.pathname: on Windows the latter yields `/C:/…`, which is not
  // a path any filesystem call will accept.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  // Not `async`: there is nothing to await, and Next accepts a promise either way.
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
          // Two years, subdomains included. Harmless over plain HTTP in development
          // because browsers ignore HSTS on non-secure origins.
          {
            key: 'strict-transport-security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
      {
        // /import is opened as a popup by a bookmarklet on instagram.com and talks back to it
        // over postMessage. Under the site-wide `same-origin` above, opening a cross-origin
        // popup switches browsing-context groups and the popup's `window.opener` comes up null,
        // so no message can flow — verified in a real browser across all three policies. Only
        // `unsafe-none` keeps the opener, and Next lets the later matching rule win for this one
        // key while every other header above still applies. It is the narrowest exception that
        // makes the handshake possible, on a page that holds no state of its own.
        source: '/import',
        headers: [{ key: 'cross-origin-opener-policy', value: 'unsafe-none' }],
      },
    ]);
  },
};

export default nextConfig;
