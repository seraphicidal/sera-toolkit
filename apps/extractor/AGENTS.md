# @sera/extractor

Remote residential extraction node agent (`src/index.ts`, `src/node.ts`) that long-polls the SERA API and runs extraction/downloads from a home network.

## Commands (unverified)
- Minimal build (node-only deps): `npm run build:node` (builds `@sera/contracts`, `@sera/engine`, `@sera/extractor`)
- Dev watch: `npm run dev --workspace @sera/extractor`
- Run with env file: `npm run serve:node` (`node --env-file=.env.node.local apps/extractor/dist/index.js`)
- Split integration checks (require built artifacts): `npm run check:split` and `npm run check:node`

## Specifics
- Requires `SERA_API_URL` and `SERA_EXTRACTION_NODE_TOKEN` (must match the node's entry in the API's `SERA_EXTRACTION_NODE_TOKENS` as `<nodeId>:<token>` or legacy single token).
- `ExtractionNode` posts to `/internal/extraction/claim` with `SERA_NODE_ID`, `SERA_NODE_PROVIDERS`, `SERA_NODE_NETWORK_CLASS` (default `residential`), and declared `NodeFeature`s (`trim`, `subtitles`, `items`, plus `instagram-session` when `SERA_INSTAGRAM_SESSION_ID` is set).
- Re-validates claimed task URLs locally against `allowPrivateAddresses` / `blockedHosts` / provider detection before executing `MediaResolver.resolveCanonical()` or `JobRunner.run()`.
- Uploads finished files concurrently (2 streams) via `POST /internal/extraction/:taskId/file` (`application/octet-stream`), sends 1s progress heartbeats (`POST .../progress`) that detect server-side cancellation, and cleans up its local workspace on completion.

## Gotchas
- Does not depend on Redis or Next.js; only needs `@sera/contracts`, `@sera/engine`, `yt-dlp`, and `ffmpeg`.
- Termux/Android (`deploy/node-android/setup.sh`, `deploy/node-android/run-node.sh`) and Windows Scheduled Task (`deploy/node-windows/install-task.ps1`, `deploy/node-windows/run-node.cmd`) supervisors exist in `deploy/`.
