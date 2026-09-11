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

- Runs only on a single post (`/p/`, `/reel/`, `/reels/`, `/tv/`). One click sends one post.
- Decodes the shortcode to Instagram's numeric media id locally, so it makes **exactly one**
  request to Instagram — the media-info call Instagram's own web client makes, with the
  visitor's session cookie the browser already holds.
- Opens SERA's `/import` window **synchronously** inside the click, before any `await`, or the
  browser withholds the pop-up.
- **Trims** the response to the fields SERA uses before sending it, so what Instagram returns
  about the viewer — whether they liked, saved or follow — never leaves the tab.
- Sends the result to `/import` over `postMessage`, to SERA's origin only.

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

  // Opened synchronously, inside the click, or the pop-up is blocked.
  var win = window.open(SERA + '/import', 'sera-import');
  if (!win) {
    alert('Allow pop-ups for instagram.com, then try again.');
    return;
  }

  // Shortcode -> numeric media id, locally, so only ONE request goes to Instagram.
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var pk = 0n;
  for (var i = 0; i < code.length; i++) pk = pk * 64n + BigInt(A.indexOf(code[i]));

  // Keep only what SERA uses. Everything about the viewer stays in this tab.
  function keep(n) {
    if (!n || typeof n !== 'object') return undefined;
    var cand = function (c) {
      return (c || []).map(function (x) {
        return { url: x.url, width: x.width, height: x.height };
      });
    };
    var out = {
      id: n.id,
      code: n.code,
      media_type: n.media_type,
      video_duration: n.video_duration,
      accessibility_caption: n.accessibility_caption,
    };
    if (n.image_versions2 && n.image_versions2.candidates)
      out.image_versions2 = { candidates: cand(n.image_versions2.candidates) };
    if (n.video_versions) out.video_versions = cand(n.video_versions);
    if (n.carousel_media) out.carousel_media = n.carousel_media.map(keep);
    if (n.user) out.user = { username: n.user.username, full_name: n.user.full_name };
    if (n.caption) out.caption = { text: n.caption.text };
    return out;
  }

  var post,
    ready = false,
    sent = false;
  function send() {
    if (post && ready && !sent) {
      sent = true;
      win.postMessage(
        {
          type: 'sera-import-payload',
          url: 'https://www.instagram.com/p/' + code + '/',
          node: post,
        },
        SERA,
      );
    }
  }

  // The /import page announces itself when it is listening; then, and only then, send.
  addEventListener('message', function (e) {
    if (e.source === win && e.origin === SERA && e.data && e.data.type === 'sera-import-ready') {
      ready = true;
      send();
    }
  });

  fetch('/api/v1/media/' + pk.toString() + '/info/', {
    headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
    credentials: 'include',
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      var it = j && j.items && j.items[0];
      if (!it) {
        alert('SERA could not read that post. Make sure you are signed in to Instagram.');
        win.close();
        return;
      }
      post = keep(it);
      send();
    })
    .catch(function () {
      alert('SERA could not read that post. Make sure you are signed in to Instagram.');
      win.close();
    });
})();
```
