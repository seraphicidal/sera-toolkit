import type { Metadata } from 'next';
import { ImportClient } from '@/components/import-client';

export const metadata: Metadata = {
  title: 'Import from Instagram',
  description: 'Send an Instagram photo post to SERA from your own signed-in browser.',
  robots: { index: false, follow: false },
};

export default function ImportPage() {
  return <ImportClient />;
}
