import type { Metadata } from 'next';
import { LegalReportForm } from '@/components/legal-report-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notice-and-Action Takedown Form',
  description:
    'Submit a notification of allegedly illegal content or copyright infringement under EU DSA Art. 16 and 17 U.S.C. § 512.',
};

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export default function LegalReportPage() {
  const authoritiesEmail =
    clean(process.env.CONTACT_EMAIL_AUTHORITIES) ??
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_AUTHORITIES) ??
    clean(process.env.OPERATOR_EMAIL) ??
    clean(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);
  const legalEmail =
    clean(process.env.CONTACT_EMAIL_LEGAL) ??
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_LEGAL) ??
    clean(process.env.OPERATOR_EMAIL) ??
    clean(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);

  return <LegalReportForm authoritiesEmail={authoritiesEmail} legalEmail={legalEmail} />;
}
