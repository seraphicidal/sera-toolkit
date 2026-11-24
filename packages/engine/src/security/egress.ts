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
import { request as httpsRequest } from 'node:https';
import { connect, isIP, isIPv6, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { seraError } from '../errors.js';
import { isIpLiteral, isPublicAddress } from './ip.js';

export interface EgressGuardOptions {
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly isAllowedAddress?: (address: string) => boolean;
  readonly isBlockedHost?: (hostname: string) => boolean;
  readonly isBlockedUrl?: (url: string | URL) => boolean;
  readonly allowPrivateAddresses?: boolean;
  readonly allowNonStandardPorts?: boolean;
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
  private readonly isBlockedHost: ((hostname: string) => boolean) | undefined;
  private readonly isBlockedUrl: ((url: string | URL) => boolean) | undefined;
  private readonly allowNonStandardPorts: boolean;
  private readonly defaultUpstreamProxy: string | undefined;
  private readonly connectTimeoutMs: number;

  private readonly servers = new Map<string, Server>();
  private readonly listening = new Map<string, Promise<string>>();
  private readonly sockets = new Set<Duplex>();

  constructor(options: EgressGuardOptions = {}) {
    this.resolveName = options.resolve ?? defaultResolve;
    this.isAllowedAddress =
      options.isAllowedAddress ?? (options.allowPrivateAddresses ? () => true : isPublicAddress);
    this.isBlockedHost = options.isBlockedHost;
    this.isBlockedUrl = options.isBlockedUrl;
    this.allowNonStandardPorts =
      options.allowNonStandardPorts ??
      (Boolean(options.allowPrivateAddresses) || options.isAllowedAddress !== undefined);
    this.defaultUpstreamProxy = options.upstreamProxy;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  private isAllowedPort(port: number): boolean {
    return this.allowNonStandardPorts || port === 80 || port === 443;
  }

  private isDestinationBlocked(hostname: string, url?: string | URL): boolean {
    const bare = unbracket(hostname).toLowerCase().replace(/\.+$/, '');
    if (this.isBlockedHost?.(bare)) return true;
    if (url !== undefined && this.isBlockedUrl?.(url)) return true;
    return false;
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
    if (this.isDestinationBlocked(parsed.hostname, parsed)) {
      throw seraError('BLOCKED_ADDRESS', { detail: `egress: ${parsed.hostname} is blocked` });
    }
    await this.addressesFor(parsed.hostname);
  }

  proxyUrl(upstream?: string): Promise<string> {
    const key = upstream ?? this.defaultUpstreamProxy ?? '';
    let promise = this.listening.get(key);
    if (!promise) {
      promise = this.start(key || undefined).catch((err) => {
        this.listening.delete(key);
        throw err;
      });
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
    const key = upstreamProxy ?? '';
    const server = createServer();
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void this.forward(req, res, upstreamProxy);
    });
    server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
      void this.tunnel(req, client, head, upstreamProxy);
    });
    server.on('connection', (socket: Socket) => this.track(socket));
    this.servers.set(key, server);

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.servers.delete(key);
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        server.unref();
        const address = server.address();
        if (!address || typeof address === 'string') {
          this.servers.delete(key);
          server.close();
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
    if (!this.isAllowedPort(target.port)) {
      refuse(client, 403, 'Forbidden');
      return;
    }
    if (this.isDestinationBlocked(target.host)) {
      refuse(client, 403, 'Forbidden');
      return;
    }

    let clientGone = client.destroyed;
    const onEarlyClose = () => {
      clientGone = true;
    };
    client.once('close', onEarlyClose);

    let addresses: readonly LookupAddress[];
    try {
      addresses = await this.addressesFor(target.host);
    } catch {
      client.off('close', onEarlyClose);
      refuse(client, 403, 'Forbidden');
      return;
    }
    client.off('close', onEarlyClose);
    if (clientGone || client.destroyed) return;

    if (!upstreamProxy) {
      const connectNext = (index: number): void => {
        const current = addresses[index]!;
        const upstream = connect({
          host: current.address,
          port: target.port,
          family: current.family,
          timeout: this.connectTimeoutMs,
        });
        this.track(upstream);
        let established = false;
        let handedOff = false;
        const onClientClose = () => {
          upstream.destroy();
        };
        const cleanupClientClose = () => {
          client.off('close', onClientClose);
        };
        upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
        upstream.once('connect', () => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          established = true;
          handedOff = true;
          upstream.setTimeout(0);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.once('error', () => {
          cleanupClientClose();
          if (!established && !client.destroyed && index + 1 < addresses.length) {
            connectNext(index + 1);
            return;
          }
          if (established) client.destroy();
          else refuse(client, 502, 'Bad Gateway');
        });
        client.once('close', onClientClose);
        upstream.once('close', () => {
          cleanupClientClose();
          if (handedOff || index + 1 >= addresses.length) client.destroy();
        });
      };
      connectNext(0);
      return;
    }

    let proxyUrl: URL;
    try {
      proxyUrl = new URL(upstreamProxy);
    } catch {
      refuse(client, 502, 'Bad Gateway');
      return;
    }
    if ((proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') || !proxyUrl.hostname) {
      refuse(client, 502, 'Bad Gateway');
      return;
    }

    const proxyHost = unbracket(proxyUrl.hostname);
    const upstream: Socket =
      proxyUrl.protocol === 'https:'
        ? tlsConnect({
            host: proxyHost,
            port: upstreamPort(proxyUrl),
            ...(isIP(proxyHost) === 0 ? { servername: proxyHost } : {}),
            timeout: this.connectTimeoutMs,
          })
        : connect({
            host: proxyHost,
            port: upstreamPort(proxyUrl),
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

    const pinnedAddress = addresses.find((a) => a.family === 4) ?? addresses[0]!;
    const connectEvent = proxyUrl.protocol === 'https:' ? 'secureConnect' : 'connect';
    upstream.once(connectEvent, () => {
      const pinnedAuthority = `${formatAuthorityHost(pinnedAddress.address)}:${String(target.port)}`;
      let connectReq = `CONNECT ${pinnedAuthority} HTTP/1.1\r\nHost: ${pinnedAuthority}\r\n`;
      if (proxyUrl.username || proxyUrl.password) {
        const creds = Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64');
        connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      connectReq += '\r\n';
      upstream.write(connectReq);

      let buffer = Buffer.alloc(0);
      const MAX_CONNECT_HEADER_BYTES = 16_384;
      const onData = (chunk: Buffer) => {
        if (buffer.length + chunk.length > MAX_CONNECT_HEADER_BYTES) {
          upstream.off('data', onData);
          refuse(client, 502, 'Bad Gateway');
          upstream.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        upstream.off('data', onData);
        const headerText = buffer.subarray(0, headerEnd).toString('latin1');
        const statusLine = headerText.split('\r\n')[0] ?? '';
        const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/.exec(statusLine);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

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
          upstream.destroy();
        }
      };
      upstream.on('data', onData);
    });
  }

  private forwardUpstreamRequest(
    upstream: ReturnType<typeof httpRequest>,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
    upstream.once('socket', (socket: Socket) => {
      this.track(socket);
      socket.once('connect', () => upstream.setTimeout(0));
    });
    upstream.once('response', (response: IncomingMessage) => {
      response.once('error', () => {
        if (!res.destroyed) res.destroy();
      });
      res.writeHead(response.statusCode ?? 502, forwardable(response.headers));
      response.pipe(res);
    });
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else if (!res.destroyed) res.destroy();
    });
    res.once('close', () => {
      if (!res.writableEnded) {
        req.unpipe(upstream);
        if (!upstream.destroyed) upstream.destroy();
      }
    });
    req.once('aborted', () => {
      req.unpipe(upstream);
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });
    req.once('close', () => {
      if (!req.complete) {
        req.unpipe(upstream);
        if (!upstream.destroyed) upstream.destroy();
      }
    });
    req.pipe(upstream);
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
    const targetPort = Number(url.port) || 80;
    if (!this.isAllowedPort(targetPort)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the port guard');
      return;
    }
    if (this.isDestinationBlocked(url.hostname, url)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the address guard');
      return;
    }

    let reqGone = res.destroyed || req.destroyed;
    const onEarlyAbort = () => {
      reqGone = true;
    };
    res.once('close', onEarlyAbort);

    let addresses: readonly LookupAddress[];
    try {
      addresses = await this.addressesFor(url.hostname);
    } catch {
      res.off('close', onEarlyAbort);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the address guard');
      return;
    }
    res.off('close', onEarlyAbort);
    if (reqGone || res.destroyed) return;

    const address = addresses.find((a) => a.family === 4) ?? addresses[0]!;

    if (!upstreamProxy) {
      const upstream = httpRequest({
        host: address.address,
        family: address.family,
        port: targetPort,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...forwardable(req.headers), host: url.host },
        agent: false,
        timeout: this.connectTimeoutMs,
      });
      this.forwardUpstreamRequest(upstream, req, res);
      return;
    }

    let proxyUrl: URL;
    try {
      proxyUrl = new URL(upstreamProxy);
    } catch {
      res.writeHead(502).end();
      return;
    }
    if ((proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') || !proxyUrl.hostname) {
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

    const pinnedUrl = new URL(url.toString());
    pinnedUrl.hostname = formatAuthorityHost(address.address);
    const makeRequest = proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = makeRequest({
      host: unbracket(proxyUrl.hostname),
      port: upstreamPort(proxyUrl),
      method: req.method,
      path: pinnedUrl.toString(),
      headers,
      agent: false,
      timeout: this.connectTimeoutMs,
    });
    this.forwardUpstreamRequest(upstream, req, res);
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

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function formatAuthorityHost(host: string): string {
  const bare = unbracket(host);
  return bare.includes(':') ? `[${bare}]` : bare;
}

function upstreamPort(proxyUrl: URL): number {
  return Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
}

export function confineToHttp(selector: string): string {
  return selector
    .split(',')
    .map((part) =>
      part
        .split('/')
        .map((alternative) =>
          alternative
            .split('+')
            .map((atom) =>
              !atom || atom.includes(HTTP_PROTOCOLS) ? atom : `${atom}${HTTP_PROTOCOLS}`,
            )
            .join('+'),
        )
        .join('/'),
    )
    .join(',');
}

const HTTP_PROTOCOLS = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']";
