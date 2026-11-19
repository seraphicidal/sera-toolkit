# @sera/web

Next.js 16.4.5 (React 19.3.0, Tailwind CSS 4.3.3) frontend for SERA.toolkit.

## Commands (unverified)

- Dev server (port 3200): `npm run dev --workspace @sera/web`
- Build (standalone): `npm run build --workspace @sera/web`
- Typecheck: `npx tsc -p apps/web/tsconfig.json --pretty`
- Tests (Vitest from root): `npx vitest run apps/web`

## Specifics

- `apps/web/tsconfig.json` is excluded from root `tsconfig.json` because Next.js requires `noEmit` and DOM libs.
- Runtime proxy: `src/app/api/[...path]/route.ts`, `src/app/health/route.ts`, and `src/app/ready/route.ts` forward all methods to `SERA_API_URL` (default `http://127.0.0.1:4000`) via `src/lib/backend-proxy.ts` with `accept-encoding: identity` so SSE and byte-range streams pass intact.
- CSP & nonces: `src/proxy.ts` (Next.js 16 proxy hook) mints a per-request `x-nonce` header and sets dynamic CSP via `src/lib/csp.ts`; `src/app/layout.tsx` injects `themeScript` with that nonce, and `next.config.ts` sets static fallback headers using `themeScriptHash`.
- Theme & styling: OKLCH CSS custom properties in `src/styles/globals.css` (`:root` + `:root[data-theme='dark']`), pre-hydration script in `src/lib/theme-script.ts`.
- Client state: `localStorage` keys `sera-theme`, `sera-preferred-kind`, and `sera-history` (max 10 items). Live job progress uses `EventSource` on `/api/jobs/:id/events` with automatic polling fallback in `src/lib/use-job.ts`.
- Legal pages (`/legal/notice`, `/legal/privacy`, `/legal/report`) are `force-dynamic` and read `OPERATOR_*` / `CONTACT_EMAIL_*` (or `NEXT_PUBLIC_*` fallbacks) on the server.
- Browser import (`/import`): `src/components/import-client.tsx` + `src/lib/import-handshake.ts` accept `#v=2&p=` fragments or `window.opener` `postMessage` payloads from Instagram via the bookmarklet in `src/lib/bookmarklet.ts`.

## Gotchas

- `docker/web.Dockerfile` currently passes `SERA_API_URL` as runtime `ENV`, while `.github/workflows/ci.yml` still greps `ARG SERA_API_URL=` from `docker/web.Dockerfile`.
- `scripts/serve-public.mjs` copies `.next/standalone`, `.next/static`, and `public/` into `.data/run/web/` before starting `server.js`.
