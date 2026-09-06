# SERA.toolkit

A universal media toolkit for downloading and converting publicly accessible media.

Paste a link. SERA works out which site it belongs to, asks that site what the post
actually contains, and offers the formats that genuinely exist for it. One link in,
whatever media is available out.

```
Paste a link  →  detect the source  →  read what is there  →  choose  →  download
```

---

## What it does

- **One input.** No source picker, no format guessing. The interface has nothing to
  configure until it knows what is behind the link.
- **Whole posts, not first items.** A carousel, gallery or photo slideshow resolves to
  every piece of media in it. Pick the parts you want; several files come back as a ZIP,
  or separately.
- **Honest formats.** Video in MP4, WebM or MOV — whichever the source remuxes into
  without re-encoding — at the resolutions the site actually publishes. Audio as MP3,
  M4A, Opus or WAV. Images untouched. Short videos convertible to GIF.
- **Real progress.** Bytes, speed and ETA over Server-Sent Events, with polling as a
  fallback for networks that buffer streams.
- **No account, no tracking, no retention.** Files are deleted on a timer whether or not
  you downloaded them.

### Supported sources

YouTube (including Shorts and Music), X, TikTok, Instagram, Reddit, Twitch, Vimeo,
SoundCloud, Facebook, Pinterest, Bandcamp, Dailymotion, Tumblr, Threads, Bluesky,
Mastodon and the wider fediverse, Snapchat Spotlight — plus any page that publishes its
own media in the standard way, and any direct link to a media file.

Adding another is one file and one registry line. See [Providers](#providers).

---

## Running it

### Docker

```bash
cp .env.example .env
# Set SERA_SECRET — the one value with no safe default:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

docker compose up --build
```

Open <http://localhost:3000>.

The default stack is `web`, `api`, `worker` and `redis`. Only the web container publishes
a port; it proxies `/api` internally, so the deployment is a single origin and the API is
never directly reachable. Scale the media work with:

```bash
docker compose up --scale worker=4
```

For a personal instance, `docker-compose.standalone.yml` runs the same image without
Redis — the API hosts its own worker in-process:

```bash
docker compose -f docker-compose.standalone.yml up --build
```

### Can GitHub host it?

Partly — it depends which GitHub product:

|                        | Can it run SERA?                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Pages**              | No. Static files only. SERA needs a Node server for the `/api` proxy, and a backend that can execute yt-dlp and FFmpeg.                 |
| **Actions**            | No. Runners are ephemeral, have no inbound networking, and using them as a hosting service is against GitHub's Acceptable Use Policies. |
| **Codespaces**         | **Yes.** A real Linux container with Docker, and a forwarded port can be made public over HTTPS.                                        |
| **Container registry** | For the images, yes — CI publishes them to `ghcr.io` (see below).                                                                       |

#### Codespaces

Open the repo → **Code → Codespaces → Create codespace on main**. The devcontainer
installs FFmpeg, fetches the pinned yt-dlp and builds the workspace. Then:

```bash
npm run serve:local
```

Codespaces forwards port 3200 and gives you an `https://<name>-3200.app.github.dev`
URL. If it prompts for a login, set the port to **Public** in the Ports panel.

To run the full four-service stack with Redis instead — Docker is available in the
container:

```bash
cp .env.example .env && echo "SERA_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up --build
```

Honest limits: a Codespace **suspends after inactivity** (30 minutes by default) and
consumes your monthly Codespaces allowance while running, so this is a good demo or
personal instance, not an always-on service. Check your usage under
_Settings → Billing_ before leaving one running.

#### Prebuilt images

Every push to `main` publishes both images to GitHub's registry, so deploying
anywhere is a pull rather than a build:

```bash
docker pull ghcr.io/seraphicidal/sera-api:latest
docker pull ghcr.io/seraphicidal/sera-web:latest
```

### Publicly, from your own machine

For a personal instance with no hosting bill, SERA can run its production build locally
and expose it over HTTPS through a Cloudflare quick tunnel — no account, no card, and no
inbound port forwarding:

```bash
npm run build
npm run serve:public
```

It prints a public `https://….trycloudflare.com` URL and writes it to
`.data/public-url.txt`. The API binds to loopback only, so the tunnel publishes exactly
one port: the web app, which proxies `/api` internally.

What this shape is and is not: the signing secret is generated once into
`.env.production.local` and reused, each component is supervised and restarted with a
backoff if it crashes, and the limits are tuned for a desktop. But a quick tunnel is
ephemeral — the hostname changes every time it restarts, and the service is only up while
the machine is. For a stable address, use the Docker stack on a host that stays on.

### From source

Requires Node 22.12 or newer.

```bash
npm install
npm run tools:fetch    # pinned yt-dlp + FFmpeg into .tools/, checksum-verified
npm run dev            # API on :4000, web on :3200
```

`npm run tools:fetch` is optional if yt-dlp and FFmpeg are already on your `PATH`; a
binary in `.tools/` simply wins over one on `PATH`, so a deployment gets the version the
manifest names rather than whatever the host happens to have.

---

## How it is put together

```
                    ┌──────────────┐
   browser  ───────▶│  Next.js web │   proxies /api, so everything is one origin
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Fastify API │   resolve, enqueue, stream progress, serve files
                    └──────┬───────┘
                           │  queue (in-process, or Redis)
              ┌────────────┴────────────┐
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │   worker    │           │   worker    │   yt-dlp + FFmpeg
       └──────┬──────┘           └──────┬──────┘
              └────────────┬────────────┘
                           ▼
                    shared media volume
```

| Package              | What it is                                                              |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/contracts` | The types the UI and server share, plus the schemas that validate them  |
| `packages/engine`    | Providers, extraction, conversion, the job pipeline, the security layer |
| `apps/api`           | HTTP surface                                                            |
| `apps/worker`        | The media pipeline with no HTTP surface                                 |
| `apps/web`           | The interface                                                           |

### The normalized model

Everything a provider returns is flattened into one shape before it reaches the UI:

```
MediaInfo ── items[] ── options[]
```

An **option** is a concrete thing the user can ask for — `1080p`, `MP3`, `Original` —
carrying its container, its estimated size, and whether it needs converting. The frontend
never sees a codec string, an itag, or a provider name it has to branch on, which is why
adding a platform changes no UI code.

### Signed handles instead of server state

An analysis returns opaque, HMAC-signed handles rather than keys into a table. Three
things follow:

- The API and the workers share no state, so they scale and restart independently.
- A client cannot edit a handle to point the download pipeline at a URL the resolver
  never approved — forging one needs the server secret.
- The job re-resolves the link at download time, so an expired CDN URL is never the
  reason a download fails.

### Providers

A provider turns a URL into media. It never downloads, never touches the filesystem, and
never decides how a file is named:

```ts
export class ExampleProvider extends YtdlpProvider {
  readonly id = 'example';
  readonly label = 'Example';
  readonly hosts = ['example.com'];

  override normalize(url: URL): URL {
    /* canonicalize the URL forms the site serves */
  }
}
```

Add it to `createProviders()` in `packages/engine/src/providers/index.ts` and it is live.
A provider that starts failing is marked degraded and reported on the About page, rather
than taking the service down with it.

---

## Configuration

Every setting is an environment variable, documented in
[`.env.example`](./.env.example). The ones worth knowing:

| Variable                       | Default  | Notes                                                         |
| ------------------------------ | -------- | ------------------------------------------------------------- |
| `SERA_SECRET`                  | —        | Required in production. Signs the handles the browser holds.  |
| `SERA_RETENTION_SECONDS`       | `1800`   | How long finished files survive. This is the privacy setting. |
| `SERA_QUEUE_DRIVER`            | `memory` | `memory` for one container, `redis` to scale workers out.     |
| `SERA_MAX_FILESIZE_BYTES`      | 4 GiB    | Refused before the download starts where the size is known.   |
| `SERA_EXTRA_ALLOWED_HOSTS`     | empty    | Hosts the generic extractor may be pointed at. Opt-in.        |
| `SERA_ALLOW_PRIVATE_ADDRESSES` | `false`  | Development only. Configuration refuses it in production.     |

---

## Security

The threat here is specific: a service that fetches arbitrary URLs on a user's behalf is
an SSRF engine unless it is built not to be.

- **Address guard in the DNS lookup.** Filtering happens inside the lookup the socket
  actually uses, not in a check before the request — so there is no window in which a
  second DNS answer differs from the first. Loopback, link-local (including cloud
  metadata), every private range and their IPv4-mapped spellings are refused.
- **No shell, ever.** External tools are started with argument arrays, `shell: false`,
  and `--ignore-config` so a stray config file cannot inject `--exec`. URLs are always
  positional, after a bare `--`.
- **Extractor hosts are an allowlist.** A link is never handed to yt-dlp merely because
  yt-dlp might recognise it; the generic path reads a page's own declared media through
  the guarded client, and honours `robots.txt`.
- **Filenames cannot be paths.** Separators, drive letters, control characters and
  bidirectional overrides are stripped rather than escaped, and reads are re-validated
  against the manifest and the workspace root.
- **Bounded everything.** Size, duration, item count, job time, queue depth, per-client
  concurrency and request rate all have ceilings, enforced before work starts where the
  value is known and mid-stream where it is not.
- **Nothing internal crosses the wire.** Clients get a sentence and a code; stack traces
  and extractor output stay in the structured log.

SERA processes only what a provider can legitimately reach. It does not defeat DRM, sign
in, bypass paywalls, or reach content behind an access control.

---

## Development

```bash
npm run dev            # everything, with the TypeScript build in watch mode
npm test               # 269 tests, including a real end-to-end pipeline
npm run test:coverage
npm run verify         # format, lint, typecheck, test, build — run before shipping
```

`npm test` is fully offline. It generates real media with FFmpeg, serves it over a local
HTTP server, and runs it through the actual pipeline — real downloads, real conversions,
real archives, every output read back with ffprobe.

To check the extractor against live sites:

```bash
node scripts/smoke-live.mjs                       # a default URL
node scripts/smoke-live.mjs <url> [<url> ...]     # your own
```

### Keeping up with the sites

Platforms change how they serve media, and yt-dlp changes to follow them:

```bash
npm run update-providers            # report
npm run update-providers -- --write # pin the newest release
npm run tools:fetch -- --force
npm test && node scripts/smoke-live.mjs
```

The version is pinned in both `scripts/tools.manifest.json` and `docker/api.Dockerfile`,
and the script keeps them in step.

---

## Responsible use

You are responsible for making sure you have the rights to the media you download.
Copyright, platform terms and local law all still apply, and nothing here changes them.
SERA is a tool for working with media you are entitled to work with.

## License

MIT.

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
[FFmpeg](https://ffmpeg.org/), which do the genuinely hard work.
