import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MediaServerRoute {
  readonly file?: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly redirectTo?: string;
  readonly declaredLength?: number;
}

export class MediaServer {
  private server: Server | undefined;
  private port = 0;
  readonly requests: string[] = [];

  constructor(private readonly routes: Record<string, MediaServerRoute>) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      this.requests.push(path);
      const route = this.routes[path];

      if (!route) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      if (route.redirectTo) {
        response.writeHead(route.status ?? 302, { location: route.redirectTo });
        response.end();
        return;
      }
      if (route.body !== undefined) {
        const buffer = Buffer.from(route.body, 'utf8');
        response.writeHead(route.status ?? 200, {
          'content-type': route.contentType ?? 'text/html; charset=utf-8',
          'content-length': route.declaredLength ?? buffer.length,
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        response.end(buffer);
        return;
      }
      if (!route.file) {
        response.writeHead(route.status ?? 500);
        response.end();
        return;
      }

      void (async () => {
        try {
          const info = await stat(route.file!);
          response.writeHead(route.status ?? 200, {
            'content-type': route.contentType ?? 'application/octet-stream',
            'content-length': route.declaredLength ?? info.size,
            'accept-ranges': 'bytes',
          });
          if (request.method === 'HEAD') {
            response.end();
            return;
          }
          createReadStream(route.file!).pipe(response);
        } catch {
          response.writeHead(404);
          response.end();
        }
      })();
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.origin;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  url(path: string): string {
    return `${this.origin}${path}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
