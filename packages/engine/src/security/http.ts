import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { Readable } from 'node:stream';
import { Agent, buildConnector, request, type Dispatcher } from 'undici';
import { seraError } from '../errors.js';
import { isPublicAddress } from './ip.js';

/**
 * An HTTP client that cannot be pointed at this server's own network.
 *
 * The guard lives in the DNS lookup the connector actually uses, not in a check
 * performed before the request. That ordering matters: validating a hostname and then
 * letting the socket resolve it again leaves a window in which the second answer
 * differs from the first, which is exactly what a DNS-rebinding attack arranges.
 * Filtering inside the lookup means the only addresses the socket can ever be given
 * are ones that passed.
 *
 * Requests go through undici's own `request`, not the global `fetch`. Node bundles a
 * private copy of undici, and it rejects a dispatcher built from the installed package
 * with `UND_ERR_INVALID_ARG` — so a guarded dispatcher handed to global `fetch` fails
 * every request rather than protecting them. Using undici directly keeps the dispatcher
 * and the client in the same copy of the library, and returns Node streams, which is
 * what the download path wants anyway.
 */

export class BlockedAddressError extends Error {
  constructor(hostname: string) {
    super(`refusing to connect to ${hostname}: no public address`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A `net.connect`-compatible lookup that only ever yields public addresses. */
function guardedLookup(
  hostname: string,
  options: { family?: number | undefined; all?: boolean | undefined; hints?: number | undefined },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 4);
      return;
    }
    const safe = addresses.filter((a) => isPublicAddress(a.address));
    if (safe.length === 0) {
      callback(Object.assign(new BlockedAddressError(hostname), { code: 'EBLOCKED' }), '', 4);
      return;
    }
    if (options.all) {
      callback(null, safe);
      return;
    }
    const first = safe[0]!;
    callback(null, first.address, first.family);
  });
}

export interface SafeHttpOptions {
  /** Permits private and loopback destinations. Development only. */
  readonly allowPrivateAddresses?: boolean;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
}

/** Builds a dispatcher whose sockets are restricted to public addresses. */
export function createSafeDispatcher(options: SafeHttpOptions = {}): Dispatcher {
  const connectOptions = {
    timeout: options.connectTimeoutMs ?? 10_000,
    ...(options.allowPrivateAddresses ? {} : { lookup: guardedLookup }),
  } as Parameters<typeof buildConnector>[0];

  return new Agent({
    connect: buildConnector(connectOptions),
    headersTimeout: options.headersTimeoutMs ?? 15_000,
    bodyTimeout: options.bodyTimeoutMs ?? 60_000,
    pipelining: 0,
  });
}

/** Browser-like headers. No cookies, no auth, no referrer are ever sent. */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: '*/*',
};

export type ResponseHeaders = Record<string, string | string[] | undefined>;

/** Reads one header value, collapsing the repeated-header case. */
export function header(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface SafeFetchOptions {
  readonly dispatcher: Dispatcher;
  readonly method?: 'GET' | 'HEAD';
  readonly timeoutMs?: number;
  /** Aborts once this many bytes have been read. */
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  /** The URL the response actually came from, after redirects. */
  readonly url: string;
  readonly body: Buffer;
}

/** An open response whose body has not been read yet. */
export interface OpenResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  readonly url: string;
  readonly body: Readable;
}

/**
 * Throws away a response body.
 *
 * undici raises an AbortError from `destroy()`, which surfaces as an uncaught exception
 * unless something is already listening, so the listener goes on first.
 */
export function discard(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Opens a URL through the guarded dispatcher and returns the body unread.
 *
 * Redirects are followed one hop at a time so that every intermediate URL is re-checked
 * against the scheme rules, and so the hop budget is enforced here rather than by the
 * transport. Callers either buffer the body (`safeFetch`) or stream it to disk.
 */
export async function safeOpen(url: URL, options: SafeFetchOptions): Promise<OpenResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw seraError('BLOCKED_ADDRESS', { detail: `redirect to ${current.protocol}` });
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await request(current, {
        method: options.method ?? 'GET',
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        dispatcher: options.dispatcher,
        signal,
      });
    } catch (cause) {
      if (isBlockedAddress(cause)) throw seraError('BLOCKED_ADDRESS', { cause });
      if (signal.aborted) throw seraError('TIMEOUT', { cause });
      // A host that does not resolve is a typo, not an outage. Reporting it as a network
      // error would offer a "Try again" that can never succeed.
      if (hasErrorCode(cause, 'ENOTFOUND')) {
        throw seraError('INVALID_URL', {
          message: "We couldn't find that site.",
          hint: 'Check the address and try again.',
          detail: describe(cause),
        });
      }
      throw seraError('NETWORK_ERROR', { cause, detail: describe(cause) });
    }

    const headers = response.headers;

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = header(headers, 'location');
      discard(response.body);
      if (!location) {
        throw seraError('NETWORK_ERROR', {
          detail: `redirect ${response.statusCode} without location`,
        });
      }
      if (hop === maxRedirects) throw seraError('NETWORK_ERROR', { detail: 'too many redirects' });
      current = new URL(location, current);
      continue;
    }

    return {
      status: response.statusCode,
      headers,
      url: current.toString(),
      body: response.body,
    };
  }

  /* c8 ignore next -- the loop always returns or throws */
  throw seraError('NETWORK_ERROR', { detail: 'redirect loop' });
}

/** Fetches a URL and buffers the body, refusing anything over `maxBytes`. */
export async function safeFetch(url: URL, options: SafeFetchOptions): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const opened = await safeOpen(url, options);

  // A HEAD response reports the length of a body it does not send, so the size cap does
  // not apply to it: checking it here would reject every file larger than the cap on a
  // request that transfers nothing.
  if ((options.method ?? 'GET') === 'HEAD') {
    discard(opened.body);
    return {
      status: opened.status,
      headers: opened.headers,
      url: opened.url,
      body: Buffer.alloc(0),
    };
  }

  const declared = Number(header(opened.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(opened.body);
    throw seraError('TOO_LARGE', { detail: `content-length ${declared} > ${maxBytes}` });
  }

  const body = await readCapped(opened.body, maxBytes);
  return { status: opened.status, headers: opened.headers, url: opened.url, body };
}

async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      discard(stream);
      throw seraError('TOO_LARGE', { detail: `body exceeded ${maxBytes} bytes` });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Walks the cause chain looking for a specific errno code. */
function hasErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if ((current as NodeJS.ErrnoException).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isBlockedAddress(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof BlockedAddressError) return true;
    if (typeof current === 'object' && (current as { code?: string }).code === 'EBLOCKED') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
