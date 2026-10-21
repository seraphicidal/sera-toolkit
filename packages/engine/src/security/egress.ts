import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, isIPv6, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { seraError } from '../errors.js';
import { isIpLiteral, isPublicAddress } from './ip.js';

export interface EgressGuardOptions {
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly isAllowedAddress?: (address: string) => boolean;
  readonly allowPrivateAddresses?: boolean;
  readonly upstreamProxy?: string;
  readonly connectTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const defaultResolve = (hostname: string): Promise<LookupAddress[]> =>
  lookup(hostname, { all: true, verbatim: true });

export class EgressGuard {
  private readonly resolveName: (hostname: string) => Promise<readonly LookupAddress[]>;
  private readonly isAllowedAddress: (address: string) => boolean;
  private readonly defaultUpstreamProxy: string | undefined;
  private readonly connectTimeoutMs: number;

  private readonly servers = new Map<string, Server>();
  private readonly listening = new Map<string, Promise<string>>();
  private readonly sockets = new Set<Duplex>();

  constructor(options: EgressGuardOptions = {}) {
    this.resolveName = options.resolve ?? defaultResolve;
    this.isAllowedAddress =
      options.isAllowedAddress ?? (options.allowPrivateAddresses ? () => true : isPublicAddress);
    this.defaultUpstreamProxy = options.upstreamProxy;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  async addressesFor(hostname: string): Promise<readonly LookupAddress[]> {
    const bare =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

    let addresses: readonly LookupAddress[];
    if (isIpLiteral(bare)) {
      addresses = [{ address: bare, family: isIPv6(bare) ? 6 : 4 }];
    } else {
      try {
        addresses = await this.resolveName(bare);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
          throw seraError('INVALID_URL', {
            message: "We couldn't find that site.",
            hint: 'Check the address and try again.',
            detail: `egress: ${code} for ${bare}`,
            cause,
          });
        }
        throw seraError('NETWORK_ERROR', { detail: `egress: lookup failed for ${bare}`, cause });
      }
    }

    if (!addresses.length || addresses.some((a) => !this.isAllowedAddress(a.address))) {
      throw seraError('BLOCKED_ADDRESS', { detail: `egress: ${bare} is not a public address` });
    }
    return addresses;
  }

  async assertPublicDestination(url: string | URL): Promise<void> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw seraError('BLOCKED_ADDRESS', { detail: `egress: protocol ${parsed.protocol}` });
    }
    await this.addressesFor(parsed.hostname);
  }

  proxyUrl(upstream?: string): Promise<string> {
    const key = upstream ?? this.defaultUpstreamProxy ?? '';
    let promise = this.listening.get(key);
    if (!promise) {
      promise = this.start(key || undefined);
      this.listening.set(key, promise);
    }
    return promise;
  }

  async close(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    this.listening.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  }

  private start(upstreamProxy?: string): Promise<string> {
    const server = createServer();
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void this.forward(req, res, upstreamProxy);
    });
    server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
      void this.tunnel(req, client, head, upstreamProxy);
    });
    server.on('connection', (socket: Socket) => this.track(socket));
    this.servers.set(upstreamProxy ?? '', server);

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('egress proxy has no port'));
          return;
        }
        resolve(`http://127.0.0.1:${String(address.port)}`);
      });
    });
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
  }

  private async tunnel(
    req: IncomingMessage,
    client: Duplex,
    head: Buffer,
    upstreamProxy?: string,
  ): Promise<void> {
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      refuse(client, 400, 'Bad Request');
      return;
    }

    let address: LookupAddress;
    try {
      address = (await this.addressesFor(target.host))[0]!;
    } catch {
      refuse(client, 403, 'Forbidden');
      return;
    }

    if (!upstreamProxy) {
      const upstream = connect({
        host: address.address,
        port: target.port,
        family: address.family,
        timeout: this.connectTimeoutMs,
      });
      this.track(upstream);
      let established = false;
      upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
      upstream.once('connect', () => {
        established = true;
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () =>
        established ? client.destroy() : refuse(client, 502, 'Bad Gateway'),
      );
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      return;
    }

    let proxyUrl: URL;
    try {
      proxyUrl = new URL(upstreamProxy);
    } catch {
      refuse(client, 502, 'Bad Gateway');
      return;
    }

    const upstream = connect({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      timeout: this.connectTimeoutMs,
    });
    this.track(upstream);
    let established = false;
    upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
    upstream.once('error', () =>
      established ? client.destroy() : refuse(client, 502, 'Bad Gateway'),
    );
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());

    upstream.once('connect', () => {
      let connectReq = `CONNECT ${target.host}:${String(target.port)} HTTP/1.1\r\nHost: ${target.host}:${String(target.port)}\r\n`;
      if (proxyUrl.username || proxyUrl.password) {
        const creds = Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      connectReq += '\r\n';
      upstream.write(connectReq);

      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        upstream.off('data', onData);
        const headerText = buffer.subarray(0, headerEnd).toString('latin1');
        const statusLine = headerText.split('\r\n')[0] ?? '';
        const statusCode = Number(statusLine.split(' ')[1]);

        if (statusCode >= 200 && statusCode < 300) {
          established = true;
          upstream.setTimeout(0);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const remaining = buffer.subarray(headerEnd + 4);
          if (remaining.length) client.write(remaining);
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        } else {
          refuse(client, 502, 'Bad Gateway');
        }
      };
      upstream.on('data', onData);
    });
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamProxy?: string,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }

    let address: LookupAddress;
    try {
      address = (await this.addressesFor(url.hostname))[0]!;
    } catch {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the address guard');
      return;
    }

    if (!upstreamProxy) {
      const upstream = httpRequest({
        host: address.address,
        family: address.family,
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...forwardable(req.headers), host: url.host },
        agent: false,
        timeout: this.connectTimeoutMs,
      });
      upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
      upstream.once('socket', (socket: Socket) => {
        this.track(socket);
        socket.once('connect', () => upstream.setTimeout(0));
      });
      upstream.once('response', (response: IncomingMessage) => {
        res.writeHead(response.statusCode ?? 502, forwardable(response.headers));
        response.pipe(res);
      });
      upstream.once('error', () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      req.pipe(upstream);
      return;
    }

    let proxyUrl: URL;
    try {
      proxyUrl = new URL(upstreamProxy);
    } catch {
      res.writeHead(502).end();
      return;
    }

    const headers: Record<string, string | string[]> = {
      ...forwardable(req.headers),
      host: url.host,
    };
    if (proxyUrl.username || proxyUrl.password) {
      const creds = Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      ).toString('base64');
      headers['proxy-authorization'] = `Basic ${creds}`;
    }

    const upstream = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
      timeout: this.connectTimeoutMs,
    });
    upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
    upstream.once('socket', (socket: Socket) => {
      this.track(socket);
      socket.once('connect', () => upstream.setTimeout(0));
    });
    upstream.once('response', (response: IncomingMessage) => {
      res.writeHead(response.statusCode ?? 502, forwardable(response.headers));
      response.pipe(res);
    });
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  }
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]/\s]+):(\d{1,5})$/i.exec(authority);
  if (!match?.[1] || !match[2]) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host: match[1], port };
}

function forwardable(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function refuse(client: Duplex, status: number, reason: string): void {
  if (client.destroyed) return;
  client.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function confineToHttp(selector: string): string {
  return selector
    .split('/')
    .map((alternative) =>
      alternative
        .split('+')
        .map((atom) => (KEYWORD_ATOM.test(atom) ? `${atom}${HTTP_PROTOCOLS}` : atom))
        .join('+'),
    )
    .join('/');
}

const KEYWORD_ATOM = /^(?:best|worst|b|w)(?:video|audio|v|a)?\*?(?:\.\d+)?(?:\[|$)/;
const HTTP_PROTOCOLS = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']";
