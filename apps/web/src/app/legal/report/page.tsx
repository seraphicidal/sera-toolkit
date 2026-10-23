'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LegalReportCategory, LegalReportResponse } from '@sera/contracts/types';
import { AlertIcon, CheckIcon, SpinnerIcon } from '@/components/icons';

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export default function LegalReportPage() {
  const [targetUrl, setTargetUrl] = useState('');
  const [category, setCategory] = useState<LegalReportCategory>('copyright');
  const [explanation, setExplanation] = useState('');
  const [notifierName, setNotifierName] = useState('');
  const [notifierOrganization, setNotifierOrganization] = useState('');
  const [notifierEmail, setNotifierEmail] = useState('');
  const [goodFaithConfirmed, setGoodFaithConfirmed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<LegalReportResponse | undefined>(undefined);

  const authoritiesEmail =
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_AUTHORITIES) ??
    clean(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);
  const legalEmail =
    clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL_LEGAL) ??
    clean(process.env.NEXT_PUBLIC_OPERATOR_EMAIL);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);

    if (!goodFaithConfirmed) {
      setError('You must confirm the good-faith and accuracy certification to submit.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/legal/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetUrl,
          category,
          explanation,
          notifierName,
          ...(notifierOrganization ? { notifierOrganization } : {}),
          notifierEmail,
          goodFaithConfirmed: true,
        }),
      });

      if (!response.ok) {
        let message = 'Failed to submit notice.';
        try {
          const err = (await response.json()) as { error?: { message?: string; hint?: string } };
          if (err.error?.hint) message = err.error.hint;
          else if (err.error?.message) message = err.error.message;
        } catch {}
        setError(message);
        return;
      }

      const data = (await response.json()) as LegalReportResponse;
      setReceipt(data);
    } catch {
      setError('A network error occurred while submitting the report. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          Notice-and-Action Takedown Form
        </h1>
        <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
          Submit a notification of allegedly illegal content or copyright infringement pursuant to
          Article 16 of the EU Digital Services Act (Regulation (EU) 2022/2065) and 17 U.S.C. § 512
          (DMCA).
        </p>
      </header>

      {receipt ? (
        <section
          role="status"
          aria-live="polite"
          className="rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lift)]"
        >
          <div className="flex items-center gap-3 text-[var(--color-success)]">
            <CheckIcon size={22} />
            <h2 className="text-lg font-medium text-[var(--color-ink)]">
              Notice Received and Logged
            </h2>
          </div>
          <p className="mt-3 text-[0.875rem] leading-relaxed text-[var(--color-ink-muted)]">
            Your notification has been securely recorded and dispatched for administrative review.
            Where automated mitigation criteria were satisfied, technical resolution blocking has
            been initiated.
          </p>
          <dl className="mt-4 grid grid-cols-1 gap-2 rounded-xl bg-[var(--color-sunken)] p-4 text-[0.8125rem] sm:grid-cols-[10rem_1fr]">
            <dt className="text-[var(--color-ink-muted)]">Report ID:</dt>
            <dd className="font-mono font-medium text-[var(--color-ink)]">{receipt.reportId}</dd>

            <dt className="text-[var(--color-ink-muted)]">Received At:</dt>
            <dd className="text-[var(--color-ink)]">{receipt.receivedAt}</dd>

            <dt className="text-[var(--color-ink-muted)]">Initial Status:</dt>
            <dd className="font-medium text-[var(--color-ink)] capitalize">
              {receipt.status.replace('_', ' ')}
            </dd>

            {receipt.mitigated && (
              <>
                <dt className="text-[var(--color-ink-muted)]">Mitigation:</dt>
                <dd className="font-medium text-[var(--color-success)]">
                  Automated engine denylist blocking engaged
                </dd>
              </>
            )}
          </dl>
          <div className="mt-6">
            <button
              type="button"
              onClick={() => {
                setReceipt(undefined);
                setTargetUrl('');
                setExplanation('');
              }}
              className="cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-4 py-2 text-xs font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)]"
            >
              Submit another notice
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2.5 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-wash)] p-4 text-[0.875rem] text-[var(--color-danger)]"
            >
              <AlertIcon size={18} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="target-url"
              className="text-xs font-medium text-[var(--color-ink)] uppercase"
            >
              Target URL / Infringing Resource <span className="text-[var(--color-danger)]">*</span>
            </label>
            <input
              id="target-url"
              type="url"
              required
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com/media-or-post"
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            />
            <p className="text-xs text-[var(--color-ink-faint)]">
              Specify the exact URL hosted on or accessible via the external platform.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="category"
              className="text-xs font-medium text-[var(--color-ink)] uppercase"
            >
              Categorization <span className="text-[var(--color-danger)]">*</span>
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value as LegalReportCategory)}
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <option value="copyright">
                Copyright Infringement (DMCA § 512 / InfoSoc Directive)
              </option>
              <option value="malware">Malware / Phishing / Malicious Payload</option>
              <option value="illegal_content">Illegal Content under EU Law</option>
              <option value="other">Other Legal Infringement</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="explanation"
              className="text-xs font-medium text-[var(--color-ink)] uppercase"
            >
              Basis of Claim / Explanation <span className="text-[var(--color-danger)]">*</span>
            </label>
            <textarea
              id="explanation"
              required
              rows={4}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Explain the legal grounds, identify the copyrighted work, or explain the nature of the illegal content."
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="notifier-name"
                className="text-xs font-medium text-[var(--color-ink)] uppercase"
              >
                Your Full Name <span className="text-[var(--color-danger)]">*</span>
              </label>
              <input
                id="notifier-name"
                type="text"
                required
                value={notifierName}
                onChange={(e) => setNotifierName(e.target.value)}
                placeholder="First Last"
                className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="notifier-org"
                className="text-xs font-medium text-[var(--color-ink)] uppercase"
              >
                Organization / Entity (Optional)
              </label>
              <input
                id="notifier-org"
                type="text"
                value={notifierOrganization}
                onChange={(e) => setNotifierOrganization(e.target.value)}
                placeholder="Company, Law Firm, or Studio"
                className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="notifier-email"
              className="text-xs font-medium text-[var(--color-ink)] uppercase"
            >
              Contact Email <span className="text-[var(--color-danger)]">*</span>
            </label>
            <input
              id="notifier-email"
              type="email"
              required
              value={notifierEmail}
              onChange={(e) => setNotifierEmail(e.target.value)}
              placeholder="legal@rightsholder.example"
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            />
          </div>

          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                required
                checked={goodFaithConfirmed}
                onChange={(e) => setGoodFaithConfirmed(e.target.checked)}
                className="mt-1 size-4 rounded border-[var(--color-line-strong)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
              />
              <span className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                I hereby certify, under penalty of perjury, that I have a good-faith belief that the
                use of the material in the manner complained of is not authorized by the copyright
                owner, its agent, or the law, and that the information in this notification is
                accurate (DSA Art. 16(2)(c) & 17 U.S.C. § 512(c)(3)).
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={busy || !goodFaithConfirmed}
            className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)] text-[0.9375rem] font-medium text-[var(--color-accent-ink)] transition-opacity hover:opacity-90 focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:bg-[var(--color-sunken)] disabled:text-[var(--color-ink-faint)]"
          >
            {busy ? (
              <>
                <SpinnerIcon size={18} />
                Submitting notice…
              </>
            ) : (
              'Submit Takedown Notice'
            )}
          </button>
        </form>
      )}

      <section className="flex flex-col gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-4 text-xs text-[var(--color-ink-faint)]">
        <p className="font-medium text-[var(--color-ink)]">
          Designated Points of Contact (DSA Arts. 11 & 12):
        </p>
        <p>
          {authoritiesEmail || legalEmail ? (
            <>
              {authoritiesEmail && (
                <>
                  Authorities point of contact:{' '}
                  <a
                    href={`mailto:${authoritiesEmail}`}
                    className="text-[var(--color-accent)] underline"
                  >
                    {authoritiesEmail}
                  </a>
                  .{' '}
                </>
              )}
              {legalEmail && (
                <>
                  Legal inquiries:{' '}
                  <a
                    href={`mailto:${legalEmail}`}
                    className="text-[var(--color-accent)] underline"
                  >
                    {legalEmail}
                  </a>
                  .{' '}
                </>
              )}
            </>
          ) : (
            <>
              Notice and takedown submissions are processed directly through the electronic intake
              form above.{' '}
            </>
          )}
          Supported languages: English, German.
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
          href="/legal/notice"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Legal Notice
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
      </div>
    </article>
  );
}
