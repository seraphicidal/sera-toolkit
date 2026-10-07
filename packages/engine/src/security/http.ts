import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { Readable } from 'node:stream';
import { Agent, buildConnector, request, type Dispatcher } from 'undici';
import { seraError } from '../errors.js';
import { isPublicAddress } from './ip.js';

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
  readonly allowPrivateAddresses?: boolean;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
}

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

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: '*/*',
};

export type ResponseHeaders = Record<string, string | string[] | undefined>;

export function header(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface SafeFetchOptions {
  readonly dispatcher: Dispatcher;
  readonly method?: 'GET' | 'HEAD';
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly allowUrl?: (url: URL) => boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly keepCookies?: boolean;
  readonly signal?: AbortSignal;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  readonly url: string;
  readonly body: Buffer;
}

export interface OpenResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  readonly url: string;
  readonly body: Readable;
}

export function discard(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

export async function safeOpen(url: URL, options: SafeFetchOptions): Promise<OpenResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  let current = url;
  const jar = cookieJar(options.headers?.cookie);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw seraError('BLOCKED_ADDRESS', { detail: `redirect to ${current.protocol}` });
    }
    if (options.allowUrl && !options.allowUrl(current)) {
      throw seraError('BLOCKED_ADDRESS', {
        detail:
          hop === 0
            ? 'destination is not on the allowed hosts'
            : `redirect ${hop} left the allowed hosts`,
      });
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await request(current, {
        method: options.method ?? 'GET',
        headers: hopHeaders(options, url, current, jar),
        dispatcher: options.dispatcher,
        signal,
      });
    } catch (cause) {
      if (isBlockedAddress(cause)) throw seraError('BLOCKED_ADDRESS', { cause });
      if (signal.aborted) throw seraError('TIMEOUT', { cause });
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
      if (options.keepCookies) keepSetCookies(jar, headers['set-cookie']);
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

function cookieJar(cookie: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const pair of (cookie ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return jar;
}

function keepSetCookies(jar: Map<string, string>, setCookie: string | string[] | undefined): void {
  for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const [pair = ''] = line.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value && value !== '""') jar.set(name, value);
  }
}

function hopHeaders(
  options: SafeFetchOptions,
  first: URL,
  current: URL,
  jar: Map<string, string>,
): Record<string, string> {
  const { cookie: _given, ...rest } = options.headers ?? {};
  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...rest };
  if (jar.size && current.hostname === first.hostname) {
    headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  return headers;
}

export async function safeFetch(url: URL, options: SafeFetchOptions): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const opened = await safeOpen(url, options);

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
