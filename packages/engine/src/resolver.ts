import { createHash, createHmac } from 'node:crypto';
import { MAX_INFO_TOKEN_LENGTH } from '@sera/contracts';
import type { DownloadOption, ImportRequest, MediaInfo, MediaItem } from '@sera/contracts/types';
import type { Dispatcher } from 'undici';
import type { EngineConfig } from './config.js';
import { seraError, SeraError } from './errors.js';
import { classifyFailure } from './extract/failure.js';
import { dumpInfo, version as ytdlpVersion } from './extract/ytdlp.js';
import {
  ExtractionRouter,
  type ExtractionBackend,
  type ExtractionOutcome,
} from './extract/router.js';
import type { YtdlpInfo } from './extract/ytdlp-types.js';
import { createLogger, logSafeUrl, type Logger } from './logging.js';
import { normalizeForProvider, ProviderRegistry } from './providers/index.js';
import {
  assertCdnHosts,
  authorUrlFor,
  cdnExpiry,
  importExpired,
  INSTAGRAM_MEDIA_HOSTS,
  isImportedEntries,
  mediaFromImport,
  shortcodeFrom,
  slideCount,
  slidesFrom,
  titleFor,
  type ImportedEntry,
  type MediaHostPolicy,
} from './providers/instagram-media.js';
import type {
  DownloadPlan,
  ProviderContext,
  ResolvedItem,
  ResolvedMedia,
} from './providers/types.js';
import { planKey } from './providers/types.js';
import { createSafeDispatcher, header, safeFetch } from './security/http.js';
import { hostMatchesAny, normalizeUrl, parseUserUrl } from './security/url.js';
import { TtlCache } from './util/cache.js';
import { readToken, signToken, verifyToken } from './util/tokens.js';

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
  /**
   * Where the resolution came from when this server did not make it: `visitor` for a post
   * the visitor's own browser read and sent. Absent on every ordinary resolution.
   */
  readonly o?: 'visitor';
  /**
   * The media approved from that post. A job fetches exactly these and re-resolves nothing,
   * because nothing on this side can read the post again.
   */
  readonly m?: readonly ImportedEntry[];
  /** The post's title and author, for naming files, for the same reason. */
  readonly t?: string;
  readonly a?: string;
  /** The earliest expiry Instagram signed into those URLs, epoch seconds. */
  readonly x?: number;
}

interface ThumbTokenPayload {
  readonly t: string;
}

/** What an imported post signs into its resolution token besides the link. */
interface ImportedSignature {
  readonly entries: readonly ImportedEntry[];
  readonly title: string;
  readonly author?: string;
  readonly expiresAt?: number;
}

/**
 * The lifetime of an imported post whose media URLs carry no expiry of their own. Instagram's
 * always do; one without is unusual enough not to be given the full option lifetime.
 */
const IMPORT_UNSIGNED_TTL_SECONDS = 600;

/**
 * Less than this left, and an import is refused as expired. It is about what choosing a
 * format takes, and a token that lapses while someone is still choosing helps nobody.
 */
const IMPORT_MIN_REMAINING_SECONDS = 60;

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
  /**
   * Where the media of a post a visitor's browser sends may be fetched from. Instagram's CDN
   * unless a test says otherwise; see `EngineOptions.importHosts`.
   */
  readonly importHosts?: MediaHostPolicy;
  /** Overridable so tests can exercise the whole pipeline with no yt-dlp installed. */
  readonly probe?: (
    url: string,
    options: {
      playlist?: boolean;
      flatPlaylist?: boolean;
      signal?: AbortSignal;
      extractorArgs?: readonly string[];
      timeoutMs?: number;
      proxy?: string;
    },
  ) => Promise<YtdlpInfo>;
}

export class MediaResolver {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly registry: ProviderRegistry;
  readonly dispatcher: Dispatcher;
  /** Hosts an imported post's media may come from. The runner checks them on every hop. */
  readonly importHosts: MediaHostPolicy;

  private readonly probeImpl: NonNullable<ResolverDependencies['probe']>;
  /** Short-lived, so submitting a job just after analyzing does not re-hit the provider. */
  private readonly cache = new TtlCache<ExtractionOutcome>(200, 5 * 60_000);

  constructor(deps: ResolverDependencies) {
    this.config = deps.config;
    this.importHosts = deps.importHosts ?? INSTAGRAM_MEDIA_HOSTS;
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
      // The bottom rung: the same provider, allowed to answer with a lesser public
      // representation now that nothing else has answered at all.
      lastResort: (url, providerId, signal) =>
        this.runProvider(url, providerId, signal, { allowDegraded: true }),
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
          ...(options.proxy ? { proxy: options.proxy } : {}),
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

  /**
   * Resolves user input into the client model.
   *
   * `requestId` is the API's own id for the request, carried only so a log line can be
   * followed from the visitor's request through to the extraction that answered it.
   */
  async resolve(input: string, signal?: AbortSignal, requestId?: string): Promise<MediaInfo> {
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

    let outcome: ExtractionOutcome;
    let used = provider;
    try {
      try {
        outcome = await this.route(canonical, provider.id, signal);
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
          outcome = await this.route(canonical, generic.id, signal);
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
          ...(requestId ? { requestId } : {}),
          provider: used.id,
          source: logSafeUrl(canonical),
          ytdlp: await this.extractorVersion(),
          networkClass: this.config.networkClass,
          durationMs: Date.now() - started,
          errorCode: seraErr.code,
          failureClass: classifyFailure(seraErr),
          detail: seraErr.detail,
        },
        'resolve failed',
      );
      throw seraErr;
    }

    const resolved = outcome.media;
    this.logger.info(
      {
        ...(requestId ? { requestId } : {}),
        provider: used.id,
        source: logSafeUrl(canonical),
        ytdlp: await this.extractorVersion(),
        strategy: outcome.backend,
        networkClass: outcome.networkClass,
        attempts: outcome.attempts,
        ...(outcome.firstFailure ? { firstFailure: outcome.firstFailure } : {}),
        mediaType: resolved.type,
        mediaKinds: [...new Set(resolved.items.map((item) => item.kind))],
        durationMs: Date.now() - started,
        items: resolved.items.length,
      },
      'resolved',
    );

    return this.toMediaInfo(resolved);
  }

  /**
   * Accepts a post the visitor's own signed-in browser read.
   *
   * The answer to "photo posts need an account" that does not put an account on this server.
   * The browser that is already signed in reads the one post it is showing and sends it here.
   * Nothing in the request is believed: the media is derived with the same functions the
   * operator's session route uses, only URLs on Instagram's CDN are admitted, and what was
   * admitted is signed into the resolution token — so a job fetches exactly that, and nothing
   * a client adds afterwards.
   *
   * It makes no request of its own. There is nothing to ask Instagram that the visitor's
   * browser has not just asked, and nothing on this side to ask it with.
   */
  importSubmitted(request: ImportRequest, requestId?: string, now = Date.now()): MediaInfo {
    const started = Date.now();
    let source = '(unparsed)';

    try {
      const { url } = parseUserUrl(request.url, {
        allowPrivateAddresses: this.config.allowPrivateAddresses,
      });
      source = logSafeUrl(url);
      if (hostMatchesAny(url.hostname, this.config.blockedHosts)) {
        throw seraError('UNSUPPORTED_SOURCE', { detail: 'host is on the deny list' });
      }
      const provider = this.registry.detect(url);
      if (provider?.id !== 'instagram' || !provider.capabilities.browserImport) {
        throw seraError('UNSUPPORTED_SOURCE', {
          message: 'Only Instagram posts can be sent from your browser.',
          detail: `import: no importing provider for ${url.hostname}`,
        });
      }

      const canonical = normalizeUrl(normalizeForProvider(provider, url));
      const shortcode = shortcodeFrom(canonical);
      if (!shortcode) {
        throw seraError('UNSUPPORTED_SOURCE', {
          message: 'Open a single post on Instagram, then send it.',
          detail: 'import: the link is not a post',
        });
      }
      // A consistency check, not a boundary: the sender controls both values. What it catches
      // is an honest race, the page moving on to another post between reading one and
      // sending it.
      if (request.node.code !== undefined && request.node.code !== shortcode) {
        throw seraError('INVALID_URL', {
          message: "That post doesn't match the page it was sent from.",
          hint: 'Reload the post on Instagram and send it again.',
          detail: 'import: the shortcode does not match the link',
        });
      }

      const count = slideCount(request.node);
      if (count > this.config.maxItemsPerJob) {
        throw seraError('TOO_LARGE', {
          message: `A single download can include at most ${this.config.maxItemsPerJob} items.`,
          detail: `import: ${count} slides`,
        });
      }
      const slides = slidesFrom(request.node, count);
      if (!slides.length) {
        throw seraError('MEDIA_UNAVAILABLE', {
          message: 'That post has no photos or videos to download.',
          detail: 'import: no usable media',
        });
      }

      const entries = slides.map((slide) => slide.entry);
      // The thumbnails as well: the proxy fetches those, so they are destinations too.
      assertCdnHosts(
        [
          ...entries.map((entry) => entry.url),
          ...slides.flatMap((slide) => (slide.thumbnailUrl ? [slide.thumbnailUrl] : [])),
        ],
        this.importHosts,
      );

      const { ttlSeconds, expiresAt } = this.importLifetime(entries, now);
      const { title, author } = titleFor(request.node);
      const resolved = mediaFromImport({
        url: canonical.toString(),
        title,
        ...(author ? { author } : {}),
        entries,
      });

      // What the person choosing sees and a job has no use for, laid over the resolution the
      // job will rebuild. None of it is signed, so none of it can change what gets fetched.
      const authorUrl = authorUrlFor(request.node);
      const cover = slides[0]?.thumbnailUrl;
      const presented: ResolvedMedia = {
        ...resolved,
        ...(authorUrl ? { authorUrl } : {}),
        ...(cover ? { thumbnailUrl: cover } : {}),
        items: resolved.items.map((item, index) => {
          const slide = slides[index];
          return {
            ...item,
            ...(slide ? { title: slide.title } : {}),
            ...(slide?.thumbnailUrl ? { thumbnailUrl: slide.thumbnailUrl } : {}),
          };
        }),
      };

      const info = this.toMediaInfo(presented, {
        ttlSeconds,
        imported: {
          entries,
          title,
          ...(author ? { author } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      });
      // Refused where the token is made, so the ceiling is never discovered at the moment
      // someone presses Download.
      if (info.id.length > MAX_INFO_TOKEN_LENGTH) {
        throw seraError('TOO_LARGE', {
          message: 'That post is too large to download in one go.',
          detail: `import: a resolution token of ${info.id.length} characters`,
        });
      }

      this.logger.info(
        {
          ...(requestId ? { requestId } : {}),
          provider: provider.id,
          source,
          strategy: 'visitor-browser',
          mediaType: resolved.type,
          mediaKinds: [...new Set(entries.map((entry) => entry.kind))],
          items: entries.length,
          ttlSeconds,
          durationMs: Date.now() - started,
        },
        'imported',
      );
      return info;
    } catch (error) {
      const failure = SeraError.from(error);
      this.logger.info(
        {
          ...(requestId ? { requestId } : {}),
          provider: 'instagram',
          source,
          strategy: 'visitor-browser',
          errorCode: failure.code,
          detail: failure.detail,
        },
        'import refused',
      );
      throw failure;
    }
  }

  /**
   * How long an imported post stays usable, and when the links in it run out.
   *
   * The ordinary option lifetime, unless Instagram's own signature ends sooner — a token that
   * outlived the URLs inside it would only turn into a 403 at download time. A URL with no
   * expiry signed into it gets a short window instead, because its real lifetime is unknown.
   */
  private importLifetime(
    entries: readonly ImportedEntry[],
    now: number,
  ): { ttlSeconds: number; expiresAt?: number } {
    const nowSeconds = Math.floor(now / 1000);
    const known = entries
      .map((entry) => cdnExpiry(entry.url))
      .filter((expiry): expiry is number => expiry !== undefined);
    const expiresAt = known.length ? Math.min(...known) : undefined;

    if (expiresAt !== undefined && expiresAt - nowSeconds < IMPORT_MIN_REMAINING_SECONDS) {
      throw importExpired('import: the media links have expired, or are about to');
    }

    const bounds = [this.config.optionTtlSeconds];
    if (expiresAt !== undefined) bounds.push(expiresAt - nowSeconds);
    if (known.length < entries.length) bounds.push(IMPORT_UNSIGNED_TTL_SECONDS);
    return {
      ttlSeconds: Math.min(...bounds),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
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
    return (await this.route(canonical, providerId, signal)).media;
  }

  /**
   * Resolution plus where it happened.
   *
   * Through the router rather than straight to the provider, so the job-time
   * re-resolution takes the same backend the analysis did. It has to: a media URL signed
   * for one address is refused from another, so a resolution and its download belong to
   * the same network. The outcome is cached with the media for the same reason a log
   * line carries it — "which network answered this" stays true on a cache hit.
   */
  private async route(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ExtractionOutcome> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `unknown provider ${providerId}` });
    }

    const cacheKey = `${providerId}|${canonical.toString()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const outcome = await this.router.resolve(canonical, providerId, signal);
    // Always assigned, never merged: a node returns a whole `ResolvedMedia` over the
    // wire, and what it says about where it ran is not what decides where the download
    // goes. The router's answer is.
    const media: ResolvedMedia = {
      ...outcome.media,
      ...(outcome.remote ? { remoteBackend: outcome.backend } : { remoteBackend: undefined }),
    };

    if (!media.items.length) throw seraError('MEDIA_UNAVAILABLE');
    const withMedia = { ...outcome, media };
    this.cache.set(cacheKey, withMedia);
    return withMedia;
  }

  /** One attempt on this worker. The router decides whether it is the only one. */
  private async runProvider(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
    options: { allowDegraded?: boolean } = {},
  ): Promise<ResolvedMedia> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `unknown provider ${providerId}` });
    }
    const context = this.providerContext(signal);
    return provider.resolve(
      canonical,
      options.allowDegraded ? { ...context, allowDegraded: true } : context,
    );
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

  toMediaInfo(
    resolved: ResolvedMedia,
    options: { readonly ttlSeconds?: number; readonly imported?: ImportedSignature } = {},
  ): MediaInfo {
    const ttl = options.ttlSeconds ?? this.config.optionTtlSeconds;
    const { imported } = options;
    // Once per resolution, not once per option: an imported carousel's digest covers every
    // URL in it.
    const hash = this.resolutionHash(resolved.url, resolved.provider, imported?.entries);
    const items: MediaItem[] = resolved.items.map((item) =>
      this.toMediaItem(resolved, item, ttl, hash),
    );

    const infoId = signToken<InfoTokenPayload>(
      {
        u: resolved.url,
        p: resolved.provider,
        ...(imported
          ? {
              o: 'visitor' as const,
              m: imported.entries,
              t: imported.title,
              ...(imported.author ? { a: imported.author } : {}),
              ...(imported.expiresAt !== undefined ? { x: imported.expiresAt } : {}),
            }
          : {}),
      },
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

  private toMediaItem(
    resolved: ResolvedMedia,
    item: ResolvedItem,
    ttl: number,
    hash: string,
  ): MediaItem {
    const itemId = `${resolved.provider}:${item.index}`;
    const options: DownloadOption[] = item.plans.map((plan) =>
      this.toDownloadOption(item, plan, itemId, ttl, hash),
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
    item: ResolvedItem,
    plan: DownloadPlan,
    itemId: string,
    ttl: number,
    hash: string,
  ): DownloadOption {
    const id = signToken<OptionTokenPayload>(
      {
        h: hash,
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

  /**
   * Recovers a resolution from its token, or throws.
   *
   * Expiry is judged here rather than inside the token check, because what to say depends on
   * what expired. An ordinary resolution is refreshed by analyzing the link again; an imported
   * post cannot be, since the link alone leads straight back to "needs an account".
   */
  verifyInfoId(infoId: string, now = Date.now()): InfoTokenPayload {
    const payload = readToken<InfoTokenPayload>(infoId, this.config.secret);
    if (typeof payload.u !== 'string' || typeof payload.p !== 'string') {
      throw seraError('EXPIRED', { detail: 'malformed info token' });
    }

    const imported = payload.o !== undefined || payload.m !== undefined;
    if (
      imported &&
      (payload.o !== 'visitor' || !isImportedEntries(payload.m) || typeof payload.t !== 'string')
    ) {
      throw seraError('EXPIRED', { detail: 'malformed import token' });
    }

    if (payload.e * 1000 < now) {
      throw imported
        ? importExpired('import token past its expiry')
        : seraError('EXPIRED', { detail: 'token past its expiry' });
    }

    if (payload.m) {
      // Signed here, so these passed when the token was made. Checked again because the host
      // list is allowed to tighten in between, and a token must not outlive that.
      assertCdnHosts(
        payload.m.map((entry) => entry.url),
        this.importHosts,
      );
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
   *
   * An imported post is identified by the media approved from it as well as by its link.
   * Two imports of one post can carry different media — a forged one and a real one, say —
   * and an option minted for one must not be spendable against the other.
   */
  resolutionHash(url: string, provider: string, imported?: readonly ImportedEntry[]): string {
    const hmac = createHmac('sha256', this.config.secret)
      // A NUL separator: it cannot occur in either value, so no provider/URL pair
      // can be made to collide with another by moving the boundary.
      .update(`${provider}\u0000${url}`);
    if (imported) hmac.update(NUL).update('visitor').update(NUL).update(importDigest(imported));
    return hmac.digest('base64url').slice(0, 22);
  }
}

/** The separator byte in a resolution hash. It cannot occur in any of the parts it separates. */
const NUL = Buffer.alloc(1);

/**
 * A digest of an imported post's approved media, over a spelling fixed here rather than
 * whatever key order a trip through JSON happens to produce.
 */
function importDigest(entries: readonly ImportedEntry[]): string {
  const canonical = entries.map((entry) => [
    entry.s,
    entry.kind,
    entry.url,
    entry.w ?? null,
    entry.h ?? null,
    entry.container,
    entry.d ?? null,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

export type { OptionTokenPayload, InfoTokenPayload };
