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
