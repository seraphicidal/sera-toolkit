import { createHmac } from 'node:crypto';
import type { DownloadOption, MediaInfo, MediaItem } from '@sera/contracts/types';
import type { Dispatcher } from 'undici';
import type { EngineConfig } from './config.js';
import { seraError, SeraError } from './errors.js';
import { dumpInfo, version as ytdlpVersion } from './extract/ytdlp.js';
import { ExtractionRouter, type ExtractionBackend } from './extract/router.js';
import type { YtdlpInfo } from './extract/ytdlp-types.js';
import { createLogger, logSafeUrl, type Logger } from './logging.js';
import { normalizeForProvider, ProviderRegistry } from './providers/index.js';
import type {
  DownloadPlan,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './providers/types.js';
import { planKey } from './providers/types.js';
import { createSafeDispatcher, header, safeFetch } from './security/http.js';
import { normalizeUrl, parseUserUrl } from './security/url.js';
import { TtlCache } from './util/cache.js';
import { signToken, verifyToken } from './util/tokens.js';

/**
 * Turns a pasted link into the model the UI renders.
 *
 * The only thing the client gets back is `MediaInfo`: no format ids, no provider
 * internals, no media URLs. Each option carries a signed token that encodes how to
 * fetch it, which is what keeps the frontend free of platform-specific logic and keeps
 * the download pipeline from accepting a URL the resolver never approved.
 */

/**
 * What an option token carries. Kept to single letters: it travels in every response.
 *
 * The URL lives in the resolution token, not here. An option instead carries a keyed
 * digest of it, so a 40-slide carousel with six options each ships one copy of the URL
 * rather than 240 — while still being cryptographically bound to the resolution that
 * produced it, since the digest is computed with the server secret.
 */
interface OptionTokenPayload {
  /** Keyed digest of the resolution this option belongs to. */
  readonly h: string;
  /** Item index within the resolution. */
  readonly i: number;
  /** The provider's own id for that item, checked on re-resolution. */
  readonly s?: string;
  /** Plan key: kind/container/label. */
  readonly k: string;
}

interface InfoTokenPayload {
  readonly u: string;
  readonly p: string;
}

interface ThumbTokenPayload {
  readonly t: string;
}

export interface ResolverDependencies {
  readonly config: EngineConfig;
  readonly logger?: Logger;
  readonly registry?: ProviderRegistry;
  readonly dispatcher?: Dispatcher;
  /**
   * Extraction backends on other networks, consulted at call time so a node that dials
   * in later is usable without restarting the API.
   */
  readonly remoteBackends?: () => readonly ExtractionBackend[];
  /** Overridable so tests can exercise the whole pipeline with no yt-dlp installed. */
  readonly probe?: (
    url: string,
    options: {
      playlist?: boolean;
      flatPlaylist?: boolean;
      signal?: AbortSignal;
      extractorArgs?: readonly string[];
      timeoutMs?: number;
    },
  ) => Promise<YtdlpInfo>;
}

export class MediaResolver {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly registry: ProviderRegistry;
  readonly dispatcher: Dispatcher;

  private readonly probeImpl: NonNullable<ResolverDependencies['probe']>;
  /** Short-lived, so submitting a job just after analyzing does not re-hit the provider. */
  private readonly cache = new TtlCache<ResolvedMedia>(200, 5 * 60_000);

  constructor(deps: ResolverDependencies) {
    this.config = deps.config;
    this.logger =
      deps.logger ??
      createLogger({ level: deps.config.logLevel, pretty: !deps.config.isProduction });
    this.registry = deps.registry ?? new ProviderRegistry(undefined, deps.config);

    // The primary backend is this worker doing exactly what it did before the router
    // existed; everything else the router knows about dials in from another network.
    this.router = new ExtractionRouter({
      primary: {
        id: 'local',
        kind: 'local',
        networkClass: deps.config.networkClass,
        providers: [],
        isHealthy: () => true,
        resolve: (url, providerId, signal) => this.runProvider(url, providerId, signal),
      },
      logger: this.logger,
      fallbacks: deps.remoteBackends ?? (() => []),
      // What each provider says about itself, rather than a conditional in the router
      // that knows about failure classes and nothing about platforms.
      capabilitiesOf: (providerId) => this.registry.get(providerId)?.capabilities,
    });
    this.dispatcher =
      deps.dispatcher ??
      createSafeDispatcher({ allowPrivateAddresses: deps.config.allowPrivateAddresses });

    this.probeImpl =
      deps.probe ??
      ((url, options) =>
        dumpInfo(url, {
          binary: this.config.ytdlpPath,
          ffmpegPath: this.config.ffmpegPath,
          timeoutMs: options.timeoutMs ?? this.config.resolveTimeoutSeconds * 1000,
          ...(options.playlist !== undefined ? { playlist: options.playlist } : {}),
          ...(options.flatPlaylist !== undefined ? { flatPlaylist: options.flatPlaylist } : {}),
          ...(options.extractorArgs?.length ? { extractorArgs: options.extractorArgs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }));
  }

  /**
   * The extractor's version, asked for once.
   *
   * It belongs on every resolve line because it is the first question when a provider
   * starts failing: did the site change, or did the extractor?
   */
  private cachedExtractorVersion: string | undefined;

  private async extractorVersion(): Promise<string> {
    const cached = this.cachedExtractorVersion;
    if (cached) return cached;
    const resolved = await ytdlpVersion(this.config.ytdlpPath).catch(() => 'unknown');
    this.cachedExtractorVersion = resolved;
    return resolved;
  }

  private readonly router: ExtractionRouter;

  /** Resolves user input into the client model. */
  async resolve(input: string, signal?: AbortSignal): Promise<MediaInfo> {
    const { url } = parseUserUrl(input, {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    });

    if (this.config.blockedHosts.length) {
      const { hostMatchesAny } = await import('./security/url.js');
      if (hostMatchesAny(url.hostname, this.config.blockedHosts)) {
        throw seraError('UNSUPPORTED_SOURCE', { detail: 'host is on the deny list' });
      }
    }

    const provider = this.registry.detect(url);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `no provider for ${url.hostname}` });
    }

    const canonical = normalizeUrl(normalizeForProvider(provider, url));
    const started = Date.now();

    let resolved: ResolvedMedia;
    let used = provider;
    try {
      try {
        resolved = await this.resolveCanonical(canonical, provider.id, signal);
      } catch (error) {
        // "This provider cannot handle what is here" is not the same as "there is
        // nothing here", and the page reader can often do better. Two cases in practice: a
        // path ending in .gif that is really a file-description page, and a social post
        // whose extractor only understands video while the post is photographs. Both are
        // reported as an unsupported source, and both are worth one more try through the
        // reader — which grants no extra reach, since a URL the specific provider had not
        // claimed would have arrived there anyway.
        const generic = this.registry.get('generic');
        if (
          provider.id === 'generic' ||
          !generic ||
          SeraError.from(error).code !== 'UNSUPPORTED_SOURCE'
        ) {
          throw error;
        }
        try {
          resolved = await this.resolveCanonical(canonical, generic.id, signal);
        } catch (fallbackError) {
          // The reader found nothing either, so the first answer stands — it names the
          // source the user actually pasted. The exception is a site that asks not to be
          // read automatically: "this source isn't supported" would be misleading when
          // the truthful answer is that we were asked not to look.
          const refusal = SeraError.from(fallbackError);
          throw refusal.detail?.startsWith('robots.txt disallows') ? refusal : error;
        }
        used = generic;
      }
      this.registry.markHealthy(used.id);
    } catch (error) {
      const seraErr = SeraError.from(error);
      // A source that refuses this server refuses it for everyone using this instance, so
      // it belongs in the degraded list that /api/info reports — better that the About page
      // says so once than that every visitor discovers it one link at a time.
      if (seraErr.code === 'PROVIDER_UNAVAILABLE' || seraErr.code === 'SOURCE_BLOCKED') {
        this.registry.markDegraded(used.id, seraErr.detail ?? seraErr.message);
      }
      this.logger.info(
        {
          provider: used.id,
          source: logSafeUrl(canonical),
          ytdlp: await this.extractorVersion(),
          durationMs: Date.now() - started,
          errorCode: seraErr.code,
          detail: seraErr.detail,
        },
        'resolve failed',
      );
      throw seraErr;
    }

    this.logger.info(
      {
        provider: used.id,
        source: logSafeUrl(canonical),
        ytdlp: await this.extractorVersion(),
        durationMs: Date.now() - started,
        items: resolved.items.length,
      },
      'resolved',
    );

    return this.toMediaInfo(resolved);
  }

  /**
   * Resolves an already-canonical URL through a known provider.
   *
   * The download pipeline calls this to re-derive a plan at job time, which is why the
   * result is cached briefly and why plans are matched by key rather than by index.
   */
  async resolveCanonical(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedMedia> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `unknown provider ${providerId}` });
    }

    const cacheKey = `${providerId}|${canonical.toString()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Through the router rather than straight to the provider, so the job-time
    // re-resolution takes the same backend the analysis did. It has to: a media URL
    // signed for one address is refused from another, so a resolution and its download
    // belong to the same network.
    const outcome = await this.router.resolve(canonical, providerId, signal);
    const resolved = outcome.fallbackUsed
      ? {
          ...outcome.media,
          metadata: { ...outcome.media.metadata, extractionBackend: outcome.backend },
        }
      : outcome.media;

    if (!resolved.items.length) throw seraError('MEDIA_UNAVAILABLE');
    this.cache.set(cacheKey, resolved);
    return resolved;
  }

  /** One attempt on this worker. The router decides whether it is the only one. */
  private async runProvider(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedMedia> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `unknown provider ${providerId}` });
    }
    return provider.resolve(canonical, this.providerContext(signal));
  }

  /** What the health endpoint reports about where extraction can run. */
  extractionBackends(): ReturnType<ExtractionRouter['describe']> {
    return this.router.describe();
  }

  private providerContext(signal?: AbortSignal): ProviderContext {
    return {
      config: this.config,
      logger: this.logger,
      ...(signal ? { signal } : {}),
      probe: (url, options) => this.probeImpl(url, { ...options, ...(signal ? { signal } : {}) }),
      fetchText: async (url, maxBytes, options) => {
        const response = await safeFetch(url, {
          dispatcher: this.dispatcher,
          timeoutMs: this.config.resolveTimeoutSeconds * 1000,
          maxBytes: maxBytes ?? 2 * 1024 * 1024,
          ...(options?.headers ? { headers: options.headers } : {}),
          ...(signal ? { signal } : {}),
        });
        if (response.status >= 400) {
          throw seraError(response.status === 404 ? 'MEDIA_UNAVAILABLE' : 'NETWORK_ERROR', {
            detail: `GET ${response.status}`,
          });
        }
        return { body: response.body.toString('utf8'), url: response.url };
      },
      head: async (url) => {
        const response = await safeFetch(url, {
          dispatcher: this.dispatcher,
          method: 'HEAD',
          timeoutMs: this.config.resolveTimeoutSeconds * 1000,
          maxBytes: 1,
          ...(signal ? { signal } : {}),
        });
        const contentType = header(response.headers, 'content-type');
        const length = Number(header(response.headers, 'content-length'));
        return {
          status: response.status,
          ...(contentType ? { contentType } : {}),
          ...(Number.isFinite(length) && length > 0 ? { contentLength: length } : {}),
          url: response.url,
        };
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Token minting and verification                                     */
  /* ------------------------------------------------------------------ */

  toMediaInfo(resolved: ResolvedMedia): MediaInfo {
    const ttl = this.config.optionTtlSeconds;
    const items: MediaItem[] = resolved.items.map((item) => this.toMediaItem(resolved, item, ttl));

    const infoId = signToken<InfoTokenPayload>(
      { u: resolved.url, p: resolved.provider },
      this.config.secret,
      ttl,
    );

    return {
      id: infoId,
      provider: resolved.provider,
      providerLabel: resolved.providerLabel,
      url: resolved.url,
      type: resolved.type,
      title: resolved.title,
      ...(resolved.description ? { description: resolved.description } : {}),
      ...(resolved.author ? { author: resolved.author } : {}),
      ...(resolved.authorUrl ? { authorUrl: resolved.authorUrl } : {}),
      ...(resolved.thumbnailUrl ? { thumbnail: this.thumbnailPath(resolved.thumbnailUrl) } : {}),
      ...(resolved.duration !== undefined ? { duration: resolved.duration } : {}),
      ...(resolved.createdAt ? { createdAt: resolved.createdAt } : {}),
      items,
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
      expiresIn: ttl,
    };
  }

  private toMediaItem(resolved: ResolvedMedia, item: ResolvedItem, ttl: number): MediaItem {
    const itemId = `${resolved.provider}:${item.index}`;
    const options: DownloadOption[] = item.plans.map((plan) =>
      this.toDownloadOption(resolved, item, plan, itemId, ttl),
    );

    return {
      id: itemId,
      index: item.index + 1,
      kind: item.kind,
      ...(item.title ? { title: item.title } : {}),
      ...(item.thumbnailUrl ? { thumbnail: this.thumbnailPath(item.thumbnailUrl) } : {}),
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.duration !== undefined ? { duration: item.duration } : {}),
      ...(item.container ? { container: item.container } : {}),
      ...(item.filesizeBytes !== undefined ? { filesizeBytes: item.filesizeBytes } : {}),
      ...(item.isLive ? { isLive: true } : {}),
      options,
    };
  }

  private toDownloadOption(
    resolved: ResolvedMedia,
    item: ResolvedItem,
    plan: DownloadPlan,
    itemId: string,
    ttl: number,
  ): DownloadOption {
    const id = signToken<OptionTokenPayload>(
      {
        h: this.resolutionHash(resolved.url, resolved.provider),
        i: item.index,
        ...(item.sourceId ? { s: item.sourceId } : {}),
        k: planKey(plan),
      },
      this.config.secret,
      ttl,
    );

    return {
      id,
      itemId,
      kind: plan.kind,
      container: plan.container,
      label: plan.label,
      ...(plan.detail ? { detail: plan.detail } : {}),
      ...(plan.width ? { width: plan.width } : {}),
      ...(plan.height ? { height: plan.height } : {}),
      ...(plan.fps ? { fps: plan.fps } : {}),
      ...(plan.audioBitrateKbps ? { audioBitrateKbps: plan.audioBitrateKbps } : {}),
      ...(plan.videoCodec ? { videoCodec: plan.videoCodec } : {}),
      ...(plan.audioCodec ? { audioCodec: plan.audioCodec } : {}),
      ...(plan.filesizeBytes !== undefined ? { filesizeBytes: plan.filesizeBytes } : {}),
      ...(plan.filesizeIsApproximate ? { filesizeIsApproximate: true } : {}),
      requiresConversion: plan.requiresConversion,
      recommended: plan.recommended,
    };
  }

  /** Signs a third-party thumbnail URL into a path on this API. */
  thumbnailPath(url: string): string {
    const token = signToken<ThumbTokenPayload>(
      { t: url },
      this.config.secret,
      this.config.optionTtlSeconds,
    );
    return `/api/thumb/${encodeURIComponent(token)}`;
  }

  /** Recovers the origin URL from a thumbnail token, or throws. */
  verifyThumbnailToken(token: string): string {
    const payload = verifyToken<ThumbTokenPayload>(token, this.config.secret);
    if (typeof payload.t !== 'string' || !payload.t) {
      throw seraError('NOT_FOUND', { detail: 'thumbnail token without url' });
    }
    return payload.t;
  }

  verifyInfoId(infoId: string): InfoTokenPayload {
    const payload = verifyToken<InfoTokenPayload>(infoId, this.config.secret);
    if (typeof payload.u !== 'string' || typeof payload.p !== 'string') {
      throw seraError('EXPIRED', { detail: 'malformed info token' });
    }
    return payload;
  }

  verifyOptionId(optionId: string): OptionTokenPayload {
    const payload = verifyToken<OptionTokenPayload>(optionId, this.config.secret);
    if (
      typeof payload.h !== 'string' ||
      typeof payload.i !== 'number' ||
      typeof payload.k !== 'string'
    ) {
      throw seraError('EXPIRED', { detail: 'malformed option token' });
    }
    return payload;
  }

  /**
   * A short keyed digest identifying one resolution.
   *
   * Keyed rather than plain: a plain hash of a public URL could be recomputed by anyone,
   * which would let a client mint option tokens for a resolution the server never ran.
   */
  resolutionHash(url: string, provider: string): string {
    return (
      createHmac('sha256', this.config.secret)
        // A NUL separator: it cannot occur in either value, so no provider/URL pair
        // can be made to collide with another by moving the boundary.
        .update(`${provider}\u0000${url}`)
        .digest('base64url')
        .slice(0, 22)
    );
  }
}

export type { OptionTokenPayload, InfoTokenPayload };
