# SERA browser import

Instagram serves a public photo post's media only to a signed-in client, from any network.
SERA's server is not signed in and must not be — a shared `SERA_INSTAGRAM_SESSION_ID` would
make every visitor's download the operator's account activity, and Instagram suspends accounts
for exactly that. So the read happens where a session already exists: the visitor's own
browser. This folder is the browser side of that.

It defeats no platform control. The visitor reads only the post they are already logged in to
see, and SERA fetches only the media URLs that read produced — checked, on arrival, against
Instagram's CDN hosts and nothing else. The trust model is written up in
[`deploy/SECURITY-REVIEW.md`](../../deploy/SECURITY-REVIEW.md).

## Two stages

1. **Bookmarklet (now).** A link you drag to your bookmarks bar. No install, no permissions,
   works in every desktop browser. It is delivered from the running SERA deployment, on the
   `/import` page, because it needs that deployment's own origin baked in and drag-to-install
   is a web affordance. The code that ships is built by
   [`apps/web/src/lib/bookmarklet.ts`](../web/src/lib/bookmarklet.ts) (tested in
   `bookmarklet.test.ts`); the readable twin is below, kept in step with it by hand.
2. **Extension (later, not yet built).** An MV3 extension, authored with
   [wxt](https://wxt.dev), that adds a "Send to SERA" button on a post rather than a bookmarklet
   in the bar. Its content script will be scoped to post pages only — `/p/`, `/reel/`,
   `/reels/`, `/tv/` — and it will do exactly what the bookmarklet does: one click, one post,
   one request. No batching, no profile crawling, no background collection. When it is built it
   will live here alongside this file.

## What the bookmarklet does, and all it does

- Runs only on a single post (`/p/`, `/reel/`, `/reels/`, `/tv/`). One run sends one post.
- Decodes the shortcode to Instagram's numeric media id locally, so it makes **exactly one**
  request to Instagram — the media-info call Instagram's own web client makes, with the
  visitor's session cookie the browser already holds.
- **Trims** the response to the widest rendition of each slide and the fields SERA uses, so what
  Instagram returns about the viewer — whether they liked, saved or follow — never leaves the
  tab, and the payload stays small enough to travel in a URL.
- **Transport v2:** it reads the post first, then navigates the **same tab** to
  `/import#v=2&p=<payload>`. There is no `window.open` and no `postMessage` — a popup is blocked
  by iOS Safari's pop-up setting and severed by cross-origin COOP, and neither can be asked of a
  visitor. The fragment never reaches the SERA server (fragments are client-only) and `/import`
  clears it from history the moment it reads it. (`/import` still accepts the old v1 `postMessage`
  handshake for a transition, so bookmarklets installed before v2 keep working.)
- Loads, fetches and evaluates **no code** of any kind — the one network call reads Instagram's
  media endpoint for data, never the SERA origin.

It is inline and self-contained because it has to be: instagram.com's Content-Security-Policy
forbids loading an external script, and a user-invoked bookmarklet is the one thing exempt from
it (Chromium, and Firefox 69+).

## The readable source

The shipping copy is compacted and has the deployment's origin substituted in; this is the same
logic, spelled out. Keep the two in step.

```js
(function () {
  var SERA = 'https://your-sera-deployment.example'; // substituted per deployment

  // One post only. A profile or the feed is not a post, and does nothing.
  var m = location.pathname.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) {
    alert('Open a single Instagram post, reel or video first.');
    return;
  }
  var code = m[1];

  // Shortcode -> numeric media id, locally, so only ONE request goes to Instagram.
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var pk = 0n;
  for (var i = 0; i < code.length; i++) pk = pk * 64n + BigInt(A.indexOf(code[i]));

  // Keep only the widest rendition of each slide, and only the fields SERA uses; cap the caption
  // and alt text (the server truncates titles anyway). Everything about the viewer stays in this
  // tab, and the payload stays small enough to put in a URL.
  function clip(s, n) {
    return typeof s === 'string' ? s.slice(0, n) : undefined;
  }
  function widest(a) {
    return (a || []).slice().sort(function (x, y) {
      return (y.width || 0) - (x.width || 0);
    })[0];
  }
  function pick(c) {
    return c ? { url: c.url, width: c.width, height: c.height } : undefined;
  }
  function keep(n) {
    if (!n || typeof n !== 'object') return undefined;
    var out = {
      id: n.id,
      code: n.code,
      media_type: n.media_type,
      video_duration: n.video_duration,
      accessibility_caption: clip(n.accessibility_caption, 150),
    };
    var img = n.image_versions2 && pick(widest(n.image_versions2.candidates));
    if (img) out.image_versions2 = { candidates: [img] };
    var vid = pick(widest(n.video_versions));
    if (vid) out.video_versions = [vid];
    if (n.carousel_media) out.carousel_media = n.carousel_media.map(keep);
    if (n.user) out.user = { username: n.user.username, full_name: n.user.full_name };
    if (n.caption) out.caption = { text: clip(n.caption.text, 300) };
    return out;
  }

  // Read the post, then navigate THIS tab to /import with the post in the fragment. No popup,
  // no postMessage — nothing a phone's pop-up blocker or cross-origin COOP can break. Every
  // failure alerts a plain reason (status code, Instagram's short message, or error name only —
  // no bodies, URLs or cookies), because a phone has no devtools to inspect.
  fetch('/api/v1/media/' + pk.toString() + '/info/', {
    headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
    credentials: 'include',
  })
    // Read the body as text and parse it ourselves, so a redirect or a non-JSON login page is
    // handled explicitly instead of throwing r.json() into the generic catch.
    .then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try {
          j = JSON.parse(t);
        } catch (e) {}
        return { r: r, j: j };
      });
    })
    .then(function (res) {
      var r = res.r,
        j = res.j;
      var msg = j ? j.message || (j.require_login || j.requires_login ? 'login_required' : '') : '';
      if (msg) msg = String(msg).slice(0, 120);
      var signIn =
        "SERA: you're not signed in to instagram.com in this browser. The Instagram app's login" +
        ' doesn’t count. Sign in on the website, then try again.';
      if (r.redirected || (msg && /login/i.test(msg))) {
        alert(signIn);
        return;
      }
      if (!r.ok) {
        alert(
          'SERA: Instagram answered HTTP ' +
            r.status +
            ' (' +
            (msg || 'not JSON') +
            '). Are you signed in to instagram.com in this browser?',
        );
        return;
      }
      if (!j) {
        alert(signIn);
        return;
      }
      var it = j.items && j.items[0];
      if (!it) {
        alert('SERA: Instagram returned no media for this post.');
        return;
      }
      var payload = { url: 'https://www.instagram.com/p/' + code + '/', node: keep(it) };
      var href = SERA + '/import#v=2&p=' + encodeURIComponent(JSON.stringify(payload));
      // ~36 KB is the measured worst case (20-slide carousel with videos); refuse anything that
      // would build a URL a browser might not carry, rather than navigate to one that fails.
      if (href.length > 60000) {
        alert('SERA: this post is too large to send (' + Math.round(href.length / 1024) + ' KB).');
        return;
      }
      location.href = href;
    })
    .catch(function (e) {
      alert('SERA: network error reading the post (' + ((e && e.name) || 'error') + ').');
    });
})();
```
