import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiOrigin, proxyToBackend, resolveSafeApiPath } from './backend-proxy';

describe('resolveSafeApiPath', () => {
  it('allows public web API routes with their permitted HTTP methods', () => {
    expect(resolveSafeApiPath(['info'], 'GET')).toEqual({ ok: true, path: '/api/info' });
    expect(resolveSafeApiPath(['info'], 'HEAD')).toEqual({ ok: true, path: '/api/info' });
    expect(resolveSafeApiPath(['media', 'info'], 'POST')).toEqual({
      ok: true,
      path: '/api/media/info',
    });
    expect(resolveSafeApiPath(['media', 'import'], 'POST')).toEqual({
      ok: true,
      path: '/api/media/import',
    });
    expect(resolveSafeApiPath(['thumb', 'tok_123'], 'GET')).toEqual({
      ok: true,
      path: '/api/thumb/tok_123',
    });
    expect(resolveSafeApiPath(['media', 'thumbnail', 'tok_123'], 'GET')).toEqual({
      ok: true,
      path: '/api/media/thumbnail/tok_123',
    });
    expect(resolveSafeApiPath(['jobs'], 'POST')).toEqual({ ok: true, path: '/api/jobs' });
    expect(resolveSafeApiPath(['jobs', 'abc123'], 'GET')).toEqual({
      ok: true,
      path: '/api/jobs/abc123',
    });
    expect(resolveSafeApiPath(['jobs', 'abc123'], 'DELETE')).toEqual({
      ok: true,
      path: '/api/jobs/abc123',
    });
    expect(resolveSafeApiPath(['jobs', 'abc123', 'events'], 'GET')).toEqual({
      ok: true,
      path: '/api/jobs/abc123/events',
    });
    expect(resolveSafeApiPath(['jobs', 'abc123', 'download'], 'GET')).toEqual({
      ok: true,
      path: '/api/jobs/abc123/download',
    });
    expect(resolveSafeApiPath(['jobs', 'abc123', 'files', 'video 1.mp4'], 'GET')).toEqual({
      ok: true,
      path: '/api/jobs/abc123/files/video%201.mp4',
    });
    expect(resolveSafeApiPath(['legal', 'report'], 'POST')).toEqual({
      ok: true,
      path: '/api/legal/report',
    });
  });

  it('rejects path traversal, dot segments, encoded traversal, admin routes, and internal escapes', () => {
    expect(resolveSafeApiPath(['..', 'internal', 'extraction', 'nodes'], 'GET')).toEqual({
      ok: false,
      status: 404,
    });
    expect(resolveSafeApiPath(['%2e%2e', 'internal', 'extraction', 'nodes'], 'GET')).toEqual({
      ok: false,
      status: 404,
    });
    expect(resolveSafeApiPath(['jobs', '..', '..', 'admin', 'reports'], 'GET')).toEqual({
      ok: false,
      status: 404,
    });
    expect(resolveSafeApiPath(['.'], 'GET')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath([''], 'GET')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath(['admin', 'usage'], 'GET')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath(['admin', 'reports'], 'GET')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath(['admin', 'denylist'], 'POST')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath(['jobs', 'abc/def'], 'GET')).toEqual({ ok: false, status: 404 });
    expect(resolveSafeApiPath(['jobs', 'abc\\def'], 'GET')).toEqual({ ok: false, status: 404 });
  });

  it('rejects disallowed HTTP methods on valid routes with 405', () => {
    expect(resolveSafeApiPath(['info'], 'POST')).toEqual({
      ok: false,
      status: 405,
      allow: ['GET', 'HEAD'],
    });
    expect(resolveSafeApiPath(['jobs'], 'GET')).toEqual({
      ok: false,
      status: 405,
      allow: ['POST'],
    });
    expect(resolveSafeApiPath(['jobs', 'abc123'], 'PUT')).toEqual({
      ok: false,
      status: 405,
      allow: ['GET', 'HEAD', 'DELETE'],
    });
  });
});

describe('backend-proxy runtime routing', () => {
  const originalUrl = process.env.SERA_API_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SERA_API_URL;
    else process.env.SERA_API_URL = originalUrl;
    vi.restoreAllMocks();
  });

  it('enforces a strict request-header allowlist, resists Connection header stripping, and forces identity encoding', async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    let seenUrl = '';
    const srv = createServer((req, res) => {
      seenHeaders = req.headers;
      seenUrl = req.url ?? '';
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'keep-alive',
        'x-upstream': 'ok',
      });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()));
    const port = (srv.address() as { port: number }).port;

    try {
      process.env.SERA_API_URL = `http://127.0.0.1:${port}/`;
      expect(getApiOrigin()).toBe(`http://127.0.0.1:${port}`);

      const req = new NextRequest(`http://localhost:3000/api/info?v=1`, {
        headers: {
          'accept-encoding': 'br, gzip',
          accept: 'application/json',
          connection: 'x-forwarded-for, x-real-ip, cf-connecting-ip, forwarded',
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '203.0.113.10',
          cookie: 'session=secret',
          authorization: 'Bearer admin-secret',
          'x-sera-canary': 'canary-secret',
          'x-unlisted': 'drop-me',
        },
      });
      const res = await proxyToBackend(req, '/api/info');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-upstream')).toBe('ok');
      expect(res.headers.get('connection')).toBeNull();
      expect(seenUrl).toBe('/api/info?v=1');
      expect(seenHeaders['accept-encoding']).toBe('identity');
      expect(seenHeaders.accept).toBe('application/json');
      expect(seenHeaders['x-forwarded-for']).toBe('203.0.113.10');
      expect(seenHeaders['x-real-ip']).toBe('203.0.113.10');
      expect(seenHeaders.cookie).toBeUndefined();
      expect(seenHeaders.authorization).toBeUndefined();
      expect(seenHeaders['x-sera-canary']).toBeUndefined();
      expect(seenHeaders['x-unlisted']).toBeUndefined();
    } finally {
      await new Promise<void>((done) => srv.close(() => done()));
    }
  });

  it('scrubs internal upstream error details from 502 responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.SERA_API_URL = 'http://127.0.0.1:1';
    const req = new NextRequest('http://localhost:3000/api/info');
    const res = await proxyToBackend(req, '/api/info');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(body.error.hint).toBe('Please try again in a moment.');
    expect(body.error.hint).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|fetch failed/i);
  });
});
