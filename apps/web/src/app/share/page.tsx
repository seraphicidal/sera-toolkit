import type { Metadata } from 'next';
import { ShareRedirect } from '@/components/share-redirect';

export const metadata: Metadata = {
  title: 'Share',
  robots: { index: false, follow: false },
};

export default function SharePage() {
  return <ShareRedirect />;
}
