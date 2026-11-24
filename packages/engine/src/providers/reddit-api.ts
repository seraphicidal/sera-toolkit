import { seraError } from '../errors.js';
import type { Logger } from '../logging.js';
import { readBoundedJson } from '../security/http.js';
import { InFlightCoalescer } from '../util/coalesce.js';

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
const MAX_REDDIT_JSON_BYTES = 8 * 1024 * 1024;

const RENEW_MARGIN_MS = 60_000;

export interface RedditCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userAgent: string;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class RedditTokenSource {
  private cached: CachedToken | undefined;
  private readonly coalescer = new InFlightCoalescer<string>();

  constructor(
    private readonly credentials: RedditCredentials,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(signal?: AbortSignal, fetchOverride?: typeof fetch): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > this.now()) return cached.value;
    try {
      return await this.coalescer.run(
        'token',
        (coalescedSignal) => this.request(coalescedSignal, fetchOverride),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw seraError('CANCELLED', { cause: error });
      throw error;
    }
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async request(signal?: AbortSignal, fetchOverride?: typeof fetch): Promise<string> {
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`,
    ).toString('base64');

    const timeoutSignal = AbortSignal.timeout(15_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      const doFetch = fetchOverride ?? this.fetchImpl;
      response = await doFetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': this.credentials.userAgent,
        },
        body: 'grant_type=client_credentials',
        redirect: 'manual',
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw seraError('CANCELLED', { cause: error });
      if (timeoutSignal.aborted) {
        throw seraError('TIMEOUT', { detail: 'reddit: token request timed out', cause: error });
      }
      throw seraError('NETWORK_ERROR', {
        detail: `reddit: token request failed: ${error instanceof Error ? error.message : 'unknown'}`,
      });
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw seraError('PROVIDER_CONFIGURATION_ERROR', {
        message: "Reddit rejected this server's credentials.",
        detail: `reddit: token endpoint returned ${response.status}`,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `reddit: token endpoint returned ${response.status}`,
      });
    }

    const payload = await readBoundedJson<{ access_token?: unknown; expires_in?: unknown }>(
      response,
      MAX_REDDIT_JSON_BYTES,
      'reddit: invalid JSON from token endpoint',
    );
    const value = typeof payload.access_token === 'string' ? payload.access_token : undefined;
    if (!value) {
      throw seraError('PROVIDER_UNAVAILABLE', { detail: 'reddit: token response had no token' });
    }

    const lifetimeSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    this.cached = { value, expiresAt: this.now() + lifetimeSeconds * 1000 };
    this.logger.info(
      { provider: 'reddit', expiresInSeconds: lifetimeSeconds },
      'reddit access token issued',
    );
    return value;
  }
}

export interface RedditPost {
  readonly id?: string;
  readonly title?: string;
  readonly author?: string;
  readonly subreddit_name_prefixed?: string;
  readonly over_18?: boolean;
  readonly is_gallery?: boolean;
  readonly gallery_data?: { readonly items?: readonly { readonly media_id?: string }[] };
  readonly media_metadata?: Record<string, RedditMediaMetadata | undefined>;
  readonly is_video?: boolean;
  readonly media?: { readonly reddit_video?: RedditVideo };
  readonly secure_media?: { readonly reddit_video?: RedditVideo };
  readonly crosspost_parent_list?: readonly RedditPost[];
  readonly post_hint?: string;
  readonly url_overridden_by_dest?: string;
  readonly url?: string;
  readonly preview?: {
    readonly images?: readonly {
      readonly source?: {
        readonly url?: string;
        readonly width?: number;
        readonly height?: number;
      };
      readonly variants?: {
        readonly gif?: { readonly source?: { readonly url?: string } };
        readonly mp4?: { readonly source?: { readonly url?: string } };
      };
    }[];
    readonly reddit_video_preview?: RedditVideo;
  };
}

export interface RedditVideo {
  readonly fallback_url?: string;
  readonly dash_url?: string;
  readonly hls_url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly is_gif?: boolean;
  readonly has_audio?: boolean;
}

export interface RedditMediaMetadata {
  readonly status?: string;
  readonly e?: string;
  readonly m?: string;
  readonly s?: {
    readonly u?: string;
    readonly gif?: string;
    readonly mp4?: string;
    readonly x?: number;
    readonly y?: number;
  };
}

export async function fetchPost(
  postId: string,
  tokens: RedditTokenSource,
  credentials: RedditCredentials,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RedditPost> {
  const call = async (token: string): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetchImpl(`https://oauth.reddit.com/comments/${postId}?raw_json=1&limit=1`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': credentials.userAgent },
        redirect: 'manual',
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw seraError('CANCELLED', { cause: error });
      if (timeoutSignal.aborted) {
        throw seraError('TIMEOUT', { detail: 'reddit: post request timed out', cause: error });
      }
      throw seraError('NETWORK_ERROR', {
        detail: `reddit: post request failed: ${error instanceof Error ? error.message : 'unknown'}`,
      });
    }
  };

  let response = await call(await tokens.token(signal, fetchImpl));
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    tokens.invalidate();
    response = await call(await tokens.token(signal, fetchImpl));
  }

  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw seraError('MEDIA_UNAVAILABLE', { detail: 'reddit: 404' });
  }
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw seraError('PRIVATE_CONTENT', {
      message: 'That post is in a private or quarantined community.',
      detail: 'reddit: 403 from the data API',
    });
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw seraError('RATE_LIMITED', { detail: 'reddit: 429 from the data API' });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw seraError('PROVIDER_UNAVAILABLE', { detail: `reddit: data api ${response.status}` });
  }

  const body = await readBoundedJson<unknown>(
    response,
    MAX_REDDIT_JSON_BYTES,
    'reddit: invalid JSON from data api',
  );
  const post = firstPostIn(body);
  if (!post) throw seraError('MEDIA_UNAVAILABLE', { detail: 'reddit: no post in listing' });
  return post;
}

function firstPostIn(body: unknown): RedditPost | undefined {
  const listings = Array.isArray(body) ? body : [body];
  for (const listing of listings) {
    const children = (listing as { data?: { children?: unknown[] } })?.data?.children;
    const first = Array.isArray(children) ? children[0] : undefined;
    const data = (first as { data?: RedditPost } | undefined)?.data;
    if (data && (data.id || data.title)) return data;
  }
  return undefined;
}
