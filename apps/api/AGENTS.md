# @sera/api

Fastify 5.12.8 HTTP/SSE API server and admin/canary CLIs for SERA.toolkit.

## Commands (unverified)

- Dev watch: `npm run dev --workspace @sera/api`
- Build: `npm run build --workspace @sera/api`
- Start: `npm run start` (runs `node apps/api/dist/index.js` on `SERA_HOST:SERA_PORT`, default `0.0.0.0:4000`)
- CLIs (built): `node apps/api/dist/canary-cli.js`, `node apps/api/dist/stats-cli.js`, `node apps/api/dist/reports-cli.js`

## Specifics

- Entry point `src/index.ts` loads `apps/api/.env` in non-production via `loadEnvFile`, creates `SeraEngine`, calls `buildServer(engine)`, starts an embedded worker unless `SERA_QUEUE_DRIVER=redis` with `SERA_EMBEDDED_WORKER=false`, and listens.
- `src/server.ts` registers `errorHandlerPlugin`, `clientKeyPlugin`, `@fastify/cors`, non-global `@fastify/rate-limit`, security headers (`onSend`), and route modules in `src/routes/`.
- Client keys (`src/plugins/client.ts`): IPv6 normalized to `/64`, IPv4-mapped unwrapped, HMAC-SHA256 rotated daily; `request.clientKeys` carries current and previous epoch keys for job access across midnight UTC.
- Auth: `SERA_ADMIN_TOKEN` (Bearer) gates `/api/admin/*` and unredacted `/health` + `/ready`; `SERA_CANARY_TOKEN` (`x-sera-canary` header) bypasses rate limits, abuse cooldowns, and usage counters; `SERA_EXTRACTION_NODE_TOKENS` / `SERA_EXTRACTION_WORKER_TOKEN` gate `/internal/extraction/*`.
- Job file downloads (`src/routes/jobs.ts`) support `HEAD`, `Range`/`If-Range` (`206`), ETag/Last-Modified, and sandboxed CSP headers.

## Gotchas

- When `SERA_ADMIN_TOKEN` is unset, `src/routes/admin.ts` mounts zero admin routes.
- When `SERA_EXTRACTION_NODE_TOKENS` and `SERA_EXTRACTION_NODE_TOKEN` are unset, `src/routes/extraction-node.ts` mounts zero `/internal/extraction/*` routes.
- `src/reports-cli.ts` and `src/stats-cli.ts` mention `deploy/ORACLE.md` in missing-token errors, but that file does not exist in `deploy/`.
