import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Legal Notice (Impressum)',
  description:
    'Provider identification and regulatory points of contact under EU E-Commerce Directive Art. 5, DDG § 5, and DSA Arts. 11 & 12.',
};

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export default function LegalNoticePage() {
  const operatorName =
    clean(process.env.NEXT_PUBLIC_OPERATOR_NAME) ??
    clean(process.env.OPERATOR_NAME) ??
    'SERA.toolkit Operator';
  const operatorAddress =
    clean(process.env.NEXT_PUBLIC_OPERATOR_ADDRESS) ?? clean(process.env.OPERATOR_ADDRESS);
  const operatorEmail =
    clean(process.env.NEXT_PUBLIC_OPERATOR_EMAIL) ?? clean(process.env.OPERATOR_EMAIL);
  const registrationId =
    clean(process.env.NEXT_PUBLIC_OPERATOR_REGISTRATION_ID) ??
    clean(process.env.OPERATOR_REGISTRATION_ID);
  const authoritiesEmail =
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_AUTHORITIES) ??
    clean(process.env.CONTACT_EMAIL_AUTHORITIES) ??
    operatorEmail;
  const legalEmail =
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_LEGAL) ??
    clean(process.env.CONTACT_EMAIL_LEGAL) ??
    operatorEmail;

  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          Legal Notice / Impressum
        </h1>
        <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
          Information pursuant to Section 5 of the German Digital Services Act (DDG), Article 5 of
          the EU E-Commerce Directive 2000/31/EC, and Articles 11 and 12 of the EU Digital Services
          Act (Regulation (EU) 2022/2065).
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          Service Provider Information
        </h2>
        <div className="rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <dl className="grid grid-cols-1 gap-y-3 text-[0.875rem] sm:grid-cols-[14rem_1fr] sm:gap-x-4">
            <dt className="text-[var(--color-ink-muted)]">Operator / Entity</dt>
            <dd className="font-medium text-[var(--color-ink)]">{operatorName}</dd>

            {operatorAddress ? (
              <>
                <dt className="text-[var(--color-ink-muted)]">Registered Office / Address</dt>
                <dd className="whitespace-pre-line text-[var(--color-ink)]">{operatorAddress}</dd>
              </>
            ) : null}

            <dt className="text-[var(--color-ink-muted)]">Electronic Contact</dt>
            <dd className="text-[var(--color-ink)]">
              {operatorEmail ? (
                <a
                  href={`mailto:${operatorEmail}`}
                  className="text-[var(--color-accent)] transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                >
                  {operatorEmail}
                </a>
              ) : (
                <Link
                  href="/legal/report"
                  className="text-[var(--color-accent)] transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                >
                  Notice &amp; Contact Form
                </Link>
              )}
            </dd>

            {registrationId ? (
              <>
                <dt className="text-[var(--color-ink-muted)]">Commercial Register / ID</dt>
                <dd className="text-[var(--color-ink)]">{registrationId}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          Designated Points of Contact (DSA Arts. 11 & 12)
        </h2>
        <div className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-[0.875rem] leading-relaxed text-[var(--color-ink-muted)]">
          <p>
            Pursuant to Articles 11 and 12 of Regulation (EU) 2022/2065 (Digital Services Act), the
            following electronic points of contact have been designated for direct, rapid
            communication:
          </p>
          <ul className="flex flex-col gap-2 pt-1 text-[var(--color-ink)]">
            <li>
              <span className="font-medium text-[var(--color-ink-muted)]">
                Member State Authorities & EU Commission (Art. 11):{' '}
              </span>
              {authoritiesEmail ? (
                <a
                  href={`mailto:${authoritiesEmail}`}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {authoritiesEmail}
                </a>
              ) : (
                <Link href="/legal/report" className="text-[var(--color-accent)] hover:underline">
                  Designated Electronic Reporting Channel
                </Link>
              )}
            </li>
            <li>
              <span className="font-medium text-[var(--color-ink-muted)]">
                Recipients of the Service / Legal Matters (Art. 12):{' '}
              </span>
              {legalEmail ? (
                <a
                  href={`mailto:${legalEmail}`}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  {legalEmail}
                </a>
              ) : (
                <Link href="/legal/report" className="text-[var(--color-accent)] hover:underline">
                  Designated Electronic Reporting Channel
                </Link>
              )}
            </li>
            <li>
              <span className="font-medium text-[var(--color-ink-muted)]">
                Supported Official EU Languages:{' '}
              </span>
              English and German.
            </li>
          </ul>
          <p className="pt-2 text-xs text-[var(--color-ink-faint)]">
            To submit a structured notice of allegedly illegal content or copyright infringement,
            please use our dedicated{' '}
            <Link href="/legal/report" className="text-[var(--color-accent)] underline">
              Notice-and-Action reporting channel
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          Hosting Provider Liability
        </h2>
        <p>
          SERA.toolkit operates as an intermediary technical service provider in accordance with
          Article 6 of Regulation (EU) 2022/2065 (DSA) and German DDG § 7. The service processes
          requests transiently in an automated fashion to format and deliver publicly available
          content.
        </p>
        <p>
          The service does not curate, index, catalog, or actively monitor third-party information.
          Upon receiving substantiated notifications of illegal content via our notice-and-action
          mechanisms, appropriate automated and administrative mitigations are expeditiously
          enacted.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--color-line)] pt-6 text-[0.875rem]">
        <Link
          href="/"
          className="font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          ← Back to toolkit
        </Link>
        <span className="text-[var(--color-line-strong)]">·</span>
        <Link
          href="/legal/privacy"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Privacy Policy
        </Link>
        <span className="text-[var(--color-line-strong)]">·</span>
        <Link
          href="/legal/terms"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Terms of Service
        </Link>
        <span className="text-[var(--color-line-strong)]">·</span>
        <Link
          href="/legal/report"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Report Abuse
        </Link>
      </div>
    </article>
  );
}
