import type { NodeFeature } from './extract/remote.js';
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

interface OptionTokenPayload {
  readonly h: string;
  readonly i: number;
  readonly s?: string;
  readonly k: string;
  readonly d?: number;
}

interface InfoTokenPayload {
  readonly u: string;
  readonly p: string;
  readonly o?: 'visitor';
  readonly m?: readonly ImportedEntry[];
  readonly t?: string;
  readonly a?: string;
  readonly x?: number;
}

interface ThumbTokenPayload {
  readonly t: string;
}

interface ImportedSignature {
  readonly entries: readonly ImportedEntry[];
  readonly title: string;
  readonly author?: string;
  readonly expiresAt?: number;
}

const IMPORT_UNSIGNED_TTL_SECONDS = 600;

const IMPORT_MIN_REMAINING_SECONDS = 60;

export interface ResolverDependencies {
  readonly config: EngineConfig;
  readonly logger?: Logger;
  readonly registry?: ProviderRegistry;
  readonly dispatcher?: Dispatcher;
  readonly remoteBackends?: () => readonly ExtractionBackend[];
  readonly sessionBackend?: (feature: NodeFeature) => ExtractionBackend | undefined;
  readonly importHosts?: MediaHostPolicy;
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
  readonly importHosts: MediaHostPolicy;

  private readonly probeImpl: NonNullable<ResolverDependencies['probe']>;
  private readonly cache = new TtlCache<ExtractionOutcome>(200, 5 * 60_000);

  constructor(deps: ResolverDependencies) {
    this.config = deps.config;
    this.importHosts = deps.importHosts ?? INSTAGRAM_MEDIA_HOSTS;
    this.logger =
      deps.logger ??
      createLogger({ level: deps.config.logLevel, pretty: !deps.config.isProduction });
    this.registry = deps.registry ?? new ProviderRegistry(undefined, deps.config);

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
      capabilitiesOf: (providerId) => this.registry.get(providerId)?.capabilities,
      authenticated: (providerId) => {
        const feature = this.registry.get(providerId)?.nodeSession;
        return feature ? deps.sessionBackend?.(feature) : undefined;
      },
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

  private cachedExtractorVersion: string | undefined;

  private async extractorVersion(): Promise<string> {
    const cached = this.cachedExtractorVersion;
    if (cached) return cached;
    const resolved = await ytdlpVersion(this.config.ytdlpPath).catch(() => 'unknown');
    this.cachedExtractorVersion = resolved;
    return resolved;
  }

  private readonly router: ExtractionRouter;

  sourceOf(input: string): string {
    try {
      const { url } = parseUserUrl(input, {
        allowPrivateAddresses: this.config.allowPrivateAddresses,
      });
      return this.registry.detect(url)?.id ?? 'other';
    } catch {
      return 'other';
    }
  }

  async resolve(input: string, signal?: AbortSignal, requestId?: string): Promise<MediaInfo> {
    const { url } = parseUserUrl(input, {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    });

    if (hostMatchesAny(url.hostname, this.config.blockedHosts)) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'host is on the deny list' });
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
          const refusal = SeraError.from(fallbackError);
          throw refusal.detail?.startsWith('robots.txt disallows') ? refusal : error;
        }
        used = generic;
      }
      this.registry.markHealthy(used.id);
    } catch (error) {
      const seraErr = SeraError.from(error);
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

  async resolveCanonical(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedMedia> {
    return (await this.route(canonical, providerId, signal)).media;
  }

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
    const media: ResolvedMedia = {
      ...outcome.media,
      ...(outcome.remote ? { remoteBackend: outcome.backend } : { remoteBackend: undefined }),
    };

    if (!media.items.length) throw seraError('MEDIA_UNAVAILABLE');
    const withMedia = { ...outcome, media };
    this.cache.set(cacheKey, withMedia);
    return withMedia;
  }

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
          ...(options?.keepCookies ? { keepCookies: true } : {}),
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

  toMediaInfo(
    resolved: ResolvedMedia,
    options: { readonly ttlSeconds?: number; readonly imported?: ImportedSignature } = {},
  ): MediaInfo {
    const ttl = options.ttlSeconds ?? this.config.optionTtlSeconds;
    const { imported } = options;
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
      ...(item.subtitles?.length ? { subtitles: item.subtitles } : {}),
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
        ...(item.duration !== undefined ? { d: item.duration } : {}),
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

  thumbnailPath(url: string): string {
    const token = signToken<ThumbTokenPayload>(
      { t: url },
      this.config.secret,
      this.config.optionTtlSeconds,
    );
    return `/api/thumb/${encodeURIComponent(token)}`;
  }

  verifyThumbnailToken(token: string): string {
    const payload = verifyToken<ThumbTokenPayload>(token, this.config.secret);
    if (typeof payload.t !== 'string' || !payload.t) {
      throw seraError('NOT_FOUND', { detail: 'thumbnail token without url' });
    }
    return payload.t;
  }

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

  resolutionHash(url: string, provider: string, imported?: readonly ImportedEntry[]): string {
    const hmac = createHmac('sha256', this.config.secret).update(`${provider}\u0000${url}`);
    if (imported) hmac.update(NUL).update('visitor').update(NUL).update(importDigest(imported));
    return hmac.digest('base64url').slice(0, 22);
  }
}

const NUL = Buffer.alloc(1);

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
