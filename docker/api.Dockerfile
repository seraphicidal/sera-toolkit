# syntax=docker/dockerfile:1.7
#
# The API and the worker ship as one image.
#
# They are the same program with different entrypoints — both need yt-dlp, FFmpeg and the
# engine — so building twice would only mean two chances for the media tooling to differ
# between the process that plans a job and the process that runs it.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app

# Manifests first: this layer is what makes an install cache hit possible when only
# source has changed.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
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
 && npm run build --workspace @sera/worker

# Drop the build-only dependencies before the artefacts are copied forward.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24.18.1-bookworm-slim AS runtime

# Pinned deliberately. `npm run update-providers` bumps this together with the manifest
# the local toolchain uses, so a deployment and a workstation run the same extractor.
ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH=amd64

ENV NODE_ENV=production \
    SERA_DATA_DIR=/data \
    SERA_HOST=0.0.0.0 \
    SERA_PORT=4000

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
        tini; \
    # yt-dlp comes from its own release rather than Debian, whose package is always
    # months behind — and months behind is indistinguishable from broken here.
    case "${TARGETARCH}" in \
        amd64) YTDLP_ASSET=yt-dlp_linux ;; \
        arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_ASSET}"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o /tmp/SHA2-256SUMS \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/SHA2-256SUMS"; \
    EXPECTED="$(grep " ${YTDLP_ASSET}\$" /tmp/SHA2-256SUMS | cut -d' ' -f1)"; \
    ACTUAL="$(sha256sum /usr/local/bin/yt-dlp | cut -d' ' -f1)"; \
    test -n "${EXPECTED}"; \
    test "${EXPECTED}" = "${ACTUAL}"; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    rm -f /tmp/SHA2-256SUMS; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    yt-dlp --version; \
    ffmpeg -version | head -n 1

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

# Media work runs as an unprivileged user, and /data is the only writable path it needs.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4000

# Liveness only. Readiness is /ready, which additionally proves the binaries run.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERA_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the yt-dlp and FFmpeg children this process spawns; without an init, a
# cancelled job leaves zombies behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
