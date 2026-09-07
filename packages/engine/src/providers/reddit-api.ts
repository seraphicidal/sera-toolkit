import { seraError } from '../errors.js';
import type { Logger } from '../logging.js';

/**
 * Application-only OAuth against Reddit's Data API.
 *
 * Reddit refuses anonymous requests from hosted address ranges outright — `403 Blocked`
 * on both the HTML and the `.json` endpoint — so a server deployment has no unauthorized
 * path to a post at all. The supported answer is the `client_credentials` grant against
 * an app registered at https://www.reddit.com/prefs/apps, which reads public listings
 * and nothing else: no user, no scopes, no access to anything private.
 *
 * The token is held in memory only. It is never written to disk, never logged, never
 * sent to a client, and never leaves this module.
 */

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';

/** Renew early: a token that expires mid-request is a failed download. */
const RENEW_MARGIN_MS = 60_000;

export interface RedditCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Reddit's API rules require a descriptive, unique agent naming the application. */
  readonly userAgent: string;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class RedditTokenSource {
  private cached: CachedToken | undefined;
  /** One flight at a time: a burst of jobs must not become a burst of token requests. */
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly credentials: RedditCredentials,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > this.now()) return cached.value;
    this.inFlight ??= this.request().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Drops a token the API has just rejected, so the next call fetches a fresh one. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async request(): Promise<string> {
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`,
    ).toString('base64');

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': this.credentials.userAgent,
        },
        body: 'grant_type=client_credentials',
      });
    } catch (error) {
      throw seraError('NETWORK_ERROR', {
        detail: `reddit: token request failed: ${error instanceof Error ? error.message : 'unknown'}`,
      });
    }

    if (response.status === 401 || response.status === 403) {
      // Deliberately not the response body: it can echo back part of what was sent.
      throw seraError('PROVIDER_CONFIGURATION_ERROR', {
        message: "Reddit rejected this server's credentials.",
        detail: `reddit: token endpoint returned ${response.status}`,
      });
    }
    if (!response.ok) {
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `reddit: token endpoint returned ${response.status}`,
      });
    }

    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    const value = typeof payload.access_token === 'string' ? payload.access_token : undefined;
    if (!value) {
      throw seraError('PROVIDER_UNAVAILABLE', { detail: 'reddit: token response had no token' });
    }

    const lifetimeSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    this.cached = { value, expiresAt: this.now() + lifetimeSeconds * 1000 };
    // The token itself is never part of this line.
    this.logger.info(
      { provider: 'reddit', expiresInSeconds: lifetimeSeconds },
      'reddit access token issued',
    );
    return value;
  }
}

/** A post as the Data API returns it, narrowed to the fields that carry media. */
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
  /** `Image` or `AnimatedImage`. */
  readonly e?: string;
  /** The MIME type Reddit recorded, e.g. `image/jpg`. */
  readonly m?: string;
  readonly s?: {
    readonly u?: string;
    readonly gif?: string;
    readonly mp4?: string;
    readonly x?: number;
    readonly y?: number;
  };
}

/**
 * Fetches one post through the authenticated API.
 *
 * `oauth.reddit.com` is the only host that answers an authenticated request; the token
 * is not accepted on `www.reddit.com`.
 */
export async function fetchPost(
  postId: string,
  tokens: RedditTokenSource,
  credentials: RedditCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<RedditPost> {
  const call = async (token: string): Promise<Response> =>
    fetchImpl(`https://oauth.reddit.com/comments/${postId}?raw_json=1&limit=1`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': credentials.userAgent },
    });

  let response = await call(await tokens.token());
  if (response.status === 401) {
    // The cached token was revoked or expired early; one retry with a fresh one.
    tokens.invalidate();
    response = await call(await tokens.token());
  }

  if (response.status === 404) throw seraError('MEDIA_UNAVAILABLE', { detail: 'reddit: 404' });
  if (response.status === 403) {
    throw seraError('PRIVATE_CONTENT', {
      message: 'That post is in a private or quarantined community.',
      detail: 'reddit: 403 from the data API',
    });
  }
  if (response.status === 429) {
    throw seraError('RATE_LIMITED', { detail: 'reddit: 429 from the data API' });
  }
  if (!response.ok) {
    throw seraError('PROVIDER_UNAVAILABLE', { detail: `reddit: data api ${response.status}` });
  }

  const body = await response.json();
  const post = firstPostIn(body);
  if (!post) throw seraError('MEDIA_UNAVAILABLE', { detail: 'reddit: no post in listing' });
  return post;
}

/** The comments endpoint answers with `[postListing, commentListing]`. */
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
