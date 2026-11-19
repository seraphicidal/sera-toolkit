# SERA.toolkit Architecture

Monorepo (`sera-toolkit`, v`1.8.0`) implementing a universal media resolution, extraction, conversion, and delivery pipeline across web, API, worker, remote extraction node, and (in-progress) Android clients.

## 1. Workspace & Module Dependencies

- `packages/contracts` (`@sera/contracts`): zero-internal-dep package exporting TypeScript contracts (`src/types.ts`), Zod v4 validation schemas + compile-time type assertions (`src/schemas.ts`), timecode/trim validation (`checkTrim`, `trimSuffix`), and `SERA_VERSION`.
- `packages/engine` (`@sera/engine`): depends on `@sera/contracts`. Core media resolution (`MediaResolver`), extraction routing (`ExtractionRouter`, `ExtractionNodeRegistry`, `RemoteOverHttp`), 23 providers (`providers/`), `yt-dlp` / `gallery-dl` / HTML / direct-HTTP extractors (`extract/`), format normalization (`normalize/`), FFmpeg conversion/trim/cover-art tagging (`convert/`), job orchestration (`jobs/`), queue backends (`queue/`), workspace storage (`storage/`), SSRF/abuse/denylist/robots security (`security/`), daily usage counters (`usage/`), and HMAC tokens (`util/tokens.ts`).
- `apps/api` (`@sera/api`): depends on `@sera/contracts`, `@sera/engine`. Fastify 5 HTTP/SSE server (`src/server.ts`, `src/index.ts`) and CLIs (`src/canary-cli.ts`, `src/reports-cli.ts`, `src/stats-cli.ts`).
- `apps/worker` (`@sera/worker`): depends on `@sera/contracts`, `@sera/engine`. Standalone BullMQ worker (`src/index.ts`) for Redis deployments (`SERA_QUEUE_DRIVER=redis`).
- `apps/extractor` (`@sera/extractor`): depends on `@sera/contracts`, `@sera/engine`. Remote extraction node daemon (`src/index.ts`, `src/node.ts`) that long-polls the API from a residential/home network.
- `apps/web` (`@sera/web`): depends on `@sera/contracts` (plus `@sera/contracts/types` path alias in `apps/web/tsconfig.json`). Next.js 16 App Router UI and runtime HTTP/SSE proxy to `@sera/api`.
- `apps/android` (`dev.sera.toolkit`, untracked WIP): standalone Kotlin/Jetpack Compose client communicating directly with `@sera/api` over HTTP/SSE. Shares wire shapes manually via `apps/android/app/src/main/java/dev/sera/toolkit/model/Contracts.kt`.

## 2. Routing

### Web App (`apps/web/src/app`)
| Route | File | Rendering / Behavior |
| --- | --- | --- |
| `/` | `apps/web/src/app/page.tsx` | Static shell rendering `Wordmark`, `Downloader`, `ShareHint` |
| `/about` | `apps/web/src/app/about/page.tsx` | ISR (`revalidate = 60`); loads `/api/info` via `loadServiceInfo()` |
| `/import` | `apps/web/src/app/import/page.tsx` | `noindex, nofollow`; renders `ImportClient` for Instagram browser import |
| `/share` | `apps/web/src/app/share/page.tsx` | `noindex, nofollow`; `ShareRedirect` extracts URL from `?url`/`?text`/`?title` and redirects to `/#url=...` |
| `/legal/notice` | `apps/web/src/app/legal/notice/page.tsx` | `force-dynamic`; Impressum / DDG § 5 / DSA Arts. 11–12 from env vars |
| `/legal/privacy` | `apps/web/src/app/legal/privacy/page.tsx` | `force-dynamic`; GDPR / ePrivacy notice + `ClearHistoryButton` |
| `/legal/report` | `apps/web/src/app/legal/report/page.tsx` | `force-dynamic`; renders `LegalReportForm` posting to `/api/legal/report` |
| `/legal/terms` | `apps/web/src/app/legal/terms/page.tsx` | Acceptable use and DMCA/DSA notice policy |
| `/manifest.webmanifest` | `apps/web/src/app/manifest.ts` | PWA manifest with `share_target` pointing to `/share` |
| `/api/*` | `apps/web/src/app/api/[...path]/route.ts` | `force-dynamic` Node.js runtime proxy (`GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`) to `SERA_API_URL` |
| `/health` | `apps/web/src/app/health/route.ts` | `force-dynamic` proxy (`GET/HEAD`) to `$SERA_API_URL/health` |
| `/ready` | `apps/web/src/app/ready/route.ts` | `force-dynamic` proxy (`GET/HEAD`) to `$SERA_API_URL/ready` |
| Non-API pages | `apps/web/src/proxy.ts` | Next.js 16 proxy generating per-request `x-nonce` and `content-security-policy` |

### Android App Entry Points (`apps/android/app/src/main/AndroidManifest.xml`)
- Declares `.SeraApplication` and `.MainActivity` (`MAIN`/`LAUNCHER`, `ACTION_SEND`, `ACTION_SEND_MULTIPLE`, `ACTION_PROCESS_TEXT` for `text/plain`), plus `FileProvider` (`res/xml/file_paths.xml`).
- **Status**: `MainActivity.kt` and Compose UI screens under `ui/` do not exist yet; `data/`, `domain/`, `model/`, and `ui/theme/Theme.kt` are present.

## 3. Key Modules & Dependency Graph

### Engine (`packages/engine/src`)
- `engine.ts` (`SeraEngine.create`): initializes `Denylist`, `ProviderRegistry`, `ExtractionNodeRegistry`, optional `RemoteOverHttp` (when `extractionNodes.enabled && config.apiUrl`), `MediaResolver`, `WorkspaceManager` (+ reaper), `JobBackend` (`MemoryJobBackend` or `RedisJobBackend`), `UsageCounter` (`MemoryUsageCounter` or `RedisUsageCounter`), `JobService`, and `AbuseGuard`.
- `resolver.ts` (`MediaResolver`):
  - `resolve()`: parses URL, checks `Denylist` & `EgressGuard`, matches provider via `ProviderRegistry.detect(url)`, normalizes URL, executes `ExtractionRouter`, falls back to `GenericProvider` if the primary provider returns `UNSUPPORTED_SOURCE`, caches `ExtractionOutcome` (`TtlCache`, 200 entries, 5 min) and coalesces identical concurrent resolves (`InFlightCoalescer`), and signs HMAC tokens (`infoId`, `optionId`, `/api/thumb/:token`).
  - `importSubmitted()`: handles visitor-browser Instagram imports (`#v=2` / `postMessage` flow) without touching external Instagram APIs from the server; validates CDN hosts (`cdninstagram.com`, `fbcdn.net`) and bounds TTL to CDN signature expiry (`x`/`oe`).
- `extract/router.ts` (`ExtractionRouter`): routes across local + remote backends. For providers with `capabilities.residentialFallback`, if `primary.networkClass === 'datacenter'` and `!capabilities.cloudExtraction` (e.g., YouTube), healthy non-datacenter remote nodes are ordered before local; otherwise local runs first and escalates on `isEgressProblem` / `STREAM_403` / remote transport failures. For providers declaring `nodeSession` (Instagram `instagram-session`), escalates non-definitive failures to a node with that feature, then falls back to `lastResort` (`allowDegraded: true`, e.g., Instagram oEmbed cover).
- `providers/` (sorted ascending by `priority`):
  - `10`: `youtube.ts` (`yt-dlp` strategy ladder: configured client → `web_safari` → `android`; optional PoT via `youtubepot-bgutilhttp:base_url`; `cloudExtraction: false`).
  - `20`: `instagram.ts` (`yt-dlp` → `SERA_INSTAGRAM_SESSION_ID` `/api/v1/media/:id/info/` → degraded oEmbed cover), `reddit.ts` (`oauth-api` via `reddit-api.ts` → `embed` HTML via `reddit-embed.ts`), `twitter.ts` (`t.co` expansion → `syndication` → `fxtwitter` → `gallery-dl` → `yt-dlp`), `tiktok.ts`, `twitch.ts`.
  - `30`: `bandcamp.ts`, `bluesky.ts` (`yt-dlp` → AT Protocol), `dailymotion.ts`, `facebook.ts`, `pinterest.ts`, `soundcloud.ts`, `threads.ts` (embed scraping via `threads-embed.ts`), `tumblr.ts`, `vimeo.ts`.
  - `40`: `mastodon.ts` (instance API → `yt-dlp`), `snapchat.ts`.
  - `200`: `cloud.ts` (`GoogleDriveProvider`, `DropboxProvider`, `MediaFireProvider`, `MegaProvider`).
  - `900`: `direct.ts` (`DirectFileProvider` for known `MEDIA_EXTENSIONS` + HLS/DASH manifests).
  - `1000`: `generic.ts` (`GenericProvider`: enforces `robots.txt` via `security/robots.ts`, HTML/meta/JSON-LD discovery via `extract/html.ts`, `yt-dlp` default extractors, `gallery-dl`).
- `normalize/`: `formats.ts` and `plans.ts` convert raw `yt-dlp` metadata into normalized `DownloadPlan` options (video per-height, MP4/WebM/MOV container compatibility, audio bitrates <= source ceiling, GIF conversion for short videos).
  - `jobs/service.ts` (`JobService`) & `jobs/runner.ts` (`JobRunner`): creates specs, enforces `maxQueueDepth` and `maxConcurrentJobsPerClient` under per-client locks, runs items up to `itemConcurrency`, handles section-trimming (`yt-dlp --download-sections` with stall watcher in `watchGrowth()` falling back to full download + `convert/trim.ts`), format fallback (same-height selector → lower-height alternatives), FFmpeg conversion (`convert/ffmpeg.ts`), audio metadata/cover-art tagging (`convert/tags.ts`), subtitle download/embedding (`providers/subtitles.ts`), byte/MIME/executable sniffing (`util/sniff.ts`) + `ffprobe` validation, ZIP streaming (`jobs/zip.ts` via `yazl`), and `manifest.json` creation (`storage/workspace.ts`).
- `security/`:
  - `egress.ts` (`EgressGuard`): validates DNS answers via `isPublicAddress()` (`security/ip.ts`) and starts a loopback HTTP + `CONNECT` proxy passed to `yt-dlp` and `ffmpeg` so child tools cannot hit private IPs, non-80/443 ports (unless allowed in dev), or SSRF via redirects.
  - `http.ts` (`createSafeDispatcher`, `safeFetch`, `safeOpen`, `readBoundedJson`): custom `undici` dispatcher re-checking resolved IPs, bounding response bytes, and validating redirect targets manually.
  - `denylist.ts` (`Denylist`): merges static `SERA_BLOCKED_HOSTS` with persisted `$SERA_DATA_DIR/denylist.json` (auto-reloaded every 5s on mtime change); protects `PROTECTED_HOSTS` from `blockHost()`.
  - `abuse.ts` (`AbuseGuard`): per-`clientKey` sliding window (12 suspicious errors in 5 min → 5 min cooldown, LRU capped at 10,000 entries).

### Web (`apps/web/src`)
- Components (`components/`): `downloader.tsx` orchestrates `UrlForm` (single or multi-line batch queue via `parseBatchUrls`), `MediaPreview`, `ItemPicker` (max 25 selected items, filter, shift-range selection), `FormatPicker` (kind/quality/container/trim/subtitles/filename/packaging), `ProgressPanel`, `ResultPanel` (auto-download + inline `<video>`/`<audio>`/`<img>` preview), `RecentDownloads` (`localStorage`), `ErrorPanel`. Header houses `HealthIndicator` (polls `/health` every 60s when visible; 2 consecutive failures before red) and `ThemeToggle`.
- Libraries (`lib/`): `api.ts`, `backend-proxy.ts`, `bookmarklet.ts`, `csp.ts`, `format.ts`, `health.ts`, `history.ts`, `import-handshake.ts`, `selection.ts`, `service-info.ts`, `share.ts`, `subtitles.ts`, `theme-script.ts`, `trim.ts`, `use-job.ts`.

## 4. Data Flow

1. **Resolve**: Client submits `POST /api/media/info` → `clientKeyPlugin` hashes normalized IP → `AbuseGuard` + `@fastify/rate-limit` check → `MediaResolver.resolve()` checks `Denylist` + `EgressGuard` → `ExtractionRouter` resolves locally or dispatches to an `ExtractionNode` → returns `MediaInfo` with signed HMAC `id` (`infoId`), per-option `id`s, and `/api/thumb/:token` URLs.
2. **Thumbnails**: Browser requests `/api/thumb/:token` → API verifies HMAC token, coalesces upstream fetch via `safeFetch` (4 MB limit, image MIME check), caches in memory (`ThumbnailCache`, 64 MB / 10 min), and serves with `default-src 'none'; sandbox` CSP.
3. **Download Job**: Client posts `infoId` + `optionIds` (+ `packaging`, `filename`, `trim`, `subtitles`) to `POST /api/jobs` → `JobService.create()` verifies tokens, resolution hash, queue depth, and client concurrency → submits `JobRecord` to `MemoryJobBackend` or `RedisJobBackend` (BullMQ `sera-jobs` queue + Redis `sera:job:*` + `sera:client:*`).
4. **Execution & Delivery**:
   - Local or standalone `apps/worker` runs `JobRunner.run()`. If `resolvedMedia.remoteBackend` was set, `JobRunner` dispatches the job to the extraction node via `RemoteExtraction` (`ExtractionNodeRegistry` or `RemoteOverHttp`) and moves uploaded files from `remote-<taskId>/` into `<jobId>/out/`.
   - Progress updates are throttled (250 ms) and published over Redis pub/sub (`sera:job-updates`) or memory listeners to `GET /api/jobs/:id/events` (SSE) and `GET /api/jobs/:id`.
   - `JobRunner` writes `$SERA_DATA_DIR/<jobId>/manifest.json` and deletes `work/` scratch files. Clients stream outputs via `GET|HEAD /api/jobs/:id/download` or `/api/jobs/:id/files/:name` (range-capable). `WorkspaceManager.reap()` removes expired workspaces after `SERA_RETENTION_SECONDS`.
5. **Instagram Browser Import**: User runs bookmarklet from `/import` on `instagram.com` → bookmarklet fetches Instagram's web API using the user's browser session and sends only trimmed JSON metadata/CDN URLs via URL fragment `#v=2&p=...` (or `postMessage` handshake `sera-import-ready`/`sera-import-payload`/`sera-import-ack`) → `POST /api/media/import` mints signed `o: 'visitor'` `infoId` → job fetches CDN URLs directly without Instagram login on the server.

## 5. API Endpoints & CLIs (`apps/api`)

| Method & Path | Handler | Auth / Rate Limit | Purpose |
| --- | --- | --- | --- |
| `GET /api/info` | `apps/api/src/routes/meta.ts` | 60/min (loopback & canary exempt) | Public `ServiceInfo` (`providers`, `limits`, `version`) |
| `GET /health` | `apps/api/src/routes/meta.ts` | 60/min; full details require Admin/Canary | Checks `yt-dlp`, `ffmpeg`, `storage`, `queue`, optional `extraction-nodes` (15s cache) |
| `GET /ready` | `apps/api/src/routes/meta.ts` | 60/min; full details require Admin/Canary | `200`/`503` readiness across `yt-dlp`, `ffmpeg`, `storage`, `queue` |
| `POST /api/media/info` | `apps/api/src/routes/media.ts` | `SERA_RATE_LIMIT_RESOLVE_PER_MINUTE` + `AbuseGuard` | Resolves URL into `MediaInfo` |
| `POST /api/media/import` | `apps/api/src/routes/media.ts` | `SERA_RATE_LIMIT_RESOLVE_PER_MINUTE` + `AbuseGuard` (512 KB max) | Imports visitor-submitted Instagram post JSON |
| `GET /api/thumb/:token`, `GET /api/media/thumbnail/:token` | `apps/api/src/routes/media.ts` | `rateLimitThumbnailsPerMinute` | SSRF-safe, cached thumbnail proxy |
| `POST /api/jobs` | `apps/api/src/routes/jobs.ts` | `SERA_RATE_LIMIT_JOBS_PER_MINUTE` + `AbuseGuard` | Queues download/conversion job (`202`) |
| `GET /api/jobs/:id` | `apps/api/src/routes/jobs.ts` | 120/min; `clientKeys` match | Polls job state and result metadata |
| `DELETE /api/jobs/:id` | `apps/api/src/routes/jobs.ts` | 120/min; `clientKeys` match | Cancels running job and destroys workspace |
| `GET /api/jobs/:id/events` | `apps/api/src/routes/jobs.ts` | 120/min; `clientKeys` match | SSE stream (`state`, `progress`, `done`, `error`, `: ping`) |
| `GET/HEAD /api/jobs/:id/download` | `apps/api/src/routes/jobs.ts` | 120/min; `clientKeys` match | Streams primary output or ZIP (`200`/`206` Range) |
| `GET/HEAD /api/jobs/:id/files/:name` | `apps/api/src/routes/jobs.ts` | 120/min; `clientKeys` match | Streams individual output file from manifest |
| `POST /api/legal/report` | `apps/api/src/routes/legal.ts` | 10/min; optional Admin Bearer auto-mitigates | Persists DSA/DMCA report JSON; optional `ntfy.sh` alert |
| `GET /api/admin/usage` | `apps/api/src/routes/admin.ts` | `SERA_ADMIN_TOKEN` Bearer; 30/min | Per-source/day counts and byte totals (90d retention) |
| `GET /api/admin/reports`, `GET/DELETE /api/admin/reports/:id` | `apps/api/src/routes/admin.ts` | `SERA_ADMIN_TOKEN` Bearer; 30/min | Lists, reads, or deletes stored legal reports |
| `GET/POST /api/admin/denylist`, `DELETE /api/admin/denylist/:id` | `apps/api/src/routes/admin.ts` | `SERA_ADMIN_TOKEN` Bearer; 30/min | Lists, adds (`host`/`url`), or removes dynamic denylist rules |
| `POST /internal/extraction/claim` | `apps/api/src/routes/extraction-node.ts` | Node Bearer token | Long-polls (`claimHoldMs`) for pending remote tasks |
| `POST /internal/extraction/:taskId/{progress,resolved,failed,file,complete}` | `apps/api/src/routes/extraction-node.ts` | Node Bearer token + task owner check | Reports progress, resolved `MediaInfo`, failures, binary uploads, completion |
| `GET /internal/extraction/nodes`, `POST/GET/DELETE /internal/extraction/dispatch*` | `apps/api/src/routes/extraction-node.ts` | Worker Bearer token | Used by `RemoteOverHttp` in `@sera/worker` to inspect nodes and dispatch/poll/cancel tasks |

CLIs in `apps/api/src/`: `canary-cli.ts` (`SERA_CANARY_TOKEN`, exercises `scripts/provider-cases.json` canary entries), `stats-cli.ts` (`SERA_ADMIN_TOKEN`, formats `/api/admin/usage`), `reports-cli.ts` (`SERA_ADMIN_TOKEN`, reads `/api/admin/reports`).

## 6. Auth, Security & Third-Party Integrations

- **Stateless tokens** (`packages/engine/src/util/tokens.ts`): HMAC-SHA256 signed base64url JSON with expiration (`e`). Secret derives from `SHA256(SERA_SECRET)` (required in `production`, ephemeral random bytes in dev).
- **Bearer & Header tokens**:
  - `SERA_ADMIN_TOKEN`: `Authorization: Bearer <token>` via SHA-256 `timingSafeEqual` (`apps/api/src/plugins/admin-auth.ts`).
  - `SERA_CANARY_TOKEN`: `x-sera-canary` header; exempts canary checks from rate limits, `AbuseGuard`, and `UsageCounter`.
  - `SERA_EXTRACTION_NODE_TOKENS` (`id1:tok1,id2:tok2`) or legacy `SERA_EXTRACTION_NODE_TOKEN`: authenticates remote nodes and checks task ownership (`validateTaskOwnership`). `SERA_EXTRACTION_WORKER_TOKEN` authenticates `@sera/worker` → `@sera/api` dispatch calls (falls back to legacy node token or `SERA_ADMIN_TOKEN`).
- **Third-party binaries & services**:
  - `yt-dlp` (`2026.10.26`) & `ffmpeg`/`ffprobe` (`n8.1.3-32-g760d10603e`): installed via `scripts/fetch-tools.mjs` into `.tools/` or baked into `docker/api.Dockerfile`. Auto-discovered by `locateTool()` (override env → `.tools/` → `PATH`).
  - `gallery-dl` (optional, discovered via `SERA_GALLERYDL_PATH` or `PATH` in `packages/engine/src/extract/gallerydl.ts`).
  - Reddit OAuth client credentials (`SERA_REDDIT_CLIENT_ID`, `SERA_REDDIT_CLIENT_SECRET`), Instagram session cookie (`SERA_INSTAGRAM_SESSION_ID`), YouTube PoT provider (`brainicism/bgutil-ytdlp-pot-provider` via `SERA_YOUTUBE_POT_PROVIDER_URL`), `ntfy.sh` push alerts (`SERA_ALERT_NTFY_TOPIC`), and `cloudflared` quick-tunnel in `scripts/serve-public.mjs`.

## 7. Environment Variables (Names & Purposes Only)

- **Core & Server** (`packages/engine/src/config.ts`): `NODE_ENV`, `LOG_LEVEL`, `SERA_HOST`, `SERA_PORT`, `SERA_CORS_ORIGINS`, `SERA_SECRET`, `SERA_TRUST_PROXY`, `SERA_DOMAIN`.
- **Storage & Limits**: `SERA_DATA_DIR`, `SERA_RETENTION_SECONDS`, `SERA_REAP_INTERVAL_SECONDS`, `SERA_OPTION_TTL_SECONDS`, `SERA_MAX_FILESIZE_BYTES`, `SERA_MAX_DURATION_SECONDS`, `SERA_MAX_ITEMS_PER_JOB`, `SERA_JOB_TIMEOUT_SECONDS`, `SERA_RESOLVE_TIMEOUT_SECONDS`, `SERA_RESOLVE_TIMEOUT_YOUTUBE_SECONDS`, `SERA_RESOLVE_TIMEOUT_INSTAGRAM_SECONDS`, `SERA_RESOLVE_TIMEOUT_TWITTER_SECONDS`, `SERA_RESOLVE_TIMEOUT_REDDIT_SECONDS`.
- **Queue & Workers**: `SERA_QUEUE_DRIVER` (`memory`/`redis`), `SERA_REDIS_URL`, `SERA_WORKER_CONCURRENCY`, `SERA_ITEM_CONCURRENCY`, `SERA_FFMPEG_THREADS`, `SERA_MAX_QUEUE_DEPTH`, `SERA_EMBEDDED_WORKER`.
- **Rate Limits & SSRF/Filtering**: `SERA_RATE_LIMIT_RESOLVE_PER_MINUTE`, `SERA_RATE_LIMIT_JOBS_PER_MINUTE`, `SERA_RATE_LIMIT_THUMB_PER_MINUTE`, `SERA_MAX_CONCURRENT_JOBS_PER_CLIENT`, `SERA_EXTRA_ALLOWED_HOSTS`, `SERA_BLOCKED_HOSTS`, `SERA_ENABLED_PROVIDERS`, `SERA_DISABLED_PROVIDERS`, `SERA_ALLOW_PRIVATE_ADDRESSES` (forbidden in production).
- **Providers & Tools**: `SERA_YTDLP_PATH`, `SERA_FFMPEG_PATH`, `SERA_FFPROBE_PATH`, `SERA_GALLERYDL_PATH`, `SERA_REDDIT_CLIENT_ID`, `SERA_REDDIT_CLIENT_SECRET`, `SERA_INSTAGRAM_SESSION_ID`, `SERA_YOUTUBE_PLAYER_CLIENTS`, `SERA_YOUTUBE_POT_PROVIDER_URL`, `SERA_EXTRACTION_PROXY_URL`, `SERA_EXTRACTION_PROXY_PROVIDERS`, `SERA_TOOLS_PLATFORM`, `SERA_MANIFEST_REPO`, `PREFIX`.
- **Extraction Nodes & Tokens**: `SERA_NETWORK_CLASS`, `SERA_EXTRACTION_NODE_TOKENS`, `SERA_EXTRACTION_NODE_TOKEN`, `SERA_EXTRACTION_WORKER_TOKEN`, `SERA_EXTRACTION_CLAIM_HOLD_SECONDS`, `SERA_API_URL`, `SERA_NODE_ID`, `SERA_NODE_PROVIDERS`, `SERA_NODE_NETWORK_CLASS`, `SERA_CANARY_TOKEN`, `SERA_ADMIN_TOKEN`, `SERA_ALERT_NTFY_TOPIC`.
- **Web & Legal**: `SERA_WEB_PORT`, `SERA_FORCE_HTTPS`, `PORT`, `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL`, `OPERATOR_REGISTRATION_ID`, `CONTACT_EMAIL_AUTHORITIES`, `CONTACT_EMAIL_LEGAL`, and `NEXT_PUBLIC_*` counterparts for each legal field.
- **Docker / Deploy / CI**: `SERA_REDIS_PASSWORD`, `SERA_API_MEMORY`, `SERA_WORKER_CPUS`, `SERA_WORKER_MEMORY`, `SERA_IMAGE_API`, `SERA_IMAGE_WEB`, `SERA_TLS_EMAIL`, `SERA_REPO`, `SERA_DIR`, `SERA_PUBLIC_IP`, `SERA_ALERT_REPO`, `SERA_NODE_DIR`, `SERA_NODE_CHECK_SECONDS`, `SERA_TEST_REDIS_URL` (CI).

## 8. Build, CI & Deployment Pipeline

- **TypeScript build**: Root `tsconfig.json` orchestrates composite project references (`packages/contracts`, `packages/engine`, `apps/api`, `apps/worker`, `apps/extractor`) extending `tsconfig.base.json` (`NodeNext`, `ES2023`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). `tsconfig.tests.json` type-checks `*.test.ts`. `apps/web/tsconfig.json` runs separately with DOM libs and `noEmit`.
- **Docker images**:
  - `docker/api.Dockerfile`: builds `@sera/contracts`, `@sera/engine`, `@sera/api`, `@sera/worker`, prunes dev deps, installs `ffmpeg` + `tini` + checksum-verified `yt-dlp` (`ARG YTDLP_VERSION`), runs as non-root `node` on `:4000`.
  - `docker/web.Dockerfile`: builds `@sera/contracts` + `@sera/web` (`output: 'standalone'`), runs `node apps/web/server.js` via `tini` on `:3000`.
- **Compose stacks**:
  - `docker-compose.yml`: 4 services (`web`, `api`, `worker`, `redis` with `--maxmemory-policy noeviction`), read-only containers with `/tmp` tmpfs and `cap_drop: ALL`.
  - `docker-compose.standalone.yml`: 2 services (`web`, `api` with `SERA_QUEUE_DRIVER=memory`), no Redis/worker.
  - `deploy/docker-compose.oracle.yml`: production stack adding `caddy:2.11-alpine` (`deploy/Caddyfile` routing `/internal/extraction/*`, `/api/*`, `/health`, `/ready` → `api:4000` with `flush_interval -1` for SSE, everything else → `web:3000`) plus optional `potoken` profile (`bgutil-ytdlp-pot-provider`).
- **Server automation & remote nodes**: `deploy/provision.sh` installs Docker, firewall rules, `/usr/local/bin/sera` CLI wrapper, and systemd timers (`deploy/install-timers.sh` + `deploy/systemd/sera-{alert,canary,update}.{service,timer}`). Remote extraction nodes run via Termux (`deploy/node-android/{setup,run-node}.sh`) or Windows Task Scheduler (`deploy/node-windows/{install-task.ps1,run-node.cmd,refresh-ytdlp.cmd,kill-orphans.ps1}`).
- **GitHub Actions**: `.github/workflows/ci.yml` runs `format`, `lint`, `typecheck`, `test` (with Redis 7.4 service), `build`, `shellcheck`, API URL consistency check, Redis `noeviction` check, `config.ts` env schema drift check, Caddyfile validation, Docker multi-arch (`amd64`/`arm64`) build/smoke tests, and GHCR publish on `main`. `.github/workflows/update-ytdlp.yml` runs daily (`17 5 * * *` UTC) via `scripts/update-providers.mjs --write`, smoke-tests `check:providers`, triggers CI, and auto-merges.

## 9. Styling System & Assets

- **Web**: Tailwind CSS v4 (`@tailwindcss/postcss`) configured solely in `apps/web/src/styles/globals.css` using `@theme` OKLCH color/radius/shadow tokens and `@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *))`. Theme preference (`light`/`dark`/`system` in `sera-theme`) is applied pre-hydration by `apps/web/src/lib/theme-script.ts` to prevent FOUC. Icons are inline React SVGs in `apps/web/src/components/icons.tsx`; static assets live under `apps/web/public/` (`icon.svg`, `icons/apple-touch-icon.png`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/maskable-512.png`).
- **Android**: Material 3 `SeraPalette` in `apps/android/app/src/main/java/dev/sera/toolkit/ui/theme/Theme.kt` mirrors the web light/dark OKLCH tokens (`#FBFBFA` / `#0F0F12` canvas, `#3B5BD4` / `#7C96FF` accent), paired with vector adaptive launcher icons in `apps/android/app/src/main/res/drawable/` and `apps/android/app/src/main/res/mipmap-anydpi-v26/`.
