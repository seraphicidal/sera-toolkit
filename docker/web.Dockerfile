# syntax=docker/dockerfile:1.7
#
# The web front end.
#
# Next's standalone output is used, so the runtime image carries a traced subset of
# node_modules rather than the whole workspace. Nothing media-related is installed here:
# this container serves HTML and proxies /api, and has no business holding an extractor.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app

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
COPY apps/web/ apps/web/

# The browser bundle imports `@sera/contracts/types` from source through the tsconfig
# path mapping, so only the types package needs building here.
RUN npm run build --workspace @sera/contracts

# Where the API lives. This is a BUILD-time setting and cannot be changed afterwards:
# Next resolves rewrites() when it builds and writes the destination into the standalone
# bundle, so the runtime environment has no effect on where /api/* is proxied. Setting a
# different value at runtime produces 500s and an ENOTFOUND for the baked host.
#
# The same variable IS read at runtime by server components, so it must be set to the
# SAME value in both places — which is why the compose file names its API service `api`.
# .github/workflows/ci.yml checks that the two agree.
ARG SERA_API_URL=http://api:4000
ENV SERA_API_URL=${SERA_API_URL} \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build --workspace @sera/web

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24.18.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The standalone output is rooted at the workspace, so the server lands under apps/web.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
