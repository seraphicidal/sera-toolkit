import type { NextRequest } from 'next/server';

const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'origin',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export type SafeApiPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly status: 404 | 405; readonly allow?: readonly string[] };

function isUnsafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return true;
  if (/[/\\\u0000-\u001f\u007f]/.test(segment)) return true;
  try {
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function allowedMethodsForApiRoute(segments: readonly string[]): readonly string[] | undefined {
  const [first, second, third, fourth] = segments;
  if (segments.length === 1 && first === 'info') return ['GET', 'HEAD'];
  if (segments.length === 2 && first === 'media' && (second === 'info' || second === 'import')) {
    return ['POST'];
  }
  if (segments.length === 3 && first === 'media' && second === 'thumbnail' && third) {
    return ['GET', 'HEAD'];
  }
  if (segments.length === 2 && first === 'thumb' && second) {
    return ['GET', 'HEAD'];
  }
  if (segments.length === 1 && first === 'jobs') return ['POST'];
  if (segments.length === 2 && first === 'jobs' && second) return ['GET', 'HEAD', 'DELETE'];
  if (segments.length === 3 && first === 'jobs' && second && third === 'events') return ['GET'];
  if (segments.length === 3 && first === 'jobs' && second && third === 'download') {
    return ['GET', 'HEAD'];
  }
  if (segments.length === 4 && first === 'jobs' && second && third === 'files' && fourth) {
    return ['GET', 'HEAD'];
  }
  if (segments.length === 2 && first === 'legal' && second === 'report') return ['POST'];
  return undefined;
}

export function resolveSafeApiPath(segments: readonly string[], method: string): SafeApiPathResult {
  if (!segments.length || segments.some(isUnsafeSegment)) {
    return { ok: false, status: 404 };
  }
  const allowed = allowedMethodsForApiRoute(segments);
  if (!allowed) {
    return { ok: false, status: 404 };
  }
  const upperMethod = method.toUpperCase();
  if (!allowed.includes(upperMethod)) {
    return { ok: false, status: 405, allow: allowed };
  }
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  const path = `/api/${encoded}`;
  const normalized = new URL(path, 'http://sera.internal').pathname;
  if (normalized !== path || !normalized.startsWith('/api/')) {
    return { ok: false, status: 404 };
  }
  return { ok: true, path };
}

export function getApiOrigin(): string {
  return (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

function forwardRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) return;
    headers.set(key, value);
  });

  headers.set('accept-encoding', 'identity');
  return headers;
}

function forwardResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  const connectionNominated = new Set(
    (upstream.get('connection') ?? '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );

  upstream.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || connectionNominated.has(lower)) return;
    headers.append(key, value);
  });

  return headers;
}

export async function proxyToBackend(request: NextRequest, targetPath: string): Promise<Response> {
  if (!targetPath.startsWith('/') || targetPath.startsWith('//')) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false } },
      { status: 404 },
    );
  }
  const origin = getApiOrigin();
  const originUrl = new URL(origin);
  const resolved = new URL(`${targetPath}${request.nextUrl.search}`, originUrl);
  if (resolved.origin !== originUrl.origin || resolved.pathname !== targetPath) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false } },
      { status: 404 },
    );
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;

  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers: forwardRequestHeaders(request),
      redirect: 'manual',
      cache: 'no-store',
      signal: request.signal,
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
    };
    const upstream = await fetch(resolved.toString(), init);
    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: forwardResponseHeaders(upstream.headers),
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error('[sera-web] upstream proxy error', error);
    return Response.json(
      {
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: "The API didn't answer in time.",
          hint: 'Please try again in a moment.',
          retryable: true,
        },
      },
      { status: 502 },
    );
  }
}
