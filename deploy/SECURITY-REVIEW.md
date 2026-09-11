# Security review — the extraction-node branch

Reviewed 8 September 2026, against the `extraction-backends` branch, before any of it
reaches the public deployment. The branch adds three things with a security surface: an
authenticated channel that hands work to a machine on another network, an optional
Instagram session belonging to the operator, and a Reddit application registration. Each
one is a way for something outside SERA to influence what SERA fetches, which is the only
class of change worth reviewing this carefully.

What follows is what was actually checked, what it found, and what remains true and
accepted. Every "verified" below has a test or a measurement behind it; where there is
neither, it says so.

---

## The question that matters most

**Can SERA be made to fetch an address it was not meant to fetch?**

A service that fetches URLs on a visitor's behalf is an SSRF engine unless it is built not
to be, and an extraction node makes that worse in a specific way: it moves the fetching
onto someone's home connection, where a mistake reaches a network that is not the
operator's datacentre.

| Reached through                                 | What stops it                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A link a visitor pastes                         | `parseUserUrl`: http/https only, no embedded credentials, no unusual port, and any IP literal checked against `isPublicAddress` before anything connects |
| A hostname that resolves privately              | `guardedLookup` filters inside the DNS lookup the socket actually uses, so a second answer cannot differ from the first                                  |
| A redirect to a private address                 | Same lookup, on every hop — the guard is on the connection, not on the URL                                                                               |
| An address given to a node by the control plane | The node runs `parseUserUrl` itself, and requires the provider named in the task to be the one that claims the host                                      |
| A provider the node did not agree to            | The node checks its own `SERA_NODE_PROVIDERS`, in addition to the server enforcing it                                                                    |

The node's own copy of those checks is the finding this review is proudest of. Before it,
every check lived on the far side of the connection, and the argument for the node being
safe was "the control plane validated it". That is not an argument: one bug in a validator
over there, or one compromised deployment, and a home connection becomes a fetcher for
arbitrary addresses. It matters more than it looks because **yt-dlp is a subprocess making
its own connections** — the guarded dispatcher does not cover it, so nothing else on that
machine would have stopped it.

Verified against the shipped node binary, dispatched straight into the registry so the
control plane's validation is bypassed on purpose:
`http://127.0.0.1:1/` → `BLOCKED_ADDRESS`; `https://example.com/watch?v=x` presented as a
YouTube task → `UNSUPPORTED_SOURCE`.

**Not covered, and worth stating plainly:** once a URL passes the gate and goes to
`yt-dlp`, that process makes its own DNS and its own connections. A platform that redirects
its own extractor to a private address would not be stopped by SERA. This is the same
exposure the deployment has always had, it is bounded by the host allowlist (a link never
reaches yt-dlp merely because yt-dlp might recognise it), and closing it properly means
running the extractor in its own network namespace.

---

## The item-by-item pass

### Addresses and names

- **Private IPv4, IPv6, loopback, link-local, metadata endpoints** — `isPublicAddress`
  refuses loopback, `0.0.0.0`, RFC1918, `169.254.0.0/16` (which is where the cloud
  metadata endpoint lives), carrier-grade NAT, benchmarking, multicast, broadcast, and
  the IPv6 equivalents. Tested including the classic bypass: `::ffff:127.0.0.1` and the
  hex spelling of a mapped address.
- **DNS rebinding** — the filter is inside `guardedLookup`, which is the lookup the
  socket uses. There is no window between "we checked" and "we connected" for a second
  answer to slip through.
- **Redirects** — followed one hop at a time in `safeOpen` rather than by the transport,
  so each intermediate URL is re-checked against the scheme rules, each hop connects
  through the same guarded lookup, and the hop budget is SERA's rather than undici's.
- **`file://` and other protocols** — `ALLOWED_PROTOCOLS` is http and https. A scheme
  outside it is rejected before a `URL` is handed anywhere.

### Files

- **ZIP path traversal** — entry names are refused, not escaped: `../escape.mp4`,
  `..\escape.mp4`, `/etc/passwd`, `a/b.mp4` and `..` all throw.
- **Malicious filenames** — `sanitizeStem` strips separators, drive letters, control
  characters and bidirectional overrides rather than escaping them, rejects the reserved
  Windows names, and falls back to `media`. The same function names an uploaded file
  arriving from a node: a node is trusted to extract, not to choose where bytes land.
- **Malicious MIME types** — the download route takes its content-type from
  `mimeTypeFor(filename)`, derived from the sanitized extension, never from anything a
  node or a source sends. Served with `nosniff` and a `content-disposition`.
- **Archive extraction** — SERA writes archives and never reads one, so the decompression
  bomb has no way in through that door.

### Size and time

- **Oversized media** — the input is capped at `SERA_MAX_FILESIZE_BYTES` through yt-dlp's
  `--max-filesize` and through the direct downloader's own counter; duration at
  `SERA_MAX_DURATION_SECONDS`; item count, job time, queue depth, per-client concurrency
  and request rate all have ceilings.
- **Expansion during conversion** — _found and fixed in this review._ Neither of those
  bounds the output, and a re-encode can be larger than what it was given. FFmpeg now
  gets `-fs` at the same ceiling and `validate` reports the truncated result as
  `TOO_LARGE` rather than as a confusing conversion failure. Measured: four seconds of
  colour bars is 626,876 bytes as a GIF, and 46,372 with a 32 KB ceiling.
- **Oversized uploads from a node** — _found and fixed in this review._ The limit was
  checked with `stat` once the whole file was on disk, which spends the disk before
  deciding it should not have. Fastify's own `bodyLimit` does not apply, because these
  uploads are handed through as a raw stream precisely so a large file is never buffered.
  A counting transform now fails at the first byte past the limit: measured over a real
  socket, 413 in 7 ms.
- **Abandoned uploads** — _found and fixed in this review._ They shared one `remote/`
  parent, and the reaper deletes top-level directories by age — but a directory's mtime
  is refreshed by every new child, so one busy node kept the parent young forever and the
  orphans under it never aged out. Each task now gets its own top-level directory, reaped
  exactly like a job workspace.

### Subprocesses

- **No shell, ever.** `spawn` with `shell: false` and an argument array; yt-dlp gets
  `--ignore-config` so a stray config file cannot introduce `--exec`; URLs are positional
  after a bare `--`.
- **FFmpeg inputs** are paths SERA wrote into a workspace it created — never a string a
  visitor or a source supplied, so the protocol tricks that make FFmpeg an SSRF vector
  (`concat:`, `http:`, `subfile:`) have no way in.

### The node channel

- **Authentication** — a shared secret, compared with `timingSafeEqual` after a length
  check, on every route. Wrong or missing gets a 401 whose body is `NOT_FOUND` and
  nothing else. With no token configured the routes are not mounted at all, so a
  deployment with no node has no endpoint that accepts one.
- **Authorization** — the token is the whole authorization; there is one principal.
  A node can only ever do work the control plane queued, and only for the providers it
  declared.
- **Replayed jobs** — a task id is a random UUID with its dashes stripped. An upload for a task that is
  not pending, or has been cancelled, is refused before a byte is written. Once a job
  settles, its pending entry is gone and a replayed upload is refused the same way.
- **Abuse of a node as a proxy** — the node **listens on nothing**. It opens a connection
  outward, asks for work, and does what it is given. There is no port to forward and
  nothing routable pointed at it, which is what makes the property structural rather than
  a matter of configuration. On top of that, the capability matrix refuses to route the
  three providers whose URL is unconstrained — `generic`, `direct` and `mastodon` — to a
  node at all, so a bot challenge on an arbitrary host cannot turn into a request from
  someone's house.

### Credentials

- **Token leakage** — the node token is read from the environment, sent as a bearer header
  to one configured URL, and never logged, never returned by an endpoint, and never
  written into a job record.
- **Instagram session** — off by default. Sent as a cookie header to `instagram.com`
  only, never placed in a URL, never returned through the API, never included in an error
  message. `deploy/ORACLE.md` states the three things an operator should know before
  setting one on a deployment other people can reach: every visitor's request is then made
  as that account, Instagram suspends accounts for automated access, and anyone who can
  read `/opt/sera/.env` can act as that account until it is logged out.
- **Reddit** — a client-credentials grant against an application the operator registers.
  No user's account, no user's password. The token is held in memory, refreshed before
  expiry, and never logged.
- **Log leakage** — `REDACTED_PATHS` covers cookies, session ids, OAuth client secrets,
  access tokens, authorization headers, signed media URLs and full source URLs; a test
  writes every one of them to a real logger and asserts none survives to the output. URLs
  are logged through `logSafeUrl`, which keeps the site and the shape and drops what
  identifies the post — `youtube.com/watch`, never the video id.

---

## What did not change, and stays true

SERA processes only what a provider can legitimately reach. It does not defeat DRM, sign
in as a visitor, bypass a paywall, or reach content behind an access control. It honours
`robots.txt` on the page-reading path, which is why Pinterest photo pins and one form of
Tumblr URL are refused — those sites ask not to be read, and declining is the behaviour
rather than a gap in it.

## Accepted risk

- **yt-dlp's own connections are not address-guarded** (see above). Bounded by the host
  allowlist; properly closed only by a network namespace.
- **A node's operator sees what passes through it.** Every byte a visitor downloads
  through a node crosses that connection twice, from that address. This is inherent to
  what a node is, and is stated in `deploy/EXTRACTION-NODE.md` so nobody runs one without
  knowing it.
- **One shared token for all nodes.** Rotating it means restarting the nodes. Per-node
  credentials would be better and are not worth the complexity at one or two nodes; the
  door this leaves open is a stolen token letting an attacker _receive_ work, which
  reveals which links visitors submitted to a deployment they already had a credential
  for.

---

# Security review — visitor import

Reviewed 11 September 2026, against the `instagram-visitor-import` branch, before it reaches
the public deployment. The branch adds one thing with a security surface: an endpoint that
accepts a description of an Instagram post from the visitor's own browser and turns it into a
download. It is deliberately the answer to the one thing this deployment cannot otherwise do —
Instagram photographs, which Instagram serves only to a signed-in client — **without** putting
an Instagram session on the server. The whole design question is therefore: what can a browser,
or something pretending to be one, make this endpoint do?

## Why the browser at all

Instagram serves a public photo post's media only to a logged-in client, from any network —
measured repeatedly, from a home connection as much as from the datacentre (see
`deploy/PROVIDERS.md`). The only two ways past that are to give the server an account, or to
use the account the visitor already has. The first was measured and rejected on the deployment:
a single `SERA_INSTAGRAM_SESSION_ID` makes every visitor's download the operator's account
activity, and Instagram suspends accounts for exactly that. The second is this branch. The
visitor's browser, already signed in, reads the one post it is showing — a same-origin read on
`instagram.com`, nothing SERA is party to — and hands SERA the media descriptor. SERA holds no
session, sees no cookie, and makes no request to read the post.

**This defeats no platform control, and that was the line the whole design was held to.** The
visitor reaches only what they were already logged in to reach; SERA fetches only the CDN
objects that read produced. There is no paywall crossed, no private post opened, no account
impersonated, no rate limit dodged on Instagram's behalf. The post's own URL, pasted on the
home page, still leads to "this needs an account" — because from the server it genuinely does.

## Why postMessage, not CORS

The obvious shape — SERA's page calls Instagram's API with the visitor's credentials — cannot
exist. `instagram.com` does not send SERA's origin an `Access-Control-Allow-Origin`, so a
cross-origin `fetch` with credentials is unreadable by construction, and it would also mean SERA
scripting the visitor's Instagram session, which is the thing being avoided. So the read happens
where the session lives — a content script on `instagram.com` — and only the result crosses to
SERA, over `postMessage`, which is not subject to CORS and carries no ambient credentials.

## The question that matters most

**Can a payload make SERA fetch an address it was not meant to fetch?**

The payload is attacker-controlled: it arrives from a browser SERA cannot see into, and a hostile
sender can put anything in it. The design assumes that from the start. Nothing in the payload is
believed except after it clears the media-host allowlist, and only what clears it is ever
fetched.

| Reached through                                 | What stops it                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A media URL in the payload                      | `assertCdnHosts` / `isAllowedMediaUrl`: HTTPS only, no port, no credentials, host is `cdninstagram.com` or `fbcdn.net` or a subdomain — nothing else |
| A thumbnail URL in the payload                  | The same check, over the thumbnails too, because the thumbnail proxy fetches those                                                                   |
| A redirect off the CDN at download time         | `downloadDirect` is given an `allowUrl` that re-applies the same host check on **every hop**, the first included — a redirect is a new destination   |
| The post URL itself                             | `parseUserUrl` (http/https, no credentials, no odd port, no private IP literal), then the provider must be Instagram and declare `browserImport`     |
| A private or internal address behind a CDN name | The SSRF address guard (`guardedLookup`) is unchanged and still filters inside the socket's own DNS lookup, on every hop                             |
| A URL edited into the signed token after issue  | The token is HMAC-signed; editing `m` breaks the signature, and the resolution hash digests `m` so an option from one import will not match another  |

**The worst a forged payload achieves:** SERA fetches an object on Instagram's own CDN that the
sender must already hold a signed link to — the CDN URLs are signed and expire, so the sender
had to have obtained them, and fetching one gains them nothing they did not already have. It
gives no reach onto SERA's network (the address guard is untouched), no reach onto an arbitrary
host (the allowlist is two registrable domains), and no amplification worth the name (one fetch,
bounded by the same size and item ceilings as any job). This is why the allowlist is a code
constant and not an environment variable: widening it changes what the server will fetch for
anyone who asks, so it takes a commit and a review, not a config line.

## Approved means signed

"Approved" has a precise meaning here: the media the resolver admitted, and only that, is signed
into the resolution token — the same self-contained HMAC token every resolution already uses,
now carrying the imported entries (`o: 'visitor'`, `m: [...]`). A job made from an imported post
does **not** re-resolve — it cannot; there is no session to re-read the post with — so the runner
rebuilds the plan deterministically from the signed entries (`mediaFromImport`, a pure function)
and fetches exactly those. Three consequences were checked:

- **No cross-import spending.** The resolution hash digests `m`, so an option minted for one
  import of a post does not match a second import of the same post carrying different media.
  Tested end to end: import A's option against import B's token is refused with "different link".
- **No re-resolution.** The end-to-end suite wires the probe to throw, so any attempt to
  re-resolve an imported job fails the test rather than the payload.
- **Expiry is bound, and checked before fetching.** The token's lifetime is `min` of the option
  TTL and the earliest `oe` Instagram signed into the URLs; a job that waits in the queue past
  that is refused before a byte is fetched (`assertImportFresh`), and a URL the CDN refuses with
  a 403 at download time is reported as expired, not as a network fault. The signature covers
  `oe`, so the expiry cannot be extended by editing the URL.

## The COOP exception

The handshake needs the popup SERA opens to keep its `window.opener`, and SERA's site-wide
`Cross-Origin-Opener-Policy: same-origin` severs it: opening a cross-origin popup switches
browsing-context groups and the opener comes up `null`. Measured in a real browser across all
three policies — `same-origin` and `same-origin-allow-popups` both sever it; only `unsafe-none`
keeps it. So `/import` alone is served `unsafe-none`, as a later, narrower `headers()` rule that
overrides that one key and leaves every other security header in place. The exposure `unsafe-none`
reintroduces is that another page in the same browsing-context group could reach this window's
global — and it is acceptable here precisely because `/import` holds nothing worth reaching: no
credential, no state, no stored anything, and it is `noindex`. It reads a post, builds a request,
and forgets it.

## Abuse and limits

- **Off-allowlist media counts as abuse.** A payload naming media anywhere but Instagram's CDN is
  refused `BLOCKED_ADDRESS` and recorded against the client's failure budget — nothing Instagram
  serves produces that, so it is someone probing what the endpoint will fetch. Tested: repeated
  forged posts trip the cooldown, and the cooldown is per-client, so it neither leaks across
  clients nor blocks a genuine sender elsewhere.
- **The body is capped at 512 KB**, on the route, so an oversized payload is refused (413) before
  it is parsed. The item ceiling (`maxItemsPerJob`) and the schema's own 50-slide cap both apply,
  the resolver refuses a post over either, and the mint refuses a resolution token that would
  exceed `MAX_INFO_TOKEN_LENGTH` — so the limit is enforced where the token is made, never
  discovered when someone presses Download.
- **Rate limited** exactly as `/api/media/info` is.

## Log leakage

The imported entries carry signed CDN URLs, which work for anyone holding them until they expire,
so they are treated like credentials: `imported` and `*.imported` are on `REDACTED_PATHS`, and
the post is logged only through `logSafeUrl` (`www.instagram.com/p`, never the shortcode). A test
writes an import — success and refusal — and asserts no path, signature, shortcode or off-host
name survives to the log.

## Found in passing, and fixed

`downloadDirect` destroyed the response body with a raw `.destroy()` on a 4xx or oversized
response. undici raises an `AbortError` from `destroy()` that surfaces as an unhandled rejection
unless a listener is already attached — which the `discard()` helper exists to do. Nothing had
driven a 4xx into that path before; an imported post whose signed URL has expired is the ordinary
way to reach it (the CDN answers 403), so the import tests surfaced it. Both spots now use
`discard()`.

## What did not change, and stays true

The SSRF address guard, the signed-token model, the subprocess rules, the filename and ZIP
handling — none of it is touched. The imported path fetches through the same guarded dispatcher
as every other direct download, with a host allowlist layered on top of the address guard rather
than in place of it.

## Accepted risk

- **The shortcode consistency check is not a security boundary, and is not treated as one.** The
  sender controls both the URL and the post, so it cannot prove they match; it catches an honest
  race — the page moving to another post between reading one and sending it — and the security
  properties rest entirely on the media-host allowlist and the signature, neither of which trusts
  the shortcode.
- **A signed CDN URL is bearer-ish until it expires.** Anyone who obtains one can fetch it, from
  anywhere, until `oe` passes — this is Instagram's design, not SERA's, and it is why the URLs are
  kept out of logs and why the token's lifetime is bounded by theirs. SERA neither widens that
  window nor narrows it.

---

# Addendum — the fragment transport (v2)

Reviewed 12 September 2026. This was built **pre-emptively**, not in response to a test result:
the popup transport is known to be fragile on phones — a browser's pop-up blocker can refuse
`window.open`, and a backgrounded or cross-origin popup can lose the opener a `postMessage` needs
— and we cannot ask a visitor to change a pop-up setting. **Real-device testing is still pending**
(iPhone Safari, Android Chrome); what those show may change the instructions, but the transport
below is the mobile-safe design regardless. This notes what it changes for the trust model, which
is small, and one thing it genuinely adds.

**What changed.** Instead of opening `/import` as a popup and posting the post to it, the
bookmarklet reads the post on instagram.com and navigates the **same tab** to
`/import#v=2&p=<encodeURIComponent(JSON.stringify({url,node}))>`. No `window.open`, no
`postMessage`, no opener. The `/import` page still accepts the old v1 `postMessage` handshake for
a transition, so bookmarklets installed before this keep working; `unsafe-none` stays on `/import`
for that reason, and v2 needs neither the opener nor that header.

**What did not change.** The payload is exactly what it was and is trusted exactly as little:
the server runs `importRequestSchema`, `assertCdnHosts` and the shortcode check, admits only
Instagram's CDN hosts, and signs only what it admitted. A hostile fragment can do no more than a
hostile postMessage could — at most, have SERA fetch a CDN object the sender already held a signed
link to.

**What the fragment genuinely adds: a crafted link, and how it is contained.** Under v1 only an
instagram.com opener could hand a post over; with v2 anyone can send someone a `/import#v=2&p=…`
link. Two consequences, both handled on the client so a recipient is never harmed by opening one:

- **No download without a tap.** A crafted link only ever _resolves_ to the picker; a job starts
  only from the Download button's click. Confirmed: the downloader's `start()` is called from the
  button (and a retry action), never from an effect.
- **The recipient's address is not spent on a crafted link.** The server counts a
  `BLOCKED_ADDRESS` (off-allowlist media) toward abuse, keyed on the requester's address. A crafted
  fragment with off-allowlist URLs would otherwise make the _recipient's_ browser POST them and
  collect the strikes. So `readImportFragment` mirrors the server's host allowlist on the client —
  HTTPS, no port, no credentials, host on `cdninstagram.com` / `fbcdn.net`, over every media and
  thumbnail URL in the node — and if any URL fails, it returns "refused" and **POSTs nothing**. The
  server check stays authoritative for a direct POST. Both are tested.
- **Provenance is shown.** `/import` prints "From instagram.com/p/&lt;code&gt;", from the payload's
  own `url`, above the picker, so a recipient sees which post they are about to download. Caption
  and author render as plain React text (escaped); no `dangerouslySetInnerHTML` touches them.

**What the fragment adds to the URL, and how it is contained.**

- **The fragment never reaches the SERA server.** A URL fragment is not sent in an HTTP request at
  all — it is not in the request line and, by the URL spec, is never placed in a `Referer` header
  regardless of referrer policy — so the signed CDN URLs in it arrive at the server only through
  the same `POST /api/media/import` body as before, never in a GET URL and never in a server log.
- **It does not linger in this tab.** `readImportFragment` calls `history.replaceState` to drop the
  fragment from the current session-history entry the instant it reads it — whether or not it
  parsed. That covers the address bar and this tab's back-stack; a browser's _global_ history or a
  synced-tabs feature may still record the original URL. Low impact: the signed links inside expire
  within hours. Tested (the reader clears the hash on every path).
- **Bounded in size, measured not guessed.** With one widest rendition per slide and the caption
  trimmed to 300 chars and each alt-text to 150 (the server truncates titles to 200/120 anyway, so
  nothing shown is lost), the final `/import#…` URL measures — using the real Gate 1 CDN URLs as
  templates — about **1.3 KB for a 1-slide post, 12 KB for 10 images, 24 KB for 20 images, and 36
  KB for a 20-slide carousel with ten videos** (the realistic worst case). The bookmarklet refuses
  to navigate to a URL over **60 KB** (`alert`, no navigation), and `readImportFragment` refuses a
  hash over **64 KB** before it decodes or parses anything (still clearing it). Both sit above the
  measured worst case and below where a browser gives up.
- **Still inert.** The bookmarklet loads, fetches and evaluates no code; its one network call reads
  Instagram's media endpoint for data, never the SERA origin. Asserted in `bookmarklet.test.ts`.
