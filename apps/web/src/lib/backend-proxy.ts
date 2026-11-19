import type { NextRequest } from 'next/server';

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
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

export function getApiOrigin(): string {
  return (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

function forwardRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  const connectionNominated = new Set(
    (request.headers.get('connection') ?? '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );

  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower) || connectionNominated.has(lower)) return;
    headers.set(key, value);
  });

  // Ensure API streams uncompressed payloads so Content-Length / Range / SSE chunks stay unmodified.
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
  const targetUrl = `${getApiOrigin()}${targetPath}${request.nextUrl.search}`;
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
    const upstream = await fetch(targetUrl, init);
    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: forwardResponseHeaders(upstream.headers),
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const detail = error instanceof Error ? error.message : 'Upstream API unreachable';
    return Response.json(
      {
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: "The API didn't answer in time.",
          hint: detail,
          retryable: true,
        },
      },
      { status: 502 },
    );
  }
}
