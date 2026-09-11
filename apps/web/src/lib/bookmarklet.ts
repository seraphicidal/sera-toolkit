import { FRAGMENT_VERSION } from './import-handshake';

/** Instagram's public web-client app id. Its own site sends this on every media-info call. */
const APP_ID = '936619743392459';

/**
 * The bookmarklet that sends the post you're looking at to SERA.
 *
 * It runs on instagram.com, in the tab where you are signed in, so it can read the one post
 * that page is showing the way Instagram's own client does — and it sends SERA only the media,
 * never your session. Delivered as a link you drag to your bookmarks bar on a computer, or
 * copy into a bookmark on a phone. The readable twin is `apps/extension/README.md`; keep them
 * in step, and the next stage is a real extension (see that folder).
 *
 * Transport v2: it reads the post *first*, then navigates the same tab to
 * `/import#v=2&p=<payload>`. There is no `window.open` and no `postMessage`, which is the whole
 * point — a popup is blocked by iOS Safari's pop-up setting and severed by cross-origin COOP,
 * and neither can be asked of a visitor. A same-tab navigation after the fetch has none of that
 * fragility. (The /import page still accepts the old v1 postMessage handshake for a transition.)
 *
 * What it does, and deliberately all it does:
 *   - only on a single post — `/p/`, `/reel/`, `/reels/`, `/tv/`; one run, one post.
 *   - decodes the shortcode to the numeric id locally, so it makes exactly ONE request to
 *     Instagram: the media-info call Instagram's own web client makes, with the session cookie
 *     the browser already holds.
 *   - trims the response to the widest rendition of each slide and the fields SERA uses, so the
 *     payload is small enough for a URL and Instagram's viewer data never leaves the tab.
 *   - loads, fetches and evaluates no code of any kind. That is the trust boundary: it runs with
 *     the visitor's Instagram session, so remote-loaded code would turn a SERA compromise into an
 *     Instagram-account compromise.
 *
 * It is inline and self-contained by necessity: instagram.com's CSP forbids loading a script,
 * and a user-invoked bookmarklet is the one thing exempt from it.
 */

/**
 * The exact code the bookmarklet runs, with the deployment's origin substituted in.
 *
 * This is what `buildBookmarklet` encodes into the `javascript:` URL and what the /import page
 * shows the visitor — the same string, so "read what you are about to install" is literally
 * true. Compact, but not minified: every statement is on its own line.
 */
export function bookmarkletSource(seraOrigin: string): string {
  const origin = JSON.stringify(seraOrigin.replace(/\/+$/, ''));
  const appId = JSON.stringify(APP_ID);
  const version = JSON.stringify(FRAGMENT_VERSION);

  return `(function(){
  var SERA=${origin};
  var m=location.pathname.match(/^\\/(?:[^/]+\\/)?(?:p|reel|reels|tv)\\/([A-Za-z0-9_-]+)/);
  if(!m){alert('Open a single Instagram post, reel or video first.');return;}
  var code=m[1];
  var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var pk=0n;for(var i=0;i<code.length;i++){pk=pk*64n+BigInt(A.indexOf(code[i]));}
  function widest(a){return (a||[]).slice().sort(function(x,y){return (y.width||0)-(x.width||0);})[0];}
  function pick(c){return c?{url:c.url,width:c.width,height:c.height}:undefined;}
  function keep(n){
    if(!n||typeof n!=='object')return undefined;
    var out={id:n.id,code:n.code,media_type:n.media_type,video_duration:n.video_duration,accessibility_caption:n.accessibility_caption};
    var img=n.image_versions2&&pick(widest(n.image_versions2.candidates));
    if(img)out.image_versions2={candidates:[img]};
    var vid=pick(widest(n.video_versions));
    if(vid)out.video_versions=[vid];
    if(n.carousel_media)out.carousel_media=n.carousel_media.map(keep);
    if(n.user)out.user={username:n.user.username,full_name:n.user.full_name};
    if(n.caption)out.caption={text:n.caption.text};
    return out;
  }
  fetch('/api/v1/media/'+pk.toString()+'/info/',{headers:{'x-ig-app-id':${appId},'x-requested-with':'XMLHttpRequest'},credentials:'include'})
    .then(function(r){return r.json();})
    .then(function(j){
      var it=j&&j.items&&j.items[0];
      if(!it){alert('SERA could not read that post. Make sure you are signed in to Instagram.');return;}
      var payload={url:'https://www.instagram.com/p/'+code+'/',node:keep(it)};
      location.href=SERA+'/import#v='+${version}+'&p='+encodeURIComponent(JSON.stringify(payload));
    })
    .catch(function(){alert('SERA could not read that post. Make sure you are signed in to Instagram.');});
})();`;
}

/** The bookmarklet as a `javascript:` URL — exactly `bookmarkletSource`, encoded. */
export function buildBookmarklet(seraOrigin: string): string {
  return `javascript:${encodeURIComponent(bookmarkletSource(seraOrigin))}`;
}
