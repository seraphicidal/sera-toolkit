# Visitor import — manual checks before merge

The automated suite covers the server's half with no network. Two things it cannot reach are
worth doing by hand once: that Instagram's CDN actually serves a full-resolution URL to the
Oracle datacentre (the whole premise — that these URLs are not IP-bound), and that the
bookmarklet's hand-off to `/import` completes in real browsers, phones included. Neither blocks
the code; both confirm the premise holds in the real world.

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

## (b) The hand-off completes in Firefox, Safari and on a phone

The bookmarklet (transport v2) reads the post on instagram.com first, then navigates **the same
tab** to `/import#v=2&p=<payload>`. There is no popup and no `postMessage`, so neither a pop-up
blocker nor the cross-origin opener policy is involved; what is worth checking by hand is that
each browser runs the bookmarklet and follows the navigation. Do this against the real HTTPS
deployment (or the tunnel), not plain-HTTP `localhost`. In each browser, **signed in to
instagram.com on the website** (the app's login does not count):

1. Open SERA's `/import` page and install **SERA: Import post** — drag it to the bookmarks bar
   on a computer, or use **Copy code** and save it as a bookmark's address on a phone.
2. Open a single photo post or carousel on instagram.com (`/p/…`).
3. Run the bookmark.

**Expected everywhere:** the same tab moves to `/import`, briefly shows "Reading the post from
your browser…", then shows the **media picker** for that post (thumbnails + Download), and a
download completes. The fragment is gone from the address bar once the page has read it. Then
confirm the guardrails:

- On a **profile or the feed** (not a post), the bookmark alerts "Open a single Instagram post,
  reel or video first." and does nothing else.
- **Signed out**, it alerts that you are not signed in to instagram.com in this browser.
- Each alert names a reason (an HTTP status, Instagram's short message, a size in KB) and never a
  URL, a cookie or a response body.

**What failure looks like, and what it means:**

- Nothing happens when the bookmark runs → the browser refused the `javascript:` bookmark. In
  Safari, enable the Favorites bar (View → Show Favorites Bar) to drag the link; on iOS, edit a
  saved bookmark's address and paste the copied code in. A browser that refuses `javascript:`
  bookmarks outright is the case most likely to push us toward the extension sooner.
- `/import` opens but shows the "Send an Instagram post to SERA" explainer instead of the picker →
  the fragment did not arrive or was refused (too large, wrong version, or media off the
  Instagram CDN). The page clears it either way; the browser console says which.
- An alert that the post is too large to send → a post over 60 KB once encoded, far beyond the
  measured worst case (about 36 KB for a 20-slide carousel); worth telling me which post.

Report back the browser + version for each (including one phone), and whether the picker
appeared. That is the one result the automated tests can't stand in for.
