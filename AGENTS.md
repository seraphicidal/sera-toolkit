# SERA.toolkit (`sera-toolkit`)

SERA.toolkit is a universal media toolkit for resolving, downloading, trimming, subtitle-extracting, tagging, and converting publicly accessible video, audio, images, and GIFs across 23 built-in providers and generic web pages. It prioritizes SSRF defense, zero tracking, ephemeral workspaces, and optional residential extraction-node fallback for datacenter-blocked platforms.

## Tech Stack

- **Runtime & Tooling**: Node.js `>=22.12.0` (`24.18.1` in CI/Docker), npm workspaces, TypeScript `6.0.3`, Vitest `5.0.0`, ESLint `10.12.0`, Prettier `3.9.6` (`prettier-plugin-tailwindcss` `0.8.1`).
- **Backend (`@sera/api`, `@sera/worker`, `@sera/extractor`, `@sera/engine`, `@sera/contracts`)**: Fastify `^5.12.8`, BullMQ `6.3.11`, `ioredis` `6.0.0`, Zod `^4.6.7`, `undici` `^8.12.4`, `cheerio` `1.2.0`, `yazl` `3.3.1`, `pino` `10.4.0`.
- **Web (`@sera/web`)**: Next.js `16.4.5` (App Router, `output: 'standalone'`), React `19.3.0`, Tailwind CSS `4.3.3`.
- **Media Binaries**: Pinned in `scripts/tools.manifest.json`: `yt-dlp` `2026.10.26`, `ffmpeg`/`ffprobe` `n8.1.3-32-g760d10603e`, optional `gallery-dl`.
- **Android (`apps/android`)**: Kotlin `2.0.21`, AGP `8.7.3`, Jetpack Compose BOM `2024.12.01`, Navigation Compose `2.8.5`, WorkManager `2.10.0`, OkHttp `4.12.0`, DataStore `1.1.1`, Coil `2.7.0`, Media3 `1.5.1`.

## Commands (unverified; inspect `package.json` / `.github/workflows/ci.yml`)

- **Install & fetch media tools**: `npm ci --ignore-scripts && npm run tools:fetch` (or `npm install`)
- **Run locally (dev)**: `npm run dev` (runs `tsc --watch`, API on `:4000`, web on `:3200`; pass `-- --worker` for external worker), or individually `npm run dev:api`, `npm run dev:web`, `npm run dev:worker`
- **Run production-like locally**: `npm run serve:local` (or `npm run serve:public` with `.tools/cloudflared`), `npm run serve:node` (remote extractor via `.env.node.local`)
- **Build**: `npm run build` (all workspaces) | `npm run build:node` (extractor subset)
- **Test**: `npm test` (`vitest run`) | `npm run test:watch` | `npm run test:coverage`
- **Format, Lint, Typecheck, Verify**: `npm run format` / `npm run format:fix`, `npm run lint` / `npm run lint:fix`, `npm run typecheck`, `npm run verify` (all 5 checks)
- **Live / Integration Checks**: `node scripts/smoke-live.mjs`, `npm run check:providers`, `npm run check:split`, `npm run check:node`, `npm run update-providers`
- **Android app checks (verified in `apps/android`)**: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` (Windows: `.\gradlew.bat :app:testDebugUnitTest --rerun :app:lintDebug :app:assembleDebug --stacktrace`)
- **Deploy**: `docker compose up -d` (`docker-compose.yml` or `docker-compose.standalone.yml`), or on a fresh Linux VPS `sudo bash deploy/provision.sh` (`deploy/docker-compose.oracle.yml` + `deploy/Caddyfile` + systemd timers)

## Directory Map

- `packages/contracts/`: Shared TypeScript interfaces (`src/types.ts`), Zod schemas, and compile-time shape assertions (`src/schemas.ts`).
- `packages/engine/`: Core resolver, 23 media providers, `yt-dlp`/`gallery-dl`/HTML extractors, FFmpeg converter/trimmer/tagger, BullMQ/memory queues, workspace reaper, SSRF/denylist/abuse security.
- `apps/api/`: Fastify API server, middleware plugins (`client`, `admin-auth`, `errors`, `disconnect`), REST/SSE/internal routes, and `apps/api/src/{canary,reports,stats}-cli.ts`.
- `apps/worker/`: Standalone BullMQ worker process for Redis-backed deployments (`SERA_QUEUE_DRIVER=redis`).
- `apps/extractor/`: Remote residential extraction node agent that long-polls `/internal/extraction/claim` and uploads outputs.
- `apps/web/`: Next.js frontend, runtime `/api`+`/health`+`/ready` backend proxy, CSP nonce proxy (`src/proxy.ts`), Tailwind v4 OKLCH theme.
- `apps/android/`: Native Kotlin/Compose Android client (`dev.sera.toolkit`, `MainActivity` + translucent `ShareActivity`, foreground WorkManager downloads, resumable `Range`/`If-Range` transfers).
- `test/`: Cross-package integration, security, EU compliance, trim, subtitle, audio-tag, and website tests.
- `scripts/`: Dev runner, pinned binary downloader (`fetch-tools.mjs`), provider checks, split-node E2E checks, and local tunnel server.
- `docker/` & `deploy/`: Dockerfiles (`api`, `web`), Compose stacks, Caddy config, Oracle VPS provisioning, systemd timers, and Android/Windows node supervisors.
- `.github/workflows/`: CI verification/image/Android builds (`ci.yml`), Android client release (`android-release.yml`), Android node release (`android-node-release.yml`), and daily `yt-dlp` auto-pin PR workflow (`update-ytdlp.yml`).

## How Apps Relate

- `@sera/contracts` is shared by all TypeScript workspaces (`apps/android/app/src/main/java/dev/sera/toolkit/model/Contracts.kt` mirrors it manually in Kotlin).
- `@sera/engine` is shared by `apps/api`, `apps/worker`, and `apps/extractor`.
- `apps/web` never talks to Redis or `yt-dlp`; its Next.js Route Handlers (`apps/web/src/app/api/[...path]/route.ts`, `health/route.ts`, `ready/route.ts`) proxy requests at runtime to `SERA_API_URL` (`@sera/api`).
- `apps/api` and `apps/worker` share one Docker image (`docker/api.Dockerfile`), Redis (`SERA_REDIS_URL`), and the `media:/data` volume (`SERA_DATA_DIR`).
- `apps/extractor` connects only to `apps/api` over HTTPS via `/internal/extraction/*`; `apps/worker` dispatches remote tasks to `apps/api` via `RemoteOverHttp`.
- `apps/android` connects directly to `apps/api` endpoints (`/health`, `/api/info`, `/api/media/*`, `/api/jobs/*`, `/api/legal/report`) and opens `/legal/*` pages on the configured server.

## Entry Points & Where to Start

- **Entry points**: `apps/api/src/index.ts`, `apps/worker/src/index.ts`, `apps/extractor/src/index.ts`, `apps/web/src/app/layout.tsx` + `page.tsx`, `packages/engine/src/engine.ts`.
- **Add a web page**: Create `apps/web/src/app/<route>/page.tsx`; link from `apps/web/src/app/layout.tsx` if needed.
- **Add an API endpoint**: Add handler in `apps/api/src/routes/`, register in `apps/api/src/server.ts`, add shared types/schemas in `packages/contracts/src/{types,schemas}.ts`, and mirror client call in `apps/web/src/lib/api.ts` (and `apps/android/app/src/main/java/dev/sera/toolkit/data/SeraApiClient.kt` if keeping parity).
- **Add/update a media provider**: Implement `MediaProvider` (or extend `YtdlpProvider`) in `packages/engine/src/providers/`, register in `createProviders()` in `packages/engine/src/providers/index.ts`, add canary/smoke test URL to `scripts/provider-cases.json`.
- **Change styling**: Edit OKLCH `@theme` / dark tokens in `apps/web/src/styles/globals.css` (and `apps/android/app/src/main/java/dev/sera/toolkit/ui/theme/Theme.kt` for parity).
- **Add static/legal content**: Edit `apps/web/src/app/about/page.tsx` or `apps/web/src/app/legal/{notice,privacy,report,terms}/page.tsx`.

## Conventions

- **TypeScript & ESM**: `NodeNext` resolution (`.js` extensions in TS imports across Node packages; omit in `apps/web` which uses `bundler`), `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `consistent-type-imports` (inline `type`).
- **Subprocess safety**: ESLint `no-restricted-syntax` bans `child_process.exec`/`execSync`; always use `spawn` via `packages/engine/src/util/spawn.ts` (`shell: false`). `no-console` allows only `warn`/`error` outside tests/scripts.
- **Error handling**: Throw `seraError(code, options)` from `packages/engine/src/errors.ts`; Fastify's `errorHandlerPlugin` maps `SeraError`, `ZodError`, and `AbortError` to `ApiErrorBody`.
- **Stateless HMAC tokens**: Never persist user URLs or format choices in DBs; `MediaResolver` signs `infoId`, `optionId`, and thumbnail tokens via `packages/engine/src/util/tokens.ts`.
- **Privacy**: Client IPs are `/64`-masked and daily-HMAC-hashed in `apps/api/src/plugins/client.ts`; logs use `logSafeUrl()` and `maskSecrets()`.

## Gotchas

- **Shell/CI drift in `docker/web.Dockerfile`**: Working-tree changes moved `SERA_API_URL` from build `ARG` to runtime `ENV` + Route Handlers, so `.github/workflows/ci.yml` (`Check the API URL is the same at build time and run time` grepping `ARG SERA_API_URL=`) will fail unless updated or reconciled.
- **Redis Lua empty-array quirk**: `PATCH_LUA` in `packages/engine/src/queue/redis.ts` uses `cjson`, which encodes empty Lua tables as `{}`; always decode Redis job records through `parseRedisRecord()` and strip `resolvedMedia`/`rawInfoJson` in patches to keep Redis memory small.
- **Redis `noeviction` invariant**: CI enforces `--maxmemory-policy noeviction` on all compose files so BullMQ job keys are never evicted.
- **SSRF & `EgressGuard`**: `yt-dlp` and `ffmpeg` are routed through `EgressGuard`'s loopback proxy (`packages/engine/src/security/egress.ts`); `SERA_ALLOW_PRIVATE_ADDRESSES=true` throws `ConfigError` in production.
- **Dynamic route mounting**: `/api/admin/*` mounts only when `SERA_ADMIN_TOKEN` is non-empty; `/internal/extraction/*` mounts only when `SERA_EXTRACTION_NODE_TOKENS` or `SERA_EXTRACTION_NODE_TOKEN` is set.
- **Token/CSP coupling**: `apps/web/src/lib/csp.ts` hashes `themeScript` (`themeScriptHash`) for static headers and uses per-request nonces in `apps/web/src/proxy.ts`; changing `themeScript` requires keeping both in sync.
- **Missing doc ref**: `apps/api/src/{reports,stats}-cli.ts` and `deploy/canary.sh` reference `deploy/ORACLE.md`, which does not exist.

## Detailed Docs & Per-App Guides

- Full architecture, routing, data flows, endpoints, env vars, and deploy details: [docs/architecture.md](docs/architecture.md)
- App-specific guides: [apps/web/AGENTS.md](apps/web/AGENTS.md), [apps/api/AGENTS.md](apps/api/AGENTS.md), [apps/worker/AGENTS.md](apps/worker/AGENTS.md), [apps/extractor/AGENTS.md](apps/extractor/AGENTS.md), [apps/android/AGENTS.md](apps/android/AGENTS.md)

## Maintaining this map

Update `AGENTS.md`, `docs/architecture.md`, and the affected `apps/*/AGENTS.md` whenever you add/rename routes, API endpoints, providers, env vars, build/deploy commands, or architectural patterns.

Last verified: 2026-11-18 · commit `967c04465bd47ba60a5d5a1fd649ec92c203a512` (dirty working tree with uncommitted edits and untracked `apps/android/`).
