import { PAYLOAD, READY } from './import-handshake';

/** Instagram's public web-client app id. Its own site sends this on every media-info call. */
const APP_ID = '936619743392459';

/**
 * The bookmarklet that sends the post you're looking at to SERA.
 *
 * It runs on instagram.com, in the tab where you are signed in, so it can read the one post
 * that page is showing the way Instagram's own client does — and it sends SERA only the media,
 * never your session. This is the MVP delivery: a link you drag to your bookmarks bar. The
 * readable, commented twin of this code is `apps/extension/bookmarklet.js`, and the next stage
 * is a real extension (see that folder's README). Keep the two in step.
 *
 * What it does, and deliberately all it does:
 *   - only on a single post — `/p/`, `/reel/`, `/reels/`, `/tv/`; one click, one post.
 *   - decodes the shortcode to the numeric id locally, so it makes exactly ONE request to
 *     Instagram: the media-info call Instagram's own web client makes.
 *   - opens SERA's /import window synchronously in the click, before any await, or the
 *     browser withholds the popup.
 *   - trims the response to the fields SERA uses before sending, so what Instagram says about
 *     the viewer — liked, saved, following — never leaves the tab.
 *
 * It is self-contained by necessity: instagram.com's CSP forbids loading a script, and a
 * user-invoked bookmarklet is the one thing exempt from it, so everything is inline.
 */
export function buildBookmarklet(seraOrigin: string): string {
  const origin = JSON.stringify(seraOrigin.replace(/\/+$/, ''));
  const appId = JSON.stringify(APP_ID);
  const ready = JSON.stringify(READY);
  const payload = JSON.stringify(PAYLOAD);

  // Kept compact but not mangled: a bookmarklet has no build step, and being able to read what
  // you are about to put in your bookmarks bar is worth more than the bytes.
  const source = `(function(){
  var SERA=${origin};
  var m=location.pathname.match(/^\\/(?:[^/]+\\/)?(?:p|reel|reels|tv)\\/([A-Za-z0-9_-]+)/);
  if(!m){alert('Open a single Instagram post, reel or video first.');return;}
  var code=m[1];
  var win=window.open(SERA+'/import','sera-import');
  if(!win){alert('Allow pop-ups for instagram.com, then try again.');return;}
  var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var pk=0n;for(var i=0;i<code.length;i++){pk=pk*64n+BigInt(A.indexOf(code[i]));}
  function keep(n){
    if(!n||typeof n!=='object')return undefined;
    function cand(c){return (c||[]).map(function(x){return {url:x.url,width:x.width,height:x.height};});}
    var out={id:n.id,code:n.code,media_type:n.media_type,video_duration:n.video_duration,accessibility_caption:n.accessibility_caption};
    if(n.image_versions2&&n.image_versions2.candidates)out.image_versions2={candidates:cand(n.image_versions2.candidates)};
    if(n.video_versions)out.video_versions=cand(n.video_versions);
    if(n.carousel_media)out.carousel_media=n.carousel_media.map(keep);
    if(n.user)out.user={username:n.user.username,full_name:n.user.full_name};
    if(n.caption)out.caption={text:n.caption.text};
    return out;
  }
  var post,ready=false,sent=false;
  function send(){if(post&&ready&&!sent){sent=true;win.postMessage({type:${payload},url:'https://www.instagram.com/p/'+code+'/',node:post},SERA);}}
  addEventListener('message',function(e){
    if(e.source===win&&e.origin===SERA&&e.data&&e.data.type===${ready}){ready=true;send();}
  });
  fetch('/api/v1/media/'+pk.toString()+'/info/',{headers:{'x-ig-app-id':${appId},'x-requested-with':'XMLHttpRequest'},credentials:'include'})
    .then(function(r){return r.json();})
    .then(function(j){var it=j&&j.items&&j.items[0];if(!it){alert('SERA could not read that post. Make sure you are signed in to Instagram.');win.close();return;}post=keep(it);send();})
    .catch(function(){alert('SERA could not read that post. Make sure you are signed in to Instagram.');win.close();});
})();`;

  return `javascript:${encodeURIComponent(source)}`;
}
