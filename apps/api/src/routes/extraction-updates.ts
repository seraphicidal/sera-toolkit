import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  nodeUpdateManifestSchema,
  type AndroidNodeAppUpdateInfo,
  type NodeUpdateManifest,
  type ProviderHotConfig,
  type YtdlpUpdateInfo,
} from '@sera/contracts';
import {
  hostMatchesAny,
  InFlightCoalescer,
  isPublicAddress,
  isIpLiteral,
  safeFetch,
  safeOpen,
  seraError,
  type SeraEngine,
} from '@sera/engine';
import { z } from 'zod';
import { matchesToken } from '../plugins/client.js';

const DEFAULT_ANDROID_REPO = 'seraphicidal/sera-toolkit';
const DEFAULT_YTDLP_VERSION = '2026.10.26';
const DEFAULT_YTDLP_REPO = 'yt-dlp/yt-dlp';
const DEFAULT_YTDLP_CHECKSUM_ASSET = 'SHA2-256SUMS';
const DEFAULT_YTDLP_ASSET = 'yt-dlp';
const DEFAULT_INSTAGRAM_APP_ID = '936619743392459';
const DEFAULT_INSTAGRAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MANIFEST_FETCH_TIMEOUT_MS = 8_000;
const ARTIFACT_FETCH_TIMEOUT_MS = 120_000;
const MAX_YTDLP_BYTES = 64 * 1024 * 1024;
const MAX_APK_BYTES = 256 * 1024 * 1024;
const MAX_JSON_MANIFEST_BYTES = 2 * 1024 * 1024;

const httpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'URL must use http or https.');

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

const toolsManifestSchema = z.object({
  ytdlp: z.object({
    version: z.string().min(1),
    repo: z.string().min(1).default(DEFAULT_YTDLP_REPO),
    checksumAsset: z.string().min(1).default(DEFAULT_YTDLP_CHECKSUM_ASSET),
    assets: z.record(z.string(), z.string().min(1)),
  }),
});

const androidNodeAppOverrideSchema = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(64),
  sha256: sha256Schema,
  apkUrl: httpUrlSchema,
  proxyPath: z.string().min(1).max(256).optional(),
  releaseNotes: z.string().max(8000).optional(),
  minVersionCode: z.number().int().positive().optional(),
});

const androidReleaseManifestAssetSchema = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(64),
  sha256: sha256Schema,
  apkUrl: httpUrlSchema.optional(),
  assetName: z.string().min(1).max(128).optional(),
  releaseNotes: z.string().max(8000).optional(),
  minVersionCode: z.number().int().positive().optional(),
});

const manifestOverrideSchema = z.object({
  ytdlp: z
    .object({
      version: z.string().min(1).max(64).optional(),
      assetName: z.string().min(1).max(128).optional(),
      sha256: sha256Schema.optional(),
      url: httpUrlSchema.optional(),
    })
    .optional(),
  androidNodeApp: androidNodeAppOverrideSchema.optional(),
  providerConfig: z
    .object({
      youtube: z
        .object({
          playerClients: z.array(z.string().min(1).max(64)).max(20).optional(),
          extraArgs: z.array(z.string().min(1).max(500)).max(50).optional(),
          remoteComponents: z.array(z.string().min(1).max(128)).max(20).optional(),
          potProviderUrl: httpUrlSchema.optional(),
        })
        .optional(),
      instagram: z
        .object({
          webApiAppId: z.string().min(1).max(64).optional(),
          userAgent: z.string().min(1).max(512).optional(),
          cdnHosts: z.array(z.string().min(1).max(256)).min(1).max(50).optional(),
          strategyOrder: z
            .array(z.enum(['ytdlp', 'web-api', 'oembed']))
            .min(1)
            .max(10)
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const githubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: httpUrlSchema,
});

const githubReleaseSchema = z.object({
  tag_name: z.string().default(''),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  body: z.string().nullable().optional(),
  assets: z.array(githubAssetSchema).default([]),
});

const ytdlpQuerySchema = z.object({
  asset: z.string().min(1).max(128).optional(),
});

export interface NodeAuthIdentity {
  readonly nodeId: string;
  readonly isLegacy?: boolean;
}

export function authenticateExtractionNode(
  request: FastifyRequest,
  reply: FastifyReply,
  engine: SeraEngine,
): NodeAuthIdentity | undefined {
  const { config } = engine;
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) {
    void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return undefined;
  }
  for (const [nodeId, token] of config.extractionNodes.tokens) {
    if (matchesToken(presented, token)) return { nodeId };
  }
  if (
    config.extractionNodes.legacyTokenUsed &&
    config.extractionNodes.token &&
    matchesToken(presented, config.extractionNodes.token)
  ) {
    return { nodeId: 'legacy', isLegacy: true };
  }
  void reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  return undefined;
}

export function extractionInternalRateLimit(engine: SeraEngine) {
  const { config } = engine;
  return {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        allowList: (request: FastifyRequest) => {
          const header = request.headers.authorization ?? '';
          const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
          if (!presented) return false;
          for (const token of config.extractionNodes.tokens.values()) {
            if (matchesToken(presented, token)) return true;
          }
          if (
            config.extractionNodes.legacyTokenUsed &&
            config.extractionNodes.token &&
            matchesToken(presented, config.extractionNodes.token)
          ) {
            return true;
          }
          return Boolean(
            config.extractionNodes.workerToken &&
            matchesToken(presented, config.extractionNodes.workerToken),
          );
        },
      },
    },
  };
}

export interface ExtractionUpdatesOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly toolsManifestPath?: string;
  readonly githubApiBase?: string;
  readonly githubDownloadBase?: string;
  readonly androidRepo?: string;
  readonly cacheTtlMs?: number;
  readonly enableRemoteLookup?: boolean;
  readonly ytdlpTrack?: 'pinned' | 'latest';
  readonly githubToken?: string;
  readonly extraYoutubeArgs?: readonly string[];
  readonly remoteComponents?: readonly string[];
}

export interface ResolvedUpdateArtifact {
  readonly kind: 'ytdlp' | 'apk';
  readonly assetName: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly manifestHash: string;
  readonly cachePath?: string;
  readonly buffer?: Buffer;
}

export interface ExtractionUpdatesService {
  currentManifestHash(): Promise<string>;
  getManifest(options?: { readonly forceRefresh?: boolean }): Promise<NodeUpdateManifest>;
  resolveArtifact(kind: 'ytdlp' | 'apk', assetOverride?: string): Promise<ResolvedUpdateArtifact>;
  refreshInBackground(): void;
}

type ToolsManifest = z.infer<typeof toolsManifestSchema>;
type ManifestOverride = z.infer<typeof manifestOverrideSchema>;

export function createExtractionUpdatesService(
  engine: SeraEngine,
  options: ExtractionUpdatesOptions = {},
): ExtractionUpdatesService {
  const { config, logger } = engine;
  const toolsManifestPath = options.toolsManifestPath ?? locateToolsManifestPath();
  const githubApiBase = (options.githubApiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const githubDownloadBase = (options.githubDownloadBase ?? 'https://github.com').replace(
    /\/+$/,
    '',
  );
  const envAndroidRepo = process.env.SERA_UPDATES_ANDROID_REPO?.trim();
  const androidRepo =
    options.androidRepo ??
    (envAndroidRepo && envAndroidRepo.length > 0 ? envAndroidRepo : DEFAULT_ANDROID_REPO);
  const githubToken = options.githubToken ?? process.env.SERA_GITHUB_TOKEN?.trim() ?? '';
  const cacheTtlMs = options.cacheTtlMs ?? parseTtlMs(process.env.SERA_UPDATES_TTL_SECONDS);
  const enableRemoteLookup =
    options.enableRemoteLookup ??
    parseBoolEnv(process.env.SERA_UPDATES_GITHUB_FETCH, config.nodeEnv !== 'test');
  const ytdlpTrack =
    options.ytdlpTrack ??
    (process.env.SERA_UPDATES_YTDLP_TRACK === 'latest' ||
    parseBoolEnv(process.env.SERA_UPDATES_YTDLP_LATEST, false)
      ? 'latest'
      : 'pinned');
  const defaultExtraArgs =
    options.extraYoutubeArgs ?? parseExtraArgs(process.env.SERA_YOUTUBE_EXTRA_ARGS);
  const defaultRemoteComponents =
    options.remoteComponents ??
    parseCsvEnv(process.env.SERA_YOUTUBE_REMOTE_COMPONENTS, ['ejs:github']);

  const updatesDir = config.dataDir ? join(config.dataDir, 'updates') : undefined;
  const cacheDir = updatesDir ? join(updatesDir, 'cache') : undefined;
  const manifestOverridePath = updatesDir ? join(updatesDir, 'manifest.json') : undefined;
  const androidOverridePath = updatesDir ? join(updatesDir, 'android-node.json') : undefined;

  let cachedToolsManifest: { signature: string; value: ToolsManifest } | undefined;
  let cachedLocalOverrides: {
    signature: string;
    manifest?: ManifestOverride;
    android?: AndroidNodeAppUpdateInfo;
  } = { signature: '' };
  let cachedRemote: {
    fetchedAt: number;
    latestYtdlpVersion?: string;
    androidApp?: AndroidNodeAppUpdateInfo;
  } = { fetchedAt: 0 };
  const ytdlpShaCache = new Map<string, string>();
  let manifestSnapshot: { key: string; value: NodeUpdateManifest } | undefined;
  let refreshPromise: Promise<void> | undefined;
  const artifactCoalescer = new InFlightCoalescer<ResolvedUpdateArtifact>();

  const loadToolsManifest = async (): Promise<ToolsManifest> => {
    const sig = await fileSignature(toolsManifestPath);
    if (cachedToolsManifest?.signature === sig) {
      return cachedToolsManifest.value;
    }
    try {
      const raw = await readFile(toolsManifestPath, 'utf8');
      const parsed = toolsManifestSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        cachedToolsManifest = { signature: sig, value: parsed.data };
        return parsed.data;
      }
    } catch {}
    const fallback: ToolsManifest = {
      ytdlp: {
        version: DEFAULT_YTDLP_VERSION,
        repo: DEFAULT_YTDLP_REPO,
        checksumAsset: DEFAULT_YTDLP_CHECKSUM_ASSET,
        assets: { 'android-arm64': DEFAULT_YTDLP_ASSET },
      },
    };
    cachedToolsManifest = { signature: sig, value: fallback };
    return fallback;
  };

  const loadLocalOverrides = async (): Promise<{
    manifest?: ManifestOverride;
    android?: AndroidNodeAppUpdateInfo;
  }> => {
    const [sigA, sigB] = await Promise.all([
      manifestOverridePath ? fileSignature(manifestOverridePath) : Promise.resolve('none'),
      androidOverridePath ? fileSignature(androidOverridePath) : Promise.resolve('none'),
    ]);
    const signature = `${sigA}|${sigB}`;
    if (cachedLocalOverrides.signature === signature) {
      return cachedLocalOverrides;
    }

    let manifest: ManifestOverride | undefined;
    if (manifestOverridePath) {
      try {
        const raw = await readFile(manifestOverridePath, 'utf8');
        const parsed = manifestOverrideSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          manifest = parsed.data;
        } else {
          logger.warn(
            { path: manifestOverridePath },
            'ignoring malformed updates manifest override',
          );
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          logger.warn(
            { err: error, path: manifestOverridePath },
            'failed to read manifest override',
          );
        }
      }
    }

    let android: AndroidNodeAppUpdateInfo | undefined;
    if (androidOverridePath) {
      try {
        const raw = await readFile(androidOverridePath, 'utf8');
        const json = JSON.parse(raw) as unknown;
        const wrapped =
          typeof json === 'object' && json !== null && 'androidNodeApp' in json
            ? (json as { androidNodeApp: unknown }).androidNodeApp
            : json;
        const parsed = androidNodeAppOverrideSchema.safeParse(wrapped);
        if (parsed.success) {
          android = {
            versionCode: parsed.data.versionCode,
            versionName: parsed.data.versionName,
            sha256: parsed.data.sha256.toLowerCase(),
            apkUrl: parsed.data.apkUrl,
            proxyPath: parsed.data.proxyPath ?? '/internal/extraction/updates/apk',
            ...(parsed.data.releaseNotes ? { releaseNotes: parsed.data.releaseNotes } : {}),
            ...(parsed.data.minVersionCode !== undefined
              ? { minVersionCode: parsed.data.minVersionCode }
              : {}),
          };
        } else {
          logger.warn({ path: androidOverridePath }, 'ignoring malformed android-node override');
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          logger.warn(
            { err: error, path: androidOverridePath },
            'failed to read android-node override',
          );
        }
      }
    }

    cachedLocalOverrides = { signature, manifest, android };
    return cachedLocalOverrides;
  };

  const fetchTextFromUpstream = async (
    targetUrl: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> => {
    const parsedUrl = new URL(targetUrl);
    if (options.fetch) {
      const response = await options.fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      });
      const body = await response.text();
      return { status: response.status, body };
    }
    assertSafeRemoteUrl(parsedUrl, config, githubApiBase, githubDownloadBase);
    const response = await safeFetch(parsedUrl, {
      dispatcher: engine.resolver.dispatcher,
      timeoutMs: MANIFEST_FETCH_TIMEOUT_MS,
      maxBytes: MAX_JSON_MANIFEST_BYTES,
      allowPrivateAddresses: config.allowPrivateAddresses,
      headers,
      allowUrl: (candidate) =>
        isAllowedRemoteUrl(candidate, config, githubApiBase, githubDownloadBase),
    });
    return { status: response.status, body: response.body.toString('utf8') };
  };

  const downloadBinaryFromUpstream = async (
    targetUrl: string,
    maxBytes: number,
    headers: Record<string, string> = {},
  ): Promise<{ buffer?: Buffer; cacheTempPath?: string; sha256: string; sizeBytes: number }> => {
    const parsedUrl = new URL(targetUrl);
    let streamSource: AsyncIterable<Uint8Array>;

    if (options.fetch) {
      const response = await options.fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(ARTIFACT_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: `updates: upstream returned ${response.status}`,
        });
      }
      if (!response.body) {
        throw seraError('PROVIDER_UNAVAILABLE', { detail: 'updates: empty upstream body' });
      }
      streamSource = response.body as unknown as AsyncIterable<Uint8Array>;
    } else {
      assertSafeRemoteUrl(parsedUrl, config, githubApiBase, githubDownloadBase);
      const response = await safeOpen(parsedUrl, {
        dispatcher: engine.resolver.dispatcher,
        timeoutMs: ARTIFACT_FETCH_TIMEOUT_MS,
        allowPrivateAddresses: config.allowPrivateAddresses,
        headers,
        allowUrl: (candidate) =>
          isAllowedRemoteUrl(candidate, config, githubApiBase, githubDownloadBase),
      });
      if (response.status >= 400) {
        response.body.destroy();
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: `updates: upstream returned ${response.status}`,
        });
      }
      streamSource = response.body;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let tempPath: string | undefined;
    const chunks: Buffer[] = [];
    if (cacheDir) {
      try {
        await mkdir(cacheDir, { recursive: true });
        tempPath = join(cacheDir, `dl-${randomUUID()}.tmp`);
        handle = await open(tempPath, 'w');
      } catch {
        handle = undefined;
        tempPath = undefined;
      }
    }

    const hash = createHash('sha256');
    let sizeBytes = 0;

    try {
      for await (const rawChunk of streamSource) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) {
          throw seraError('TOO_LARGE', { detail: 'updates: artifact exceeds max size' });
        }
        hash.update(chunk);
        if (handle) {
          await handle.write(chunk);
        } else {
          chunks.push(chunk);
        }
      }
      if (handle) {
        await handle.close();
        handle = undefined;
      }
      const digest = hash.digest('hex').toLowerCase();
      return {
        ...(tempPath ? { cacheTempPath: tempPath } : { buffer: Buffer.concat(chunks) }),
        sha256: digest,
        sizeBytes,
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const githubHeaders = (): Record<string, string> => ({
    accept: 'application/vnd.github+json',
    'user-agent': 'sera-toolkit/1.0 (+updates)',
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
  });

  const resolveYtdlpSha256 = async (
    repo: string,
    version: string,
    checksumAsset: string,
    assetName: string,
    allowFetch: boolean,
  ): Promise<string | undefined> => {
    const memKey = `${repo}:${version}:${assetName}`;
    const inMem = ytdlpShaCache.get(memKey);
    if (inMem) return inMem;

    const diskKey = `${sanitizeCacheSegment(`ytdlp-${version}-${assetName}`)}.sha256`;
    const diskPath = cacheDir ? join(cacheDir, diskKey) : undefined;
    if (diskPath) {
      try {
        const saved = (await readFile(diskPath, 'utf8')).trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(saved)) {
          ytdlpShaCache.set(memKey, saved);
          return saved;
        }
      } catch {}
    }

    if (!allowFetch) return undefined;

    const checksumsUrl = `${githubDownloadBase}/${repo}/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(checksumAsset)}`;
    try {
      const response = await fetchTextFromUpstream(checksumsUrl);
      if (response.status >= 400) return undefined;
      const checksums = parseChecksums(response.body);
      for (const [name, digest] of checksums) {
        ytdlpShaCache.set(`${repo}:${version}:${name}`, digest);
      }
      const matched = checksums.get(assetName);
      if (matched && diskPath) {
        await mkdir(cacheDir!, { recursive: true }).catch(() => undefined);
        await writeFile(diskPath, `${matched}\n`, 'utf8').catch(() => undefined);
      }
      return matched;
    } catch (error) {
      logger.warn({ err: error, version, assetName }, 'failed to fetch yt-dlp checksums');
      return undefined;
    }
  };

  const lookupAndroidRelease = async (): Promise<AndroidNodeAppUpdateInfo | undefined> => {
    const url = `${githubApiBase}/repos/${androidRepo}/releases?per_page=10`;
    const response = await fetchTextFromUpstream(url, githubHeaders());
    if (response.status === 404) return undefined;
    if (response.status >= 400) {
      throw new Error(`github releases returned ${response.status}`);
    }
    const parsedReleases = z.array(githubReleaseSchema).safeParse(JSON.parse(response.body));
    if (!parsedReleases.success) return undefined;

    for (const release of parsedReleases.data) {
      if (release.draft) continue;
      const manifestAsset = release.assets.find((a) => a.name === 'android-node-manifest.json');
      if (manifestAsset) {
        const assetRes = await fetchTextFromUpstream(manifestAsset.browser_download_url, {
          accept: 'application/json',
          'user-agent': 'sera-toolkit/1.0 (+updates)',
        });
        if (assetRes.status >= 400) continue;
        const parsedManifest = androidReleaseManifestAssetSchema.safeParse(
          JSON.parse(assetRes.body),
        );
        if (!parsedManifest.success) continue;
        const info = parsedManifest.data;
        const apkAsset =
          (info.assetName ? release.assets.find((a) => a.name === info.assetName) : undefined) ??
          release.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
        const apkUrl = info.apkUrl ?? apkAsset?.browser_download_url;
        if (!apkUrl) continue;
        const releaseNotes =
          info.releaseNotes ??
          (release.body?.trim() ? release.body.trim().slice(0, 4000) : undefined);
        return {
          versionCode: info.versionCode,
          versionName: info.versionName,
          sha256: info.sha256.toLowerCase(),
          apkUrl,
          proxyPath: '/internal/extraction/updates/apk',
          ...(releaseNotes ? { releaseNotes } : {}),
          ...(info.minVersionCode !== undefined ? { minVersionCode: info.minVersionCode } : {}),
        };
      }

      const apkAsset = release.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
      if (!apkAsset) continue;
      const tagMatch = /^.*?(\d+\.\d+\.\d+)\+(\d+)$/.exec(release.tag_name);
      if (!tagMatch?.[1] || !tagMatch[2]) continue;
      const versionName = tagMatch[1];
      const versionCode = Number.parseInt(tagMatch[2], 10);
      if (!Number.isFinite(versionCode) || versionCode <= 0) continue;

      const checksumAsset =
        release.assets.find((a) => a.name === `${apkAsset.name}.sha256`) ??
        release.assets.find((a) => a.name === 'SHA2-256SUMS');
      if (!checksumAsset) continue;
      const sumsRes = await fetchTextFromUpstream(checksumAsset.browser_download_url);
      if (sumsRes.status >= 400) continue;
      const checksums = parseChecksums(sumsRes.body);
      const singleHash = /^[a-f0-9]{64}$/i.exec(sumsRes.body.trim())?.[0]?.toLowerCase();
      const sha256 = checksums.get(apkAsset.name) ?? singleHash;
      if (!sha256) continue;
      const releaseNotes = release.body?.trim() ? release.body.trim().slice(0, 4000) : undefined;
      return {
        versionCode,
        versionName,
        sha256,
        apkUrl: apkAsset.browser_download_url,
        proxyPath: '/internal/extraction/updates/apk',
        ...(releaseNotes ? { releaseNotes } : {}),
      };
    }

    return undefined;
  };

  const lookupLatestYtdlpVersion = async (repo: string): Promise<string | undefined> => {
    const url = `${githubApiBase}/repos/${repo}/releases/latest`;
    const response = await fetchTextFromUpstream(url, githubHeaders());
    if (response.status >= 400) return undefined;
    const body = JSON.parse(response.body) as { tag_name?: unknown };
    if (
      typeof body.tag_name === 'string' &&
      /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(body.tag_name)
    ) {
      return body.tag_name;
    }
    return undefined;
  };

  const performRemoteRefresh = async (tools: ToolsManifest): Promise<void> => {
    if (!enableRemoteLookup) return;
    if (refreshPromise) {
      await refreshPromise;
      return;
    }
    refreshPromise = (async () => {
      try {
        const [androidApp, latestYtdlp] = await Promise.all([
          lookupAndroidRelease().catch((error: unknown) => {
            logger.warn({ err: error, repo: androidRepo }, 'android release lookup failed');
            return cachedRemote.androidApp;
          }),
          ytdlpTrack === 'latest'
            ? lookupLatestYtdlpVersion(tools.ytdlp.repo).catch((error: unknown) => {
                logger.warn({ err: error, repo: tools.ytdlp.repo }, 'yt-dlp latest lookup failed');
                return cachedRemote.latestYtdlpVersion;
              })
            : Promise.resolve(undefined),
        ]);

        const targetVersion = latestYtdlp ?? tools.ytdlp.version;
        const androidAsset = tools.ytdlp.assets['android-arm64'] ?? DEFAULT_YTDLP_ASSET;
        await resolveYtdlpSha256(
          tools.ytdlp.repo,
          targetVersion,
          tools.ytdlp.checksumAsset,
          androidAsset,
          true,
        );

        cachedRemote = {
          fetchedAt: Date.now(),
          ...(latestYtdlp ? { latestYtdlpVersion: latestYtdlp } : {}),
          ...(androidApp ? { androidApp } : {}),
        };
      } finally {
        refreshPromise = undefined;
      }
    })();
    await refreshPromise;
  };

  const assembleManifest = async (allowChecksumFetch: boolean): Promise<NodeUpdateManifest> => {
    const [tools, overrides] = await Promise.all([loadToolsManifest(), loadLocalOverrides()]);
    const ytdlpOverride = overrides.manifest?.ytdlp;
    const version =
      ytdlpOverride?.version ?? cachedRemote.latestYtdlpVersion ?? tools.ytdlp.version;
    const assetName =
      ytdlpOverride?.assetName ?? tools.ytdlp.assets['android-arm64'] ?? DEFAULT_YTDLP_ASSET;
    const ytdlpUrl =
      ytdlpOverride?.url ??
      `${githubDownloadBase}/${tools.ytdlp.repo}/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`;
    const ytdlpSha =
      ytdlpOverride?.sha256?.toLowerCase() ??
      (await resolveYtdlpSha256(
        tools.ytdlp.repo,
        version,
        tools.ytdlp.checksumAsset,
        assetName,
        allowChecksumFetch,
      ));

    const ytdlp: YtdlpUpdateInfo = {
      version,
      assetName,
      ...(ytdlpSha ? { sha256: ytdlpSha } : {}),
      url: ytdlpUrl,
      proxyPath: '/internal/extraction/updates/ytdlp',
    };

    const rawAndroid = overrides.manifest?.androidNodeApp
      ? {
          versionCode: overrides.manifest.androidNodeApp.versionCode,
          versionName: overrides.manifest.androidNodeApp.versionName,
          sha256: overrides.manifest.androidNodeApp.sha256.toLowerCase(),
          apkUrl: overrides.manifest.androidNodeApp.apkUrl,
          proxyPath:
            overrides.manifest.androidNodeApp.proxyPath ?? '/internal/extraction/updates/apk',
          ...(overrides.manifest.androidNodeApp.releaseNotes
            ? { releaseNotes: overrides.manifest.androidNodeApp.releaseNotes }
            : {}),
          ...(overrides.manifest.androidNodeApp.minVersionCode !== undefined
            ? { minVersionCode: overrides.manifest.androidNodeApp.minVersionCode }
            : {}),
        }
      : (overrides.android ?? cachedRemote.androidApp);

    const baseClients = config.youtube.playerClients
      ? config.youtube.playerClients
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const basePot = isPubliclyReachableUrl(config.youtube.potProviderUrl)
      ? config.youtube.potProviderUrl
      : undefined;

    const ytOverride = overrides.manifest?.providerConfig?.youtube;
    const igOverride = overrides.manifest?.providerConfig?.instagram;

    const potProviderUrl = ytOverride?.potProviderUrl ?? basePot;
    const providerConfig: ProviderHotConfig = {
      youtube: {
        playerClients: ytOverride?.playerClients ?? baseClients,
        extraArgs: ytOverride?.extraArgs ?? [...defaultExtraArgs],
        remoteComponents: ytOverride?.remoteComponents ?? [...defaultRemoteComponents],
        ...(potProviderUrl ? { potProviderUrl } : {}),
      },
      instagram: {
        webApiAppId: igOverride?.webApiAppId ?? DEFAULT_INSTAGRAM_APP_ID,
        userAgent: igOverride?.userAgent ?? DEFAULT_INSTAGRAM_USER_AGENT,
        cdnHosts: igOverride?.cdnHosts ?? ['cdninstagram.com', 'fbcdn.net'],
        strategyOrder: igOverride?.strategyOrder ?? ['ytdlp', 'web-api', 'oembed'],
      },
    };

    const canonicalContent = {
      ytdlp,
      ...(rawAndroid ? { androidNodeApp: rawAndroid } : {}),
      providerConfig,
    };
    const manifestHash = createHash('sha256')
      .update(JSON.stringify(canonicalContent))
      .digest('hex');

    if (manifestSnapshot?.key === manifestHash) {
      return { ...manifestSnapshot.value, generatedAt: new Date().toISOString() };
    }

    const built: NodeUpdateManifest = nodeUpdateManifestSchema.parse({
      manifestHash,
      generatedAt: new Date().toISOString(),
      ...canonicalContent,
    });
    manifestSnapshot = { key: manifestHash, value: built };
    return built;
  };

  const isRemoteStale = (): boolean =>
    enableRemoteLookup && Date.now() - cachedRemote.fetchedAt > cacheTtlMs;

  const refreshInBackground = (): void => {
    if (!isRemoteStale() || refreshPromise) return;
    void loadToolsManifest()
      .then((tools) => performRemoteRefresh(tools))
      .catch(() => undefined);
  };

  const getManifest = async (
    opts: { readonly forceRefresh?: boolean } = {},
  ): Promise<NodeUpdateManifest> => {
    if (opts.forceRefresh || isRemoteStale()) {
      const tools = await loadToolsManifest();
      await performRemoteRefresh(tools);
    }
    return assembleManifest(enableRemoteLookup);
  };

  const currentManifestHash = async (): Promise<string> => {
    refreshInBackground();
    const manifest = await assembleManifest(false);
    return manifest.manifestHash;
  };

  const resolveArtifact = async (
    kind: 'ytdlp' | 'apk',
    assetOverride?: string,
  ): Promise<ResolvedUpdateArtifact> => {
    const manifest = await getManifest();
    const tools = await loadToolsManifest();

    let assetName: string;
    let url: string;
    let expectedSha256: string | undefined;
    let versionKey: string;
    let contentType: string;
    let maxBytes: number;

    if (kind === 'ytdlp') {
      const allowedAssets = new Set([
        manifest.ytdlp.assetName,
        ...Object.values(tools.ytdlp.assets),
      ]);
      assetName = assetOverride ?? manifest.ytdlp.assetName;
      if (!allowedAssets.has(assetName)) {
        throw seraError('INVALID_URL', { detail: `updates: unknown ytdlp asset ${assetName}` });
      }
      versionKey = manifest.ytdlp.version;
      url =
        assetName === manifest.ytdlp.assetName
          ? manifest.ytdlp.url
          : `${githubDownloadBase}/${tools.ytdlp.repo}/releases/download/${encodeURIComponent(versionKey)}/${encodeURIComponent(assetName)}`;
      expectedSha256 =
        assetName === manifest.ytdlp.assetName && manifest.ytdlp.sha256
          ? manifest.ytdlp.sha256
          : await resolveYtdlpSha256(
              tools.ytdlp.repo,
              versionKey,
              tools.ytdlp.checksumAsset,
              assetName,
              true,
            );
      if (!expectedSha256) {
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: `updates: checksum unavailable for ${assetName}`,
        });
      }
      contentType = 'application/octet-stream';
      maxBytes = MAX_YTDLP_BYTES;
    } else {
      const app = manifest.androidNodeApp;
      if (!app) {
        throw seraError('NOT_FOUND', {
          message: 'No Android node update available.',
          detail: 'updates: no androidNodeApp in manifest',
        });
      }
      versionKey = String(app.versionCode);
      assetName = safeFilenameFromUrl(app.apkUrl, `sera-node-${app.versionName}.apk`);
      url = app.apkUrl;
      expectedSha256 = app.sha256.toLowerCase();
      contentType = 'application/vnd.android.package-archive';
      maxBytes = MAX_APK_BYTES;
    }

    const expectedLower = expectedSha256.toLowerCase();
    const cacheFileName = `${kind}-${sanitizeCacheSegment(versionKey)}-${expectedLower.slice(0, 12)}-${sanitizeCacheSegment(assetName)}`;
    const cachePath = cacheDir ? join(cacheDir, cacheFileName) : undefined;

    if (cachePath) {
      const existing = await verifyCachedFile(cachePath, expectedLower, kind);
      if (existing !== undefined) {
        return {
          kind,
          assetName,
          contentType,
          sha256: expectedLower,
          sizeBytes: existing,
          manifestHash: manifest.manifestHash,
          cachePath,
        };
      }
      await rm(cachePath, { force: true }).catch(() => undefined);
    }

    return artifactCoalescer.run(`${kind}:${expectedLower}:${assetName}`, async () => {
      if (cachePath) {
        const existing = await verifyCachedFile(cachePath, expectedLower, kind);
        if (existing !== undefined) {
          return {
            kind,
            assetName,
            contentType,
            sha256: expectedLower,
            sizeBytes: existing,
            manifestHash: manifest.manifestHash,
            cachePath,
          };
        }
      }

      const downloaded = await downloadBinaryFromUpstream(url, maxBytes);
      if (downloaded.sha256 !== expectedLower) {
        if (downloaded.cacheTempPath) {
          await rm(downloaded.cacheTempPath, { force: true }).catch(() => undefined);
        }
        throw seraError('PROVIDER_UNAVAILABLE', {
          detail: `updates: checksum mismatch for ${assetName}`,
        });
      }

      if (kind === 'apk') {
        const isZip = downloaded.cacheTempPath
          ? await hasZipMagicFile(downloaded.cacheTempPath)
          : hasZipMagicBuffer(downloaded.buffer);
        if (!isZip) {
          if (downloaded.cacheTempPath) {
            await rm(downloaded.cacheTempPath, { force: true }).catch(() => undefined);
          }
          throw seraError('PROVIDER_UNAVAILABLE', {
            detail: `updates: ${assetName} is not a valid APK archive`,
          });
        }
      }

      if (downloaded.cacheTempPath && cachePath) {
        await rename(downloaded.cacheTempPath, cachePath);
        return {
          kind,
          assetName,
          contentType,
          sha256: expectedLower,
          sizeBytes: downloaded.sizeBytes,
          manifestHash: manifest.manifestHash,
          cachePath,
        };
      }

      return {
        kind,
        assetName,
        contentType,
        sha256: expectedLower,
        sizeBytes: downloaded.sizeBytes,
        manifestHash: manifest.manifestHash,
        buffer: downloaded.buffer,
      };
    });
  };

  return {
    currentManifestHash,
    getManifest,
    resolveArtifact,
    refreshInBackground,
  };
}

export function registerExtractionUpdateRoutes(
  rootApp: FastifyInstance,
  engine: SeraEngine,
  updates: ExtractionUpdatesService = createExtractionUpdatesService(engine),
): void {
  const { config } = engine;
  if (!config.extractionNodes.enabled) return;

  if (config.nodeEnv !== 'test') {
    updates.refreshInBackground();
  }

  void rootApp.register(async (app) => {
    const rateLimit = extractionInternalRateLimit(engine);

    app.get('/internal/extraction/updates/manifest', rateLimit, async (request, reply) => {
      const auth = authenticateExtractionNode(request, reply, engine);
      if (!auth) return reply;

      const manifest = await updates.getManifest();
      return reply
        .header('cache-control', 'private, no-store')
        .header('x-sera-manifest-hash', manifest.manifestHash)
        .send(manifest);
    });

    app.get('/internal/extraction/updates/ytdlp', rateLimit, async (request, reply) => {
      const auth = authenticateExtractionNode(request, reply, engine);
      if (!auth) return reply;

      const query = ytdlpQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw seraError('INVALID_URL', { detail: 'updates: malformed query' });
      }
      const artifact = await updates.resolveArtifact('ytdlp', query.data.asset);
      return sendArtifact(request, reply, artifact);
    });

    app.get('/internal/extraction/updates/apk', rateLimit, async (request, reply) => {
      const auth = authenticateExtractionNode(request, reply, engine);
      if (!auth) return reply;

      const artifact = await updates.resolveArtifact('apk');
      return sendArtifact(request, reply, artifact);
    });
  });
}

function sendArtifact(
  request: FastifyRequest,
  reply: FastifyReply,
  artifact: ResolvedUpdateArtifact,
): FastifyReply {
  const etag = `"${artifact.sha256}"`;
  reply
    .header('content-type', artifact.contentType)
    .header('content-disposition', `attachment; filename="${artifact.assetName}"`)
    .header('cache-control', 'private, no-store')
    .header('etag', etag)
    .header('x-sera-sha256', artifact.sha256)
    .header('x-sera-manifest-hash', artifact.manifestHash);

  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() === etag) {
    return reply.status(304).send();
  }

  reply.header('content-length', artifact.sizeBytes);
  if (request.method === 'HEAD') {
    return reply.status(200).send();
  }
  if (artifact.cachePath) {
    return reply.status(200).send(createReadStream(artifact.cachePath));
  }
  return reply.status(200).send(artifact.buffer ?? Buffer.alloc(0));
}

function locateToolsManifestPath(): string {
  const override = process.env.SERA_TOOLS_MANIFEST_PATH?.trim();
  if (override) return override;

  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'scripts', 'tools.manifest.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), 'scripts', 'tools.manifest.json');
}

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match?.[1] && match[2]) {
      map.set(match[2], match[1].toLowerCase());
    }
  }
  return map;
}

function parseTtlMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_CACHE_TTL_MS;
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(trimmed)) return true;
  if (['0', 'false', 'no', 'off'].includes(trimmed)) return false;
  return fallback;
}

function parseCsvEnv(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw?.trim()) return [...fallback];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseExtraArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = z.array(z.string().min(1)).safeParse(JSON.parse(trimmed));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function isPubliclyReachableUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || !host.includes('.')) return false;
    if (isIpLiteral(host)) {
      const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
      return isPublicAddress(bare);
    }
    return true;
  } catch {
    return false;
  }
}

function isAllowedRemoteUrl(
  url: URL,
  config: SeraEngine['config'],
  githubApiBase: string,
  githubDownloadBase: string,
): boolean {
  if (hostMatchesAny(url.hostname, config.blockedHosts)) return false;
  const allowedTestOrigin =
    url.origin === new URL(githubApiBase).origin ||
    url.origin === new URL(githubDownloadBase).origin;
  if (url.protocol !== 'https:' && !config.allowPrivateAddresses && !allowedTestOrigin) {
    return false;
  }
  return true;
}

function assertSafeRemoteUrl(
  url: URL,
  config: SeraEngine['config'],
  githubApiBase: string,
  githubDownloadBase: string,
): void {
  if (!isAllowedRemoteUrl(url, config, githubApiBase, githubDownloadBase)) {
    throw seraError('BLOCKED_ADDRESS', { detail: `updates: blocked upstream ${url.hostname}` });
  }
}

function sanitizeCacheSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'artifact';
}

function safeFilenameFromUrl(rawUrl: string, fallback: string): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    const segment = pathname.split('/').filter(Boolean).pop();
    if (segment && /^[A-Za-z0-9._-]+$/.test(segment)) {
      return segment.slice(0, 128);
    }
  } catch {}
  return sanitizeCacheSegment(fallback);
}

async function verifyCachedFile(
  path: string,
  expectedSha256: string,
  kind: 'ytdlp' | 'apk',
): Promise<number | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    const hash = createHash('sha256');
    let head: Buffer | undefined;
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      head ??= chunk.subarray(0, 4);
      hash.update(chunk);
    }
    const actual = hash.digest('hex').toLowerCase();
    if (actual !== expectedSha256) return undefined;
    if (kind === 'apk' && !hasZipMagicBuffer(head)) return undefined;
    return info.size;
  } catch {
    return undefined;
  }
}

function hasZipMagicBuffer(buf: Buffer | undefined): boolean {
  return Boolean(
    buf &&
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04,
  );
}

async function hasZipMagicFile(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await handle.read(buf, 0, 4, 0);
      return bytesRead === 4 && hasZipMagicBuffer(buf);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
