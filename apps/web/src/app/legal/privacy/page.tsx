import type { Metadata } from 'next';
import Link from 'next/link';
import { ClearHistoryButton } from '@/components/clear-history-button';

export const metadata: Metadata = {
  title: 'Privacy Notice',
  description:
    'Data processing practices under Regulation (EU) 2016/679 (GDPR) and the ePrivacy Directive.',
};

export default function PrivacyPage() {
  const operatorName =
    process.env.NEXT_PUBLIC_OPERATOR_NAME ?? process.env.OPERATOR_NAME ?? 'SERA.toolkit Operator';
  const operatorEmail =
    process.env.NEXT_PUBLIC_OPERATOR_EMAIL ??
    process.env.OPERATOR_EMAIL ??
    'contact@sera-toolkit.internal';
  const dpoEmail =
    process.env.NEXT_PUBLIC_CONTACT_EMAIL_LEGAL ??
    process.env.CONTACT_EMAIL_LEGAL ??
    'privacy@sera-toolkit.internal';

  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          GDPR Privacy Notice
        </h1>
        <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
          Transparency information in accordance with Articles 12, 13, and 14 of Regulation (EU)
          2016/679 (General Data Protection Regulation) and Directive 2002/58/EC (ePrivacy).
        </p>
      </header>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          1. Data Controller
        </h2>
        <p>
          The controller responsible for data processing through this service within the meaning of
          Art. 4(7) GDPR is:
        </p>
        <div className="rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-[0.875rem] text-[var(--color-ink)]">
          <p className="font-medium">{operatorName}</p>
          <p className="mt-1">
            General Contact:{' '}
            <a
              href={`mailto:${operatorEmail}`}
              className="text-[var(--color-accent)] hover:underline"
            >
              {operatorEmail}
            </a>
          </p>
          <p className="mt-1">
            Data Protection / Privacy Contact:{' '}
            <a href={`mailto:${dpoEmail}`} className="text-[var(--color-accent)] hover:underline">
              {dpoEmail}
            </a>
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Full address details are available in the{' '}
            <Link href="/legal/notice" className="text-[var(--color-accent)] underline">
              Legal Notice (Impressum)
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          2. Ephemeral Network Identifiers (Art. 6(1)(f) GDPR)
        </h2>
        <p>
          When you interact with the service, your internet protocol (IP) address is processed
          strictly in-memory for security, DDoS defense, and rate limiting.
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem]">
          <li>
            <strong className="text-[var(--color-ink)]">Truncation and In-Memory Hashing:</strong>{' '}
            IP addresses are salted and hashed or truncated in volatile memory. Keys are refreshed
            regularly to prevent linkability.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">5-Minute Ephemeral Retention:</strong>{' '}
            In-memory rate limit counters and abuse protection tokens expire automatically after 5
            minutes. Raw IP addresses are never written to permanent disk storage, operational logs,
            or relational databases.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Legal Basis:</strong> Art. 6(1)(f) GDPR
            (legitimate interest in safeguarding operational stability, preventing brute-force
            abuse, and protecting technical infrastructure).
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          3. Media Processing & Automated File Unlinking
        </h2>
        <p>
          Media conversion and downloads operate in transient isolated workspaces with strict
          lifecycle constraints:
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem]">
          <li>
            <strong className="text-[var(--color-ink)]">30-Minute Workspace Retention:</strong> All
            downloaded streams, transcoded tracks, and packaged archives are permanently unlinked
            from disk within 30 minutes of creation (
            <code className="rounded bg-[var(--color-sunken)] px-1 py-0.5 text-xs">
              SERA_RETENTION_SECONDS = 1800
            </code>
            ).
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Automated Garbage Collection:</strong> A
            background sweeper inspects and reaps expired workspaces every 120 seconds. Once purged,
            files are permanently unrecoverable.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">No Content Profiling:</strong> We do not log
            or associate the specific media URLs you query with any user identifier or account.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          4. Server-Side Thumbnail Proxying
        </h2>
        <p>
          To safeguard user privacy, media thumbnails and preview images are never requested
          directly from your web browser to remote hosting platforms or content delivery networks
          (CDNs).
        </p>
        <p>
          All previews are fetched server-side through a dedicated proxy endpoint (
          <code className="rounded bg-[var(--color-sunken)] px-1 py-0.5 text-xs">
            /api/media/thumbnail
          </code>
          ). This ensures your client IP address and browser headers are never exposed to external
          third-party hosts or tracker CDNs.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          5. Complete Absence of Trackers & Third-Party Cookies
        </h2>
        <p>
          SERA.toolkit does not use any advertising cookies, behavioral analytics (such as Google
          Analytics or Meta Pixel), fingerprinting libraries, or marketing scripts. We do not sell,
          rent, share, or monetize user data under any circumstance.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          6. Local Storage Transparency (ePrivacy Art. 5(3))
        </h2>
        <p>
          In full accordance with Article 5(3) of Directive 2002/58/EC (ePrivacy Directive), the
          following strictly functional keys are stored locally on your device in your
          browser&apos;s localStorage:
        </p>
        <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)]">
          <table className="w-full text-left text-[0.875rem]">
            <thead className="border-b border-[var(--color-line)] bg-[var(--color-sunken)] text-xs text-[var(--color-ink-faint)] uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">Key</th>
                <th className="px-4 py-2.5 font-medium">Functional Purpose</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Legal Exemption</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)] text-[var(--color-ink)]">
              <tr>
                <td className="px-4 py-3 font-mono text-xs">sera-theme</td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                  Remembers your light or dark theme visual presentation preference.
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">Persistent</td>
                <td className="px-4 py-3 text-xs font-medium text-[var(--color-success)]">
                  Strictly Necessary (Art. 5(3))
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">sera-preferred-kind</td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                  Remembers your last selected output format category (video, audio, etc.).
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">Persistent</td>
                <td className="px-4 py-3 text-xs font-medium text-[var(--color-success)]">
                  Strictly Necessary (Art. 5(3))
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">sera-history</td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                  Stores titles and URLs of your recent downloads locally on your device for quick
                  re-download. Never transmitted to our servers.
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">Max 10 items</td>
                <td className="px-4 py-3 text-xs font-medium text-[var(--color-success)]">
                  User-Initiated Device Cache
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center justify-between rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-4">
          <span className="text-[0.875rem] text-[var(--color-ink)]">
            Clear locally stored download history at any time:
          </span>
          <ClearHistoryButton />
        </div>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          7. Data Subject Rights (Arts. 15–22 GDPR)
        </h2>
        <p>
          As an individual in the European Union or European Economic Area, you possess statutory
          rights under GDPR:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-[0.875rem]">
          <li>Right of access to processed personal data (Art. 15 GDPR).</li>
          <li>Right to rectification of inaccurate data (Art. 16 GDPR).</li>
          <li>Right to erasure (&quot;Right to be forgotten&quot;, Art. 17 GDPR).</li>
          <li>Right to restriction of processing (Art. 18 GDPR).</li>
          <li>Right to data portability (Art. 20 GDPR).</li>
          <li>Right to object to processing based on Art. 6(1)(f) GDPR (Art. 21 GDPR).</li>
        </ul>
        <p className="mt-1">
          Given that the service processes minimal ephemeral identifiers without maintaining user
          accounts or persistent identity links, identifying specific session records may require
          corroborating technical information from your request.
        </p>
        <p>
          You also have the right to lodge a formal complaint with a competent data protection
          supervisory authority pursuant to Art. 77 GDPR (e.g., the Berlin Commissioner for Data
          Protection and Freedom of Information or your local national EU supervisory authority).
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
