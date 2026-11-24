# syntax=docker/dockerfile:1.7

FROM node:26.13.1-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/extractor/package.json apps/extractor/
COPY apps/web/package.json apps/web/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspaces --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/

RUN npm run build --workspace @sera/contracts \
 && npm run build --workspace @sera/engine \
 && npm run build --workspace @sera/api \
 && npm run build --workspace @sera/worker \
 && npm prune --omit=dev --workspace @sera/contracts --workspace @sera/engine --workspace @sera/api --workspace @sera/worker --include-workspace-root \
 && rm -rf apps/web node_modules/@sera/web

FROM node:26.13.1-bookworm-slim AS runtime

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        tini; \
    rm -rf /var/lib/apt/lists/*; \
    ffmpeg -version | head -n 1

ARG YTDLP_VERSION=2026.11.23

ARG TARGETARCH

ENV NODE_ENV=production \
    HOME=/tmp \
    SERA_DATA_DIR=/data \
    SERA_HOST=0.0.0.0 \
    SERA_PORT=4000

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) YTDLP_ASSET=yt-dlp_linux ;; \
        arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    YTDLP_VERSION="${YTDLP_VERSION}" YTDLP_ASSET="${YTDLP_ASSET}" node -e ' \
      const { createHash } = require("node:crypto"); \
      const { chmodSync, writeFileSync } = require("node:fs"); \
      (async () => { \
        const v = process.env.YTDLP_VERSION; \
        const a = process.env.YTDLP_ASSET; \
        const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${v}`; \
        const fetchWithRetry = async (u) => { \
          for (let i = 0; i < 5; i += 1) { \
            try { \
              const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); \
              if (r.ok) return Buffer.from(await r.arrayBuffer()); \
              throw new Error(`HTTP ${r.status}`); \
            } catch (e) { \
              if (i === 4) throw e; \
              await new Promise((res) => setTimeout(res, 3000)); \
            } \
          } \
        }; \
        const [bin, sums] = await Promise.all([ \
          fetchWithRetry(`${base}/${a}`), \
          fetchWithRetry(`${base}/SHA2-256SUMS`), \
        ]); \
        const line = sums.toString("utf8").split("\n").find((l) => l.endsWith(` ${a}`)); \
        const expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : ""; \
        const actual = createHash("sha256").update(bin).digest("hex"); \
        if (!expected || actual !== expected) { \
          throw new Error(`checksum mismatch for ${a}: expected ${expected}, got ${actual}`); \
        } \
        writeFileSync("/usr/local/bin/yt-dlp", bin); \
        chmodSync("/usr/local/bin/yt-dlp", 0o755); \
      })().catch((e) => { console.error(e); process.exit(1); }); \
    '; \
    yt-dlp --version

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/engine/package.json ./packages/engine/
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY scripts/provider-cases.json ./scripts/provider-cases.json
COPY scripts/tools.manifest.json ./scripts/tools.manifest.json

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERA_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
