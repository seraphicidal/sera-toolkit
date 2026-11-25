import type { NodeFeature } from './extract/remote.js';
import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
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
import {
  type DownloadPlan,
  type ProviderContext,
  type ResolvedItem,
  type ResolvedMedia,
  planKey,
} from './providers/types.js';
import { Denylist } from './security/denylist.js';
import { EgressGuard } from './security/egress.js';
import { createSafeDispatcher, discard, header, safeFetch, safeOpen } from './security/http.js';
import {
  hostMatchesAny,
  normalizeUrl,
  parseUserUrl,
  stripWww,
  validateProviderUrl,
} from './security/url.js';
import { TtlCache } from './util/cache.js';
import { InFlightCoalescer } from './util/coalesce.js';
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
  readonly sessionBackend?: (
    feature: NodeFeature,
    providerId?: string,
  ) => ExtractionBackend | undefined;
  readonly importHosts?: MediaHostPolicy;
  readonly probe?: (
    url: string,
    options: {
      providerId?: string;
      playlist?: boolean;
      flatPlaylist?: boolean;
      signal?: AbortSignal;
      extractorArgs?: readonly string[];
      timeoutMs?: number;
      proxy?: string;
      useExtractors?: string;
      maxEntries?: number;
    },
  ) => Promise<YtdlpInfo>;
  readonly egress?: EgressGuard;
  readonly denylist?: Denylist;
}

const RESOLVE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

function estimateOutcomeBytes(outcome: ExtractionOutcome): number {
  let bytes = outcome.rawInfoJson ? Buffer.byteLength(outcome.rawInfoJson, 'utf8') : 0;
  try {
    bytes += Buffer.byteLength(JSON.stringify(outcome.media), 'utf8');
  } catch {
    bytes += 4096;
  }
  return bytes;
}

export class MediaResolver {
  readonly config: EngineConfig;
  readonly logger: Logger;
  readonly registry: ProviderRegistry;
  readonly dispatcher: Dispatcher;
  readonly importHosts: MediaHostPolicy;
  readonly egress: EgressGuard;
  readonly denylist: Denylist;

  private readonly probeImpl: NonNullable<ResolverDependencies['probe']>;
  private readonly cache = new TtlCache<ExtractionOutcome>(200, 5 * 60_000, {
    maxBytes: RESOLVE_CACHE_MAX_BYTES,
    sizeOf: estimateOutcomeBytes,
  });
  private readonly inFlightResolves = new InFlightCoalescer<ExtractionOutcome>();

  constructor(deps: ResolverDependencies) {
    this.config = deps.config;
    this.importHosts = deps.importHosts ?? INSTAGRAM_MEDIA_HOSTS;
    this.logger =
      deps.logger ??
      createLogger({ level: deps.config.logLevel, pretty: !deps.config.isProduction });
    this.registry = deps.registry ?? new ProviderRegistry(undefined, deps.config);
    this.denylist =
      deps.denylist ??
      new Denylist({
        staticHosts: deps.config.blockedHosts,
        filePath: deps.config.dataDir ? join(deps.config.dataDir, 'denylist.json') : undefined,
        canonicalizeUrl: (url) => {
          const provider = this.registry.detect(url);
          return provider ? normalizeForProvider(provider, url) : url;
        },
      });
    this.egress =
      deps.egress ??
      new EgressGuard({
        allowPrivateAddresses: deps.config.allowPrivateAddresses,
        isBlockedHost: (hostname) =>
          hostMatchesAny(hostname, deps.config.blockedHosts) ||
          this.denylist.isBlockedHost(hostname),
        isBlockedUrl: (url) => this.isBlocked(url),
      });
    this.denylist.onUpdate(() => this.cache.clear());

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
      preferRemote: deps.config.extractionNodes.preferNodes,
      authenticated: (providerId) => {
        const feature = this.registry.get(providerId)?.nodeSession;
        return feature ? deps.sessionBackend?.(feature, providerId) : undefined;
      },
      lastResort: (url, providerId, signal) =>
        this.runProvider(url, providerId, signal, { allowDegraded: true }),
    });
    this.dispatcher =
      deps.dispatcher ??
      createSafeDispatcher({ allowPrivateAddresses: deps.config.allowPrivateAddresses });

    this.probeImpl =
      deps.probe ??
      (async (url, options = {}) => {
        const upstream = options.proxy ?? this.config.proxyFor(options.providerId ?? '');
        const proxy = await this.egressProxy(url, upstream);
        return dumpInfo(url, {
          binary: this.config.ytdlpPath,
          ffmpegPath: this.config.ffmpegPath,
          timeoutMs: options.timeoutMs ?? this.config.resolveTimeoutSeconds * 1000,
          ...(options.playlist !== undefined ? { playlist: options.playlist } : {}),
          ...(options.flatPlaylist !== undefined ? { flatPlaylist: options.flatPlaylist } : {}),
          ...(options.extractorArgs?.length ? { extractorArgs: options.extractorArgs } : {}),
          ...(options.useExtractors ? { useExtractors: options.useExtractors } : {}),
          ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
          ...(proxy ? { proxy } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      });
  }

  async egressProxy(url: string | URL, upstreamProxy?: string): Promise<string> {
    await this.egress.assertPublicDestination(url);
    return this.egress.proxyUrl(upstreamProxy);
  }

  isBlocked(target: string | URL): boolean {
    try {
      const url = typeof target === 'string' ? new URL(target) : target;
      return (
        this.denylist.isBlocked(url).blocked ||
        hostMatchesAny(url.hostname, this.config.blockedHosts)
      );
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.egress.close();
  }

  private async extractorVersion(): Promise<string> {
    try {
      return await ytdlpVersion(this.config.ytdlpPath);
    } catch {
      return 'unknown';
    }
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

    const block = this.denylist.isBlocked(url);
    if (block.blocked || hostMatchesAny(url.hostname, this.config.blockedHosts)) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: block.reason ?? 'host is on the deny list' });
    }

    if (!this.config.allowPrivateAddresses) {
      try {
        await this.egress.assertPublicDestination(url);
      } catch (error) {
        if (error instanceof SeraError && error.code === 'BLOCKED_ADDRESS') {
          this.logger.warn(
            { url: logSafeUrl(url), detail: error.detail },
            'Blocked attempt to access private destination',
          );
        }
        throw error;
      }
    }

    const provider = this.registry.detect(url);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `no provider for ${url.hostname}` });
    }

    const canonical = normalizeUrl(normalizeForProvider(provider, url));
    if (this.isBlocked(canonical)) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'This URL has been blocked' });
    }
    if (!this.config.allowPrivateAddresses && canonical.hostname !== url.hostname) {
      await this.egress.assertPublicDestination(canonical);
    }
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
      if (
        this.denylist.isBlocked(url).blocked ||
        hostMatchesAny(url.hostname, this.config.blockedHosts)
      ) {
        throw seraError('UNSUPPORTED_SOURCE', { detail: 'This URL has been blocked' });
      }
      const provider = this.registry.detect(url);
      if (provider?.id !== 'instagram' || !provider.capabilities.browserImport) {
        throw seraError('UNSUPPORTED_SOURCE', {
          message: 'Only Instagram posts can be sent from your browser.',
          detail: `import: no importing provider for ${url.hostname}`,
        });
      }

      const canonical = normalizeUrl(normalizeForProvider(provider, url));
      if (this.isBlocked(canonical)) {
        throw seraError('UNSUPPORTED_SOURCE', { detail: 'This URL has been blocked' });
      }
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
    if (
      this.denylist.isBlocked(canonical).blocked ||
      hostMatchesAny(canonical.hostname, this.config.blockedHosts)
    ) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'This URL has been blocked' });
    }
    if (!this.config.allowPrivateAddresses) {
      await this.egress.assertPublicDestination(canonical);
    }
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

    return await this.inFlightResolves.run(
      cacheKey,
      async (coalescedSignal) => {
        const outcome = await this.router.resolve(canonical, providerId, coalescedSignal);
        const sanitizedMedia = outcome.remote
          ? this.validateRemoteMedia(outcome.media, providerId, canonical)
          : outcome.media;
        const media: ResolvedMedia = {
          ...sanitizedMedia,
          ...(outcome.remote ? { remoteBackend: outcome.backend } : { remoteBackend: undefined }),
        };

        if (!media.items.length) throw seraError('MEDIA_UNAVAILABLE');
        const usesYtdlp = media.items.some((item) =>
          item.plans.some((plan) => plan.fetch.via === 'ytdlp'),
        );
        const withMedia: ExtractionOutcome = {
          ...outcome,
          media,
          ...(usesYtdlp && outcome.rawInfoJson
            ? { rawInfoJson: outcome.rawInfoJson }
            : { rawInfoJson: undefined }),
        };
        this.cache.set(cacheKey, withMedia);
        if (!outcome.remote && media.url !== canonical.toString()) {
          let allowSecondary = false;
          try {
            const parsedMediaUrl = new URL(media.url);
            if (!this.isBlocked(parsedMediaUrl)) {
              allowSecondary =
                providerId === 'generic'
                  ? parsedMediaUrl.origin === canonical.origin
                  : provider.canHandle(parsedMediaUrl, stripWww(parsedMediaUrl.hostname));
            }
          } catch {
            allowSecondary = false;
          }
          if (allowSecondary) {
            this.cache.set(`${providerId}|${media.url}`, withMedia);
          }
        }
        return withMedia;
      },
      signal,
    );
  }

  getCached(providerId: string, url: string): ExtractionOutcome | undefined {
    return this.cache.get(`${providerId}|${url}`);
  }

  setCached(providerId: string, url: string, outcome: ExtractionOutcome): void {
    this.cache.set(`${providerId}|${url}`, outcome);
  }

  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  private validateRemoteMedia(
    media: ResolvedMedia,
    expectedProviderId: string,
    canonical: URL,
  ): ResolvedMedia {
    if (media.provider !== expectedProviderId) {
      throw seraError('PROVIDER_UNAVAILABLE', {
        detail: `remote: provider mismatch (${media.provider} != ${expectedProviderId})`,
      });
    }
    const urlCheckOptions = {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
      blockedHosts: this.config.blockedHosts,
      allowUrl: (candidate: string | URL) => {
        const parsed = typeof candidate === 'string' ? new URL(candidate) : candidate;
        if (this.isBlocked(parsed)) {
          throw seraError('UNSUPPORTED_SOURCE', { detail: 'remote: url is blocked' });
        }
        return parsed;
      },
    };
    const safeMainUrl = validateProviderUrl(media.url, urlCheckOptions);
    if (!safeMainUrl) {
      throw seraError('PROVIDER_UNAVAILABLE', { detail: 'remote: invalid media url' });
    }
    const safeThumb = media.thumbnailUrl
      ? validateProviderUrl(media.thumbnailUrl, urlCheckOptions)
      : undefined;
    const safeAuthorUrl = media.authorUrl
      ? validateProviderUrl(media.authorUrl, urlCheckOptions)
      : undefined;

    const items: ResolvedItem[] = media.items.map((item) => {
      const itemThumb = item.thumbnailUrl
        ? validateProviderUrl(item.thumbnailUrl, urlCheckOptions)
        : undefined;
      const itemFallbackThumb = item.thumbnailFallbackUrl
        ? validateProviderUrl(item.thumbnailFallbackUrl, urlCheckOptions)
        : undefined;
      const plans: DownloadPlan[] = [];
      for (const plan of item.plans) {
        if (plan.fetch.via === 'direct') {
          const validDirect = validateProviderUrl(plan.fetch.url, urlCheckOptions);
          if (!validDirect) continue;
          plans.push({ ...plan, fetch: { via: 'direct', url: validDirect } });
        } else {
          if (plan.fetch.target !== undefined) {
            const validTarget = validateProviderUrl(plan.fetch.target, urlCheckOptions);
            if (!validTarget) continue;
            plans.push({ ...plan, fetch: { ...plan.fetch, target: validTarget } });
          } else {
            plans.push(plan);
          }
        }
      }
      if (!plans.length) {
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: 'remote: resolved item had no safe fetch plans',
        });
      }
      const {
        thumbnailUrl: _droppedThumb,
        thumbnailFallbackUrl: _droppedFallback,
        ...restItem
      } = item;
      return {
        ...restItem,
        ...(itemThumb ? { thumbnailUrl: itemThumb } : {}),
        ...(itemFallbackThumb ? { thumbnailFallbackUrl: itemFallbackThumb } : {}),
        plans,
      };
    });

    const { thumbnailUrl: _droppedMediaThumb, authorUrl: _droppedAuthorUrl, ...restMedia } = media;
    return {
      ...restMedia,
      url: canonical.toString(),
      ...(safeThumb ? { thumbnailUrl: safeThumb } : {}),
      ...(safeAuthorUrl ? { authorUrl: safeAuthorUrl } : {}),
      items,
    };
  }

  private async runProvider(
    canonical: URL,
    providerId: string,
    signal?: AbortSignal,
    options: { allowDegraded?: boolean } = {},
  ): Promise<ResolvedMedia | { readonly media: ResolvedMedia; readonly rawInfoJson?: string }> {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: `unknown provider ${providerId}` });
    }
    let rawInfoJson: string | undefined;
    const baseContext = this.providerContext(signal);
    const context: ProviderContext = {
      ...baseContext,
      probe: async (url, probeOptions) => {
        const info = await baseContext.probe(url, probeOptions);
        if (info._rawJson) {
          rawInfoJson = info._rawJson;
        }
        return info;
      },
    };
    const media = await provider.resolve(
      canonical,
      options.allowDegraded ? { ...context, allowDegraded: true } : context,
    );
    return rawInfoJson ? { media, rawInfoJson } : media;
  }

  private providerContext(signal?: AbortSignal): ProviderContext {
    const allowCandidate = (candidate: URL) =>
      !hostMatchesAny(candidate.hostname, this.config.blockedHosts) &&
      !this.denylist.isBlocked(candidate).blocked;
    const allowUrl = (candidate: string | URL): URL => {
      const { url: parsed } = parseUserUrl(
        typeof candidate === 'string' ? candidate : candidate.toString(),
        { allowPrivateAddresses: this.config.allowPrivateAddresses },
      );
      if (!allowCandidate(parsed)) {
        throw seraError('UNSUPPORTED_SOURCE', { detail: 'Host or URL is blocked' });
      }
      return parsed;
    };
    return {
      config: this.config,
      logger: this.logger,
      ...(signal ? { signal } : {}),
      allowUrl,
      egressProxy: (target, upstreamProxy) => this.egressProxy(target, upstreamProxy),
      dispatcher: this.dispatcher,
      probe: (url, options) => this.probeImpl(url, { ...options, ...(signal ? { signal } : {}) }),
      fetchText: async (url, maxBytes, options) => {
        const response = await safeFetch(url, {
          dispatcher: this.dispatcher,
          timeoutMs: this.config.resolveTimeoutSeconds * 1000,
          maxBytes: maxBytes ?? 2 * 1024 * 1024,
          allowUrl: allowCandidate,
          allowPrivateAddresses: this.config.allowPrivateAddresses,
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
          allowUrl: allowCandidate,
          allowPrivateAddresses: this.config.allowPrivateAddresses,
          ...(signal ? { signal } : {}),
        });
        if (response.status === 405 || response.status === 403 || response.status === 501) {
          const opened = await safeOpen(url, {
            dispatcher: this.dispatcher,
            method: 'GET',
            headers: { range: 'bytes=0-0' },
            timeoutMs: this.config.resolveTimeoutSeconds * 1000,
            allowUrl: allowCandidate,
            allowPrivateAddresses: this.config.allowPrivateAddresses,
            ...(signal ? { signal } : {}),
          });
          discard(opened.body);
          const rangeContentType = header(opened.headers, 'content-type');
          const rangeTotal = parseContentRangeTotal(header(opened.headers, 'content-range'));
          const fallbackLen =
            opened.status === 200 ? Number(header(opened.headers, 'content-length')) : NaN;
          const length =
            rangeTotal ??
            (Number.isFinite(fallbackLen) && fallbackLen > 0 ? fallbackLen : undefined);
          return {
            status: opened.status === 206 ? 200 : opened.status,
            ...(rangeContentType ? { contentType: rangeContentType } : {}),
            ...(length !== undefined ? { contentLength: length } : {}),
            url: opened.url,
          };
        }
        const contentType = header(response.headers, 'content-type');
        const length = Number(header(response.headers, 'content-length'));
        return {
          status: response.status,
          ...(contentType ? { contentType } : {}),
          ...(Number.isFinite(length) && length > 0 ? { contentLength: length } : {}),
          url: response.url,
        };
      },
      open: async (url, options) => {
        return safeOpen(url, {
          dispatcher: this.dispatcher,
          method: options?.method ?? 'GET',
          followRedirects: options?.followRedirects ?? true,
          timeoutMs: options?.timeoutMs ?? this.config.resolveTimeoutSeconds * 1000,
          allowUrl: allowCandidate,
          allowPrivateAddresses: this.config.allowPrivateAddresses,
          ...(options?.headers ? { headers: options.headers } : {}),
          ...(options?.signal ? { signal: options.signal } : signal ? { signal } : {}),
        });
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
    if (
      'u' in payload ||
      'p' in payload ||
      'h' in payload ||
      'm' in payload ||
      typeof payload.t !== 'string' ||
      !/^https?:\/\//i.test(payload.t)
    ) {
      throw seraError('NOT_FOUND', { detail: 'thumbnail token without url' });
    }
    const { url } = parseUserUrl(payload.t, {
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    });
    if (hostMatchesAny(url.hostname, this.config.blockedHosts)) {
      throw seraError('BLOCKED_ADDRESS', { detail: 'host is on the deny list' });
    }
    if (this.denylist.isBlocked(url).blocked) {
      throw seraError('UNSUPPORTED_SOURCE', { detail: 'Blocked thumbnail host' });
    }
    return url.toString();
  }

  verifyInfoId(infoId: string, now = Date.now()): InfoTokenPayload {
    const payload = readToken<InfoTokenPayload>(infoId, this.config.secret, MAX_INFO_TOKEN_LENGTH);
    if ('h' in payload || typeof payload.u !== 'string' || typeof payload.p !== 'string') {
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
      'u' in payload ||
      't' in payload ||
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

function parseContentRangeTotal(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value.trim());
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

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
