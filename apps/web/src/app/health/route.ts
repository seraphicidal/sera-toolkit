import type { NextRequest } from 'next/server';
import { proxyToBackend } from '@/lib/backend-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: NextRequest): Promise<Response> {
  return proxyToBackend(request, '/health');
}

export function HEAD(request: NextRequest): Promise<Response> {
  return proxyToBackend(request, '/health');
}
