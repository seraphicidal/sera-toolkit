import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiOrigin, proxyToBackend } from './backend-proxy';

describe('backend-proxy runtime routing', () => {
  const originalUrl = process.env.SERA_API_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SERA_API_URL;
    else process.env.SERA_API_URL = originalUrl;
  });

  it('reads SERA_API_URL dynamically, strips hop-by-hop headers, and forces identity encoding', async () => {
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
          connection: 'x-custom-hop',
          'x-custom-hop': 'strip-me',
          'x-keep': 'yes',
        },
      });
      const res = await proxyToBackend(req, '/api/info');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-upstream')).toBe('ok');
      expect(res.headers.get('connection')).toBeNull();
      expect(seenUrl).toBe('/api/info?v=1');
      expect(seenHeaders['accept-encoding']).toBe('identity');
      expect(seenHeaders['x-custom-hop']).toBeUndefined();
      expect(seenHeaders['x-keep']).toBe('yes');
    } finally {
      await new Promise<void>((done) => srv.close(() => done()));
    }
  });
});
