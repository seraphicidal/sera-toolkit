import type { Metadata } from 'next';
import { ImportClient } from '@/components/import-client';

/**
 * Where a post the visitor's browser read is handed over.
 *
 * A thin server component: the work is a client one, because the whole point is the
 * window-to-window handshake with instagram.com, which only exists in the browser. Kept out of
 * search results — there is nothing here to index, and it only does anything when another
 * window opens it.
 */
export const metadata: Metadata = {
  title: 'Import from Instagram',
  description: 'Send an Instagram photo post to SERA from your own signed-in browser.',
  robots: { index: false, follow: false },
};

export default function ImportPage() {
  return <ImportClient />;
}
