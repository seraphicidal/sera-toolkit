/** SERA.toolkit engine — the media pipeline, shared by the API and the workers. */

export { loadConfig, locateTool, ConfigError, VERSION, type EngineConfig } from './config.js';
export { SeraEngine, type EngineOptions } from './engine.js';
export { SeraError, seraError, MESSAGES, HINTS } from './errors.js';
export { createLogger, silentLogger, logSafeUrl, type Logger } from './logging.js';

export { MediaResolver, type ResolverDependencies } from './resolver.js';

export {
  ProviderRegistry,
  createProviders,
  normalizeForProvider,
  YtdlpProvider,
  planKey,
  type MediaProvider,
  type ProviderContext,
  type DownloadPlan,
  type FetchPlan,
  type ResolvedItem,
  type ResolvedMedia,
} from './providers/index.js';

export { JobService, type JobServiceDependencies } from './jobs/service.js';
export {
  JobRunner,
  matchSelection,
  type JobSelection,
  type JobSpec,
  type JobUpdate,
} from './jobs/runner.js';
export { createZip, type ZipEntry } from './jobs/zip.js';

export { MemoryJobBackend } from './queue/memory.js';
export {
  toPublicJob,
  isActive,
  ACTIVE_STATES,
  type JobBackend,
  type JobRecord,
  type JobPatch,
  type WorkerHandle,
} from './queue/types.js';

export {
  WorkspaceManager,
  Workspace,
  mimeTypeFor,
  MIME_TYPES,
  type JobManifest,
} from './storage/workspace.js';

export {
  createSafeDispatcher,
  safeFetch,
  safeOpen,
  header,
  type SafeResponse,
  type OpenResponse,
  type ResponseHeaders,
} from './security/http.js';
export { AbuseGuard, type AbuseGuardOptions } from './security/abuse.js';
export { isPublicAddress, isIpLiteral } from './security/ip.js';
export { parseRobots, isAllowed } from './security/robots.js';
export {
  parseUserUrl,
  normalizeUrl,
  hostMatches,
  hostMatchesAny,
  stripWww,
  urlExtension,
  MEDIA_EXTENSIONS,
} from './security/url.js';

export {
  convert,
  probe,
  ffmpegVersion,
  type ConversionSpec,
  type ProbeResult,
} from './convert/ffmpeg.js';
export {
  dumpInfo,
  download,
  classifyYtdlpFailure,
  version as ytdlpVersion,
} from './extract/ytdlp.js';
export { downloadDirect } from './extract/direct-download.js';
export { discoverMedia, type PageMedia, type DiscoveredMedia } from './extract/html.js';
export type { YtdlpInfo, YtdlpFormat } from './extract/ytdlp-types.js';

export { kindOf } from './normalize/plans.js';
export {
  toUsableFormats,
  splitFormats,
  bestAudio,
  bestVideoPerHeight,
  nativeContainer,
  fitsInMp4,
  estimateSize,
  audioBitrateChoices,
  type UsableFormat,
} from './normalize/formats.js';

export {
  sanitizeStem,
  sanitizeExtension,
  buildFilename,
  mediaFilename,
  dedupeFilename,
  assertSafeFilename,
  contentDispositionValue,
} from './util/filename.js';
export { formatBytes, formatDuration, qualityLabel, codecLabel, truncate } from './util/format.js';
export { signToken, verifyToken, newJobId } from './util/tokens.js';
export { TtlCache } from './util/cache.js';
export { run, type RunOptions, type RunResult } from './util/spawn.js';
