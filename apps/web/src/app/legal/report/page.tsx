import type { Metadata } from 'next';
import { LegalReportForm } from '@/components/legal-report-form';
import { cleanEmail } from '@/lib/contact';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notice-and-Action Takedown Form',
  description:
    'Submit a notification of allegedly illegal content or copyright infringement under EU DSA Art. 16 and 17 U.S.C. § 512.',
};

export default function LegalReportPage() {
  const authoritiesEmail =
    cleanEmail(process.env.CONTACT_EMAIL_AUTHORITIES) ??
    cleanEmail(process.env.NEXT_PUBLIC_CONTACT_EMAIL_AUTHORITIES) ??
    cleanEmail(process.env.OPERATOR_EMAIL) ??
    cleanEmail(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);
  const legalEmail =
    cleanEmail(process.env.CONTACT_EMAIL_LEGAL) ??
    cleanEmail(process.env.NEXT_PUBLIC_CONTACT_EMAIL_LEGAL) ??
    cleanEmail(process.env.OPERATOR_EMAIL) ??
    cleanEmail(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);

  return <LegalReportForm authoritiesEmail={authoritiesEmail} legalEmail={legalEmail} />;
}
