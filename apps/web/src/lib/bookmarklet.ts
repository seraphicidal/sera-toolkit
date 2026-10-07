import { FRAGMENT_VERSION } from './import-handshake';

const APP_ID = '936619743392459';

const MAX_IMPORT_URL = 60_000;

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
  function clip(s,n){return typeof s==='string'?s.slice(0,n):undefined;}
  function widest(a){return (a||[]).slice().sort(function(x,y){return (y.width||0)-(x.width||0);})[0];}
  function pick(c){return c?{url:c.url,width:c.width,height:c.height}:undefined;}
  function keep(n){
    if(!n||typeof n!=='object')return undefined;
    var out={id:n.id,code:n.code,media_type:n.media_type,video_duration:n.video_duration,accessibility_caption:clip(n.accessibility_caption,150)};
    var img=n.image_versions2&&pick(widest(n.image_versions2.candidates));
    if(img)out.image_versions2={candidates:[img]};
    var vid=pick(widest(n.video_versions));
    if(vid)out.video_versions=[vid];
    if(n.carousel_media)out.carousel_media=n.carousel_media.map(keep);
    if(n.user)out.user={username:n.user.username,full_name:n.user.full_name};
    if(n.caption)out.caption={text:clip(n.caption.text,300)};
    return out;
  }
  fetch('/api/v1/media/'+pk.toString()+'/info/',{headers:{'x-ig-app-id':${appId},'x-requested-with':'XMLHttpRequest'},credentials:'include'})
    .then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t);}catch(e){}return {r:r,j:j};});})
    .then(function(res){
      var r=res.r,j=res.j;
      var msg=j?(j.message||((j.require_login||j.requires_login)?'login_required':'')):'';
      if(msg)msg=String(msg).slice(0,120);
      if(r.redirected||(msg&&/login/i.test(msg))){alert("SERA: you're not signed in to instagram.com in this browser. The Instagram app's login doesn't count. Sign in on the website, then try again.");return;}
      if(!r.ok){alert('SERA: Instagram answered HTTP '+r.status+' ('+(msg||'not JSON')+'). Are you signed in to instagram.com in this browser?');return;}
      if(!j){alert("SERA: you're not signed in to instagram.com in this browser. The Instagram app's login doesn't count. Sign in on the website, then try again.");return;}
      var it=j.items&&j.items[0];
      if(!it){alert('SERA: Instagram returned no media for this post.');return;}
      var payload={url:'https://www.instagram.com/p/'+code+'/',node:keep(it)};
      var href=SERA+'/import#v='+${version}+'&p='+encodeURIComponent(JSON.stringify(payload));
      if(href.length>${MAX_IMPORT_URL}){alert('SERA: this post is too large to send ('+Math.round(href.length/1024)+' KB).');return;}
      location.href=href;
    })
    .catch(function(e){alert('SERA: network error reading the post ('+((e&&e.name)||'error')+').');});
})();`;
}

export function buildBookmarklet(seraOrigin: string): string {
  return `javascript:${encodeURIComponent(bookmarkletSource(seraOrigin))}`;
}
