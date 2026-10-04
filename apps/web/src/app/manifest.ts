import type { MetadataRoute } from 'next';

/**
 * The web app manifest, served at /manifest.webmanifest.
 *
 * It makes the site installable on a phone, and the share target is the reason to install
 * it: once installed, SERA appears in the system share sheet, so a video can go from the
 * YouTube or TikTok app to SERA without copying a link. Everything it names is same-origin.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'SERA.toolkit',
    short_name: 'SERA',
    description: 'Paste or share a link and get the media.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The light canvas. A manifest takes one colour; the theme-color meta tags in the
    // layout give the browser the dark one as well.
    background_color: '#fbfbfa',
    theme_color: '#fbfbfa',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    share_target: {
      action: '/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  };
}
