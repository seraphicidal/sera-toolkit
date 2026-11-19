import type { NextRequest } from 'next/server';
import { proxyToBackend } from '@/lib/backend-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly path: readonly string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const encoded = path.map((segment) => encodeURIComponent(segment)).join('/');
  return proxyToBackend(request, `/api/${encoded}`);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
