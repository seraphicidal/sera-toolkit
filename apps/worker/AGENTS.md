# @sera/worker

Standalone BullMQ job consumer (`apps/worker/src/index.ts`) for Redis-backed deployments.

## Commands (unverified)

- Dev watch: `npm run dev --workspace @sera/worker`
- Build: `npm run build --workspace @sera/worker`
- Start: `node apps/worker/dist/index.js`

## Specifics

- Requires `SERA_QUEUE_DRIVER=redis`; exits immediately with code `1` if `engine.backend.driver !== 'redis'` (with `memory`, `@sera/api` runs an embedded worker instead).
- Calls `SeraEngine.create()` and `engine.startWorker()`, sharing the Redis instance (`SERA_REDIS_URL`) and workspace volume (`SERA_DATA_DIR`, `/data` in Docker) with `@sera/api`.
- Touches `$SERA_DATA_DIR/.worker-alive` every 15s for the Docker Compose healthcheck (`mtime < 60s`).
- If extraction nodes are enabled and `SERA_API_URL` is set, `SeraEngine` creates `RemoteOverHttp` using `SERA_EXTRACTION_WORKER_TOKEN` (falling back to legacy `SERA_EXTRACTION_NODE_TOKEN` or `SERA_ADMIN_TOKEN`) to dispatch tasks via `/internal/extraction/dispatch`.

## Gotchas

- `docker-compose.yml` and `deploy/docker-compose.oracle.yml` reuse `docker/api.Dockerfile` with `command: ['node', 'apps/worker/dist/index.js']` and `stop_grace_period: 10m` so active FFmpeg/yt-dlp jobs drain cleanly on `SIGTERM`/`SIGINT`.
- Both API and worker containers must mount the same `media:/data` volume so files written by the worker can be served by the API's `/api/jobs/:id/download` and `/api/jobs/:id/files/:name` routes.
