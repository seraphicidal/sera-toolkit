import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { buildCspHeader } from './lib/csp';

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64');
  const csp = buildCspHeader({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        '/((?!api/|_next/static|_next/image|favicon\\.ico|icon\\.svg|icons/|manifest\\.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
