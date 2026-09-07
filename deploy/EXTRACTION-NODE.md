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
SERA_NODE_ID=home \
SERA_NODE_PROVIDERS=youtube \
node apps/extractor/dist/index.js
```

It needs `yt-dlp` and `ffmpeg`; `npm run tools:fetch` puts pinned copies in `.tools/`.

`SERA_NODE_PROVIDERS` is a comma-separated allow-list. Leaving it empty means the node
will take work for any provider, which is rarely what you want — naming `youtube` keeps
your connection out of everything the server can already do for itself.

## What it will and will not be asked to do

The router sends work to a node only when the server's own attempt failed in a way another
network could fix — the datacentre refusal and the bot challenge, and nothing else. A
private video, a deleted post, an unsupported link and a rate limit are the same answer
from every address, so they are never sent. That keeps your connection for the cases that
need it.

## Operating it

| Behaviour       | What happens                                                                |
| --------------- | --------------------------------------------------------------------------- |
| Heartbeat       | The request for work is held open, so asking _is_ the heartbeat             |
| Reconnect       | Exponential backoff to a minute; a restarted server is picked up on its own |
| Cancellation    | The node asks on every progress report and stops when the visitor has gone  |
| Concurrency     | One job at a time                                                           |
| Cleanup         | Its copy is deleted once the upload completes, and on failure               |
| Stale detection | A node silent for 90 seconds stops being offered work                       |

`/health` reports which backends exist and whether each is answering.

## What this does not fix

**Instagram photos.** Those need an account, and that is true from a home connection as
much as from a datacentre — every anonymous endpoint redirects to a login. A node makes no
difference. See `SERA_INSTAGRAM_SESSION_ID` in the Oracle guide, and read the warning
there before setting it.

## The cost of running it

Every byte a visitor downloads through the node crosses your home connection twice: once
in, once back out to the server. On a public deployment that is your bandwidth, your ISP's
fair-use policy, and your address making the requests. Point `SERA_NODE_PROVIDERS` at the
narrowest set that solves your problem, and think about who has the URL.
