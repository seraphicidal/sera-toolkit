# Visitor import — manual checks before merge

The automated suite covers the server's half with no network. Two things it cannot reach are
worth doing by hand once: that Instagram's CDN actually serves a full-resolution URL to the
Oracle datacentre (the whole premise — that these URLs are not IP-bound), and that the
opener/postMessage handshake completes in browsers other than the Chromium the COOP finding was
measured in. Neither blocks the code; both confirm the premise holds in the real world.

## (a) The CDN serves Oracle a full-res carousel image and a video

Open a photo **carousel** and a **video/reel** on instagram.com in a browser where you are
logged in. From the network panel (or right-click → Copy image address on the full-res image),
copy one full-resolution image URL (`scontent-*.cdninstagram.com/...`) and one video URL
(`*.fbcdn.net/...mp4`). They are signed and expire (the `oe=` param, a hex epoch), so run these
soon after copying. **On the Oracle host:**

```bash
# 1) Full-res carousel image, fetched from the datacentre.
curl -sS -o /tmp/ig-image.jpg \
  -w 'image: HTTP %{http_code}  %{size_download} bytes  %{content_type}\n' \
  'PASTE_FULL_RES_IMAGE_URL'
head -c3 /tmp/ig-image.jpg | xxd        # expect: ff d8 ff   (JPEG magic)

# 2) Video, from fbcdn.net.
curl -sS -o /tmp/ig-video.mp4 \
  -w 'video: HTTP %{http_code}  %{size_download} bytes  %{content_type}\n' \
  'PASTE_VIDEO_URL'
file /tmp/ig-video.mp4                  # expect: ISO Media, MP4

# 3) The signature covers the expiry: change one hex digit of the oe= value and refetch.
curl -sS -o /dev/null -w 'tampered oe: HTTP %{http_code}\n' 'PASTE_IMAGE_URL_WITH_oe_ALTERED'
```

**Expected:**

- (1) and (2): `HTTP 200`, a non-zero byte count, `content_type` of `image/jpeg` and `video/mp4`
  respectively, and the magic-byte checks pass. This is the premise: a datacentre address gets
  the bytes, so the server can fetch what the visitor's browser was given. No cookie, no auth.
- (3): `HTTP 403`. The `oh=` signature covers `oe=`, so a tampered expiry is refused — which is
  why the import token's lifetime is bounded by `oe` and cannot be extended.
- If (1) or (2) returns `403` on the **untampered** URL, the link expired between copying and
  running — recopy and retry. (That same expiry is what the queued-job freshness check enforces.)

Both hosts (`cdninstagram.com`, `fbcdn.net`) are the only two the import allowlist admits; if a
URL you copied is on some other host, that is worth telling me.

## (b) The handshake completes in Firefox and Safari

Do this against the real HTTPS deployment (or the tunnel), not plain-HTTP `localhost`, so COOP is
evaluated exactly as in production. In each browser, **signed in to instagram.com:**

1. Open SERA's `/import` page and drag **SERA: Import post** to the bookmarks bar.
2. Open a single photo post or carousel on instagram.com (`/p/…`).
3. Click the bookmark.

**Expected in both:** a popup opens to `/import`, briefly shows "Reading the post from your
browser…", then shows the **media picker** for that post (thumbnails + Download), and a download
completes. Then confirm the guardrails:

- On a **profile or the feed** (not a post), clicking the bookmark shows the alert
  "Open a single Instagram post, reel or video first." and opens nothing.
- **Signed out**, it shows "SERA could not read that post. Make sure you are signed in."

**What failure looks like, and what it means:**

- The popup stays on "Reading the post…" or shows the "Send an Instagram post to SERA"
  explainer instead of the picker → the handshake didn't complete: the popup's `window.opener`
  was null. That is the COOP failure the `unsafe-none` rule on `/import` exists to prevent — check
  that response header on `/import` is `cross-origin-opener-policy: unsafe-none` (e.g.
  `curl -sI https://YOUR_DEPLOYMENT/import | grep -i cross-origin-opener`).
- No popup at all → the browser's popup blocker; allow pop-ups for instagram.com and retry.
- Safari specifically: enable the Favorites/bookmarks bar (View → Show Favorites Bar) to drag the
  link, and if a `javascript:` bookmarklet is refused from the bar, that is a Safari policy signal
  worth noting — it is the case most likely to push us toward the extension sooner.

Report back the browser + version for each, and whether the picker appeared. That is the one
result the automated tests can't stand in for.
