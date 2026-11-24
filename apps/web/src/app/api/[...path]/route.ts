import type { NextRequest } from 'next/server';
import { proxyToBackend, resolveSafeApiPath } from '@/lib/backend-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly path: readonly string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const resolved = resolveSafeApiPath(path, request.method);
  if (!resolved.ok) {
    const headers = resolved.allow ? { allow: resolved.allow.join(', ') } : undefined;
    return Response.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: resolved.status === 405 ? 'Method not allowed.' : 'Not found.',
          retryable: false,
        },
      },
      { status: resolved.status, ...(headers ? { headers } : {}) },
    );
  }
  return proxyToBackend(request, resolved.path);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const HEAD = handle;
