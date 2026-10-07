import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeDispatcher, safeFetch } from './http.js';

let server: Server;
let port: number;
const seen: { path: string; host: string; cookie?: string }[] = [];

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    const path = request.url ?? '/';
    seen.push({
      path,
      host: request.headers.host ?? '',
      ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    });
    if (path === '/check') {
      if (!request.headers.cookie?.includes('mid=')) {
        response.writeHead(302, {
          location: '/check',
          'set-cookie': ['mid=abc; Path=/; Secure', 'ig_did=xyz; Path=/'],
        });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [1] }));
      return;
    }
    if (path === '/away') {
      response.writeHead(302, { location: `http://localhost:${String(port)}/landed` });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const dispatcher = createSafeDispatcher({ allowPrivateAddresses: true });

describe('keepCookies', () => {
  it('carries the cookies a redirect sets to the next hop, with the one given', async () => {
    seen.length = 0;
    const response = await safeFetch(new URL(`http://127.0.0.1:${String(port)}/check`), {
      dispatcher,
      headers: { cookie: 'sessionid=secret' },
      keepCookies: true,
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.cookie).toBe('sessionid=secret; mid=abc; ig_did=xyz');
  });

  it('without it, the redirect repeats until the hop budget runs out', async () => {
    await expect(
      safeFetch(new URL(`http://127.0.0.1:${String(port)}/check`), {
        dispatcher,
        headers: { cookie: 'sessionid=secret' },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('never sends a cookie to another host a redirect points at', async () => {
    seen.length = 0;
    await safeFetch(new URL(`http://127.0.0.1:${String(port)}/away`), {
      dispatcher,
      headers: { cookie: 'sessionid=secret' },
      keepCookies: true,
    });
    expect(seen.map((hop) => hop.path)).toEqual(['/away', '/landed']);
    expect(seen[0]!.cookie).toBe('sessionid=secret');
    expect(seen[1]!.cookie).toBeUndefined();
  });
});
