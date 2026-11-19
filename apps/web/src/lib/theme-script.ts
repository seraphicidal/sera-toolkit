export const THEME_STORAGE_KEY = 'sera-theme';

export const themeScript = `
(function(){try{
  var s=localStorage.getItem('${THEME_STORAGE_KEY}');
  var p=(s==='light'||s==='dark')?s:'system';
  var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
  var r=document.documentElement;
  r.dataset.theme=d?'dark':'light';
  r.dataset.themePreference=p;
}catch(e){}})();
`.trim();
