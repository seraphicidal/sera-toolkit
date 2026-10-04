import type { Metadata } from 'next';
import { ShareRedirect } from '@/components/share-redirect';

export const metadata: Metadata = {
  title: 'Share',
  robots: { index: false, follow: false },
};

/**
 * Where the share sheet sends a link (the manifest's `share_target`). It does no work of its
 * own: the browser reads the link out of the query and moves on to the home page at once.
 */
export default function SharePage() {
  return <ShareRedirect />;
}
