# The extraction node

Some platforms refuse a datacentre. YouTube is the clearest case: from Oracle it answers
_"Sign in to confirm you're not a bot"_ on the player request, and from a home connection
the same link resolves normally. That is a property of the address, not of the code, and
no amount of configuration on the server changes it.

An extraction node is a machine you control on a connection those platforms do not refuse.
It does the extraction the server cannot, and hands the finished file back.

```
        visitor
           │
     ┌─────▼─────┐        refused here
     │  Oracle   │ ─── youtube.com ──✗
     │  worker   │
     └─────┬─────┘
           │ task, over the connection the node opened
     ┌─────▼─────────┐
     │ your machine  │ ─── youtube.com ──✓
     │ yt-dlp+FFmpeg │
     └───────────────┘
```

## Why it does whole jobs

A resolution on one network and a download on another do not compose. Measured: the same
signed `googlevideo.com` URL answers `206` from a home connection and `403` from Oracle
minutes later — YouTube binds the URL to the address that asked for it. So a node that
resolves a link also downloads it, converts it, and uploads the result. The server never
touches the media host.

## Why it is not a proxy

The node **listens on nothing**. It opens a connection outwards, asks for work, and does
what it is given. There is no port to forward, no inbound rule, and nothing routable
pointed at your machine. A host that accepts no connections cannot be turned into an open
proxy, whatever happens to the credential.

It only ever performs work the SERA deployment you configured hands it, and it deletes its
copy of every file when the upload finishes.

## Setting one up

**1. Give the server a secret.** In `/opt/sera/.env`:

```bash
SERA_EXTRACTION_NODE_TOKEN=$(openssl rand -hex 32)
```

Without this the endpoints are not mounted at all — a deployment with no node should not
have an endpoint that accepts one.

**2. Run the node on your machine**, from a checkout of this repository:

```bash
npm ci
npm run build

SERA_API_URL=https://your-deployment \
SERA_EXTRACTION_NODE_TOKEN=<the same secret> \
SERA_NODE_ID=laptop \
SERA_NODE_PROVIDERS=youtube \
node apps/extractor/dist/index.js
```

It needs `yt-dlp` and `ffmpeg`; `npm run tools:fetch` puts pinned copies in `.tools/`.
`SERA_NODE_ID` defaults to `residential`, which is fine for exactly one node.

The same settings can live in `.env.node.local` at the repository root instead — git
ignores it, and it is the form that works unchanged in PowerShell:

```bash
npm run serve:node
```

More than one machine can be a node at once. Give each its own `SERA_NODE_ID` — `home`,
`laptop` — and whichever is up takes the work; nodes sharing an ID are counted as one. An
Android phone can be one too: [EXTRACTION-NODE-ANDROID.md](EXTRACTION-NODE-ANDROID.md).

`SERA_NODE_PROVIDERS` is a comma-separated allow-list. Leaving it empty means the node
will take work for any provider, which is rarely what you want — naming `youtube` keeps
your connection out of everything the server can already do for itself.

## Keeping it running and up to date

yt-dlp is the part that goes stale: YouTube changes, and a node with last month's yt-dlp
fails links the server could pass to it. A node should refresh its own copy, to the
version the deployment runs — the one pinned on `main`:

```bash
npm run tools:fetch -- --only=ytdlp --pin-from=main
```

That reads the pin from `main`'s `scripts/tools.manifest.json` on GitHub, downloads that
release, and checks it against yt-dlp's published checksums before it replaces anything.
It does nothing when the installed version (recorded in `.tools/yt-dlp.version`) already
matches, so it is cheap to run often. The checkout itself is not touched.

**On Windows**, `deploy/node-windows/` has what the laptop node runs. Copy the folder out
of the checkout (for example to `%USERPROFILE%\.sera-node`), set `REPO` in
`run-node.cmd`, and run `install-task.ps1` once, elevated. The scheduled task starts the
node at boot, at logon and from a five-minute watchdog, and restarts it 15 seconds after any
exit. Each start refreshes yt-dlp before the node takes work, and a background loop
refreshes it again every 24 hours; the log is `ytdlp-update.log` beside the scripts. The
binary can be replaced while the node runs — the old one is renamed aside, which Windows
allows for an executable in use — and the next job uses the new one.

To pause the refresh, create `ytdlp-updates.paused` next to `run-node.cmd`; delete it to
resume. [ORACLE.md](ORACLE.md#automatic-updates) covers pausing the rest of the chain.

A trimmed download is cut on the node too: the task says which part to keep, and only that
part crosses the node's upload.

Subtitles are fetched on the node as well, from the same network as the video: embedded in
it, or as an `.srt`/`.vtt` file uploaded beside it or on its own.

A node says which of these it understands each time it asks for work, and a trimmed or
subtitled job only goes to a node that said so: one running older code would ignore the
request and send back the whole, plain video. Such a node still takes everything else, so
nothing breaks while it is out of date — but update it (`git pull`, build, restart; on a
phone, run `setup.sh` again) so it can take those jobs too. While no connected node can, a visitor asking for a trim or subtitles from that
source is told so at once, and the full download still works.

## Instagram photo posts and carousels

Instagram shows photos only to a signed-in account, and the server has none. A node can hold
one instead: give it the `sessionid` cookie of an Instagram account and photo posts and
carousels download from it, every slide at the largest size Instagram keeps (measured: up to
3072×4096). Without a node holding one, a photo post gives only the cover image Instagram
publishes for embeds — the first slide, reduced.

The cookie stays on the node. A node with one tells the server only that it holds an
Instagram session, and the server sends it the posts that need one. When several nodes hold
one, whichever is online takes the post, so a laptop that is off leaves it to the phone; and
if the one that takes it fails — out of date, or its session expired — the next one is asked.

**Get the cookie.** In a desktop browser signed in to instagram.com: open the developer tools
(F12), then _Application_ (Chrome, Edge) or _Storage_ (Firefox) → _Cookies_ →
`https://www.instagram.com`, and copy the value of `sessionid`. It is a password in all but
name: anyone holding it is signed in as that account. Signing out of Instagram in that browser
ends it, and the node then says the session no longer works.

**Give it to each node**, in the node's own `.env.node.local` — never in the server's `.env`:

```bash
SERA_INSTAGRAM_SESSION_ID=<the value of sessionid>
```

Then restart the node (on Windows, `restart-task.ps1` as administrator; on a phone, see
[EXTRACTION-NODE-ANDROID.md](EXTRACTION-NODE-ANDROID.md#logs-restarting-stopping)). Its log
says `features: […, "instagram-session"]` when it starts, and the About page stops saying
photo posts need an account.

**What it costs.** Every photo post anyone downloads is read as that account: one request per
post, from your own connection, which is what a person scrolling does. Instagram still
suspends accounts it decides are automated, so a spare account is the safer choice; with your
main one, the risk is your main one.

## What it will and will not be asked to do

The router sends work to a node only when the server's own attempt failed in a way another
network could fix — the datacentre refusal and the bot challenge, and nothing else. A
private video, a deleted post, an unsupported link and a rate limit are the same answer
from every address, so they are never sent. That keeps your connection for the cases that
need it. The one other case is a post that needs an account, which goes only to a node
holding one (above).

## Operating it

| Behaviour       | What happens                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat       | The request for work is held open, so asking _is_ the heartbeat                                                                                       |
| Reconnect       | Exponential backoff to a minute; a restarted server is picked up on its own                                                                           |
| Cancellation    | The node asks on every progress report and stops when the visitor has gone                                                                            |
| Concurrency     | One job at a time                                                                                                                                     |
| Cleanup         | Its copy is deleted once the upload completes, and on failure                                                                                         |
| Stale detection | A node silent for 90 seconds stops being offered work                                                                                                 |
| Lost claims     | A task its node has not reported on for 45 seconds is offered to any live node again, under a new id; anything the silent node sends later is ignored |

`/health` reports which backends exist and whether each is answering.

## What this does not fix

**Instagram photos, on its own.** Those need an account, and that is true from a home
connection as much as from a datacentre — every anonymous endpoint redirects to a login. A
node's address makes no difference; the session it can hold does
([above](#instagram-photo-posts-and-carousels)).

## The cost of running it

Every byte a visitor downloads through the node crosses your home connection twice: once
in, once back out to the server. On a public deployment that is your bandwidth, your ISP's
fair-use policy, and your address making the requests. Point `SERA_NODE_PROVIDERS` at the
narrowest set that solves your problem, and think about who has the URL.
