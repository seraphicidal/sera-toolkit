# What each provider actually does

Measured on 8 September 2026 from a residential connection, with yt-dlp 2026.08.19 and
gallery-dl 1.32.11. Everything below is something that was run, not something that was
assumed — `npm run check:providers -- --download` re-runs most of it.

Read the columns as: **Primary** is the first rung of the ladder. **Also tried** is what
runs when the first rung fails in a way that rung answers. **IP-bound** says whether the
media URL is signed to the address that requested it, which decides whether an extraction
node has to do the whole job or only the resolve.

| Provider           | Primary        | Also tried                        | Official API       | Datacentre vs home       | IP-bound URL | Definitively unsupported when           |
| ------------------ | -------------- | --------------------------------- | ------------------ | ------------------------ | ------------ | --------------------------------------- |
| **YouTube**        | yt-dlp         | yt-dlp as `web_safari`, `android` | no (public data)   | **differs** — see below  | **yes**      | private, deleted, age-gated             |
| **YouTube Shorts** | same as above  | same                              | —                  | same                     | **yes**      | same                                    |
| **Instagram**      | yt-dlp         | operator session → oEmbed cover   | no useful one      | same (both refused)      | no           | private account, deleted post           |
| **X / Twitter**    | syndication    | yt-dlp                            | paid, not used     | same                     | no           | post deleted or has no media            |
| **Reddit**         | OAuth API      | —                                 | **yes, used**      | **differs** — see below  | no           | removed, quarantined, private subreddit |
| **TikTok**         | yt-dlp         | —                                 | no                 | same                     | no           | private, deleted                        |
| **Vimeo**          | yt-dlp (embed) | —                                 | yes, unused        | same                     | no           | private, password-protected             |
| **Twitch**         | yt-dlp         | —                                 | yes, unused        | same                     | no           | live in progress, VOD expired           |
| **SoundCloud**     | yt-dlp         | —                                 | closed to new apps | same                     | no           | private, geo-blocked                    |
| **Bandcamp**       | yt-dlp         | —                                 | no                 | same                     | no           | stream-only release removed             |
| **Facebook**       | yt-dlp         | —                                 | own content only   | same (both need a login) | no           | anything not fully public               |
| **Pinterest**      | yt-dlp (video) | —                                 | own boards only    | same                     | no           | photo pins — see below                  |
| **Tumblr**         | yt-dlp (video) | —                                 | yes, needs a key   | same                     | no           | photosets — see below                   |
| **Threads**        | yt-dlp         | —                                 | own content only   | untested                 | no           | untested                                |
| **Snapchat**       | yt-dlp         | —                                 | no                 | untested                 | no           | anything not Spotlight                  |
| **Bluesky**        | yt-dlp         | AT Protocol, for photographs      | **yes, open**      | same                     | no           | post deleted, account deactivated       |
| **Mastodon**       | instance API   | yt-dlp, then the API again        | **yes, open**      | same                     | no           | post deleted, instance gone             |
| **Dailymotion**    | yt-dlp         | —                                 | yes, unused        | same                     | no           | private, geo-blocked                    |
| **Direct file**    | HTTP           | —                                 | —                  | same                     | no           | 404, or not media                       |
| **Web page**       | page reader    | —                                 | —                  | same                     | no           | robots.txt disallows, no declared media |

## The three that differ from the rest

**YouTube is the reason the extraction node exists.** From a datacentre the player request
answers _"Sign in to confirm you're not a bot"_ on every player client yt-dlp offers; from
a residential address the default client returns 53 formats up to 2160p. And its media
URLs are signed to the address that asked: the same `googlevideo` URL answers 206 at home
and 403 from the server minutes later. So a node that resolves a YouTube link downloads
it, converts it, and uploads the finished file — a split resolve-here/download-there does
not compose. The PO Token Provider loads and is offered to the extractor and YouTube still
answers on the _player_ request, before streaming: PO tokens address stream 403s, not
address reputation.

**Reddit refuses anonymous requests from hosted address ranges** — both the page and its
`.json` endpoint — which is its documented position for servers. The fix is an application
registration, not a different network: `SERA_REDDIT_CLIENT_ID` / `_SECRET`, a
client-credentials grant against an app the operator owns. No user's account is involved.
Without it, Reddit says it needs credentials and refuses politely; that is correct
behaviour rather than a gap.

**Instagram serves photographs to logged-in clients only, from any network.** Measured
against a real public post from a home connection: the page is a shell, `?__a=1` is a 404,
`/api/v1/media/…/info/` redirects to a login, GraphQL answers `require_login`. An
extraction node changes nothing. What still answers anonymously is oEmbed — the endpoint
Instagram publishes for anyone embedding a post — which returns the caption, the account
and a signed 640px cover image. SERA offers that, labelled "Cover image" and marked
degraded, only after every backend has refused. A carousel's cover is its first slide, so
the full post still needs `SERA_INSTAGRAM_SESSION_ID`; read the warning in
[ORACLE.md](ORACLE.md) before setting one on a deployment other people can reach.

## Is gallery-dl useful here?

It was installed and run against exactly the links SERA cannot fully serve.

| Link                 | gallery-dl 1.32.11            | Verdict                       |
| -------------------- | ----------------------------- | ----------------------------- |
| Instagram photo post | `HTTP redirect to login page` | No gain — same wall SERA hits |
| X photo post         | finds the image               | No gain — SERA already does   |
| Tumblr photoset      | `Aborting - Rate limit`       | No gain — needs an API key    |
| Pinterest photo pin  | finds the image               | Gain, but see below           |

So gallery-dl would add one thing: Pinterest photo pins. Pinterest's `robots.txt` is
`User-agent: * / Disallow: /`, and SERA honours robots.txt on its page-reading path — the
refusal a visitor sees for a Pinterest photo is SERA respecting what Pinterest asked for,
not a bug. Shipping a second Python runtime into an arm64 container to override that is
not a trade this made. If the operator decides robots.txt should not govern a
single link a person explicitly asked for, that is a policy change to make deliberately,
in the open, and this is the paragraph to change when it happens.

## What is not tested here

**Threads, Facebook and Snapchat.** No public post URL for any of them could be obtained
in this session: their listing pages render entirely in the browser and carry no
permalinks in the HTML, and search returned nothing current. Their providers are wired and
their URL handling is unit-tested; whether the extractor still reads them today is
**unverified**, and they are not claimed as working.

**Reddit end to end** needs credentials this development machine does not have. It is
verified on the deployment that has them.
