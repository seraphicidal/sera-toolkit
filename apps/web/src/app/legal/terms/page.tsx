import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'Terms of service, acceptable use policy, and content restrictions under DSA Article 14 and international copyright frameworks.',
};

export default function TermsPage() {
  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          Terms of Service & Acceptable Use
        </h1>
        <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
          Terms governing the use of SERA.toolkit pursuant to Article 14 of Regulation (EU)
          2022/2065 (Digital Services Act) and international copyright legislation.
        </p>
      </header>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          1. Technical Intermediary Scope
        </h2>
        <p>
          SERA.toolkit operates strictly as a neutral, automated technical utility designed to
          facilitate the retrieval, format shifting, and downloading of publicly accessible online
          media.
        </p>
        <p>
          The service does not host a searchable library, index of media, directory of content, or
          public repository. Media is processed on-demand in transient workspaces and purged shortly
          after conversion.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          2. User Responsibility & Affirmative Warranty
        </h2>
        <div className="rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-[0.875rem]">
          <p className="font-medium text-[var(--color-ink)]">
            By submitting a URL to SERA.toolkit, you represent, warrant, and affirmatively certify
            that:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[var(--color-ink-muted)]">
            <li>
              You are the lawful copyright owner of the requested media, or have obtained explicit
              authorization from the copyright holder; or
            </li>
            <li>
              Your download and conversion is strictly authorized under applicable statutory
              copyright exceptions in your jurisdiction (such as private copying, quotation, parody,
              or fair use); and
            </li>
            <li>
              You will not use the service in violation of any applicable local, national, or
              international laws or third-party contractual rights.
            </li>
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          3. Prohibited Content & Abuse Restrictions
        </h2>
        <p>You agree not to use the service for any of the following prohibited activities:</p>
        <ul className="list-disc space-y-2 pl-5 text-[0.875rem]">
          <li>
            <strong className="text-[var(--color-ink)]">
              Unauthorized Commercial Infringement:
            </strong>{' '}
            Downloading, converting, or distributing copyrighted audio, video, or literary works
            without adequate licensing, consent, or legal defense.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">DRM & Paywall Circumvention:</strong>{' '}
            Accessing or attempting to circumvent digital rights management technologies (such as
            Widevine, FairPlay, or PlayReady), paywalls, session-restricted portals, or
            password-protected content.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Malicious & Illegal Material:</strong>{' '}
            Disseminating malware, ransomware, phishing scripts, CSAM, terrorist content, or any
            material prohibited under EU or domestic criminal laws.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">Automated Scraping & Service Abuse:</strong>{' '}
            Subjecting the infrastructure to high-frequency automated scraping, denial-of-service
            attacks, or bypassing automated rate limiting systems.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          4. Notice-and-Action Takedowns (DSA Art. 16 & DMCA § 512)
        </h2>
        <p>
          SERA.toolkit maintains an expedited notice-and-action mechanism to respond to verified
          claims of intellectual property infringement and illegal online content.
        </p>
        <p>
          Upon receiving a valid takedown notice meeting statutory requirements under Article 16 of
          the Digital Services Act or Section 512(c)(3) of Title 17 of the United States Code
          (DMCA), we promptly take appropriate mitigation action. This includes deploying automated
          blocking rules to disable resolution for the targeted URLs or domain hosts across our
          extraction engine.
        </p>
        <p>
          To lodge a formal takedown request, submit our{' '}
          <Link href="/legal/report" className="text-[var(--color-accent)] underline">
            Notice-and-Action Report Form
          </Link>
          .
        </p>
      </section>

      <section className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          5. Disclaimer of Warranties & Limitation of Liability
        </h2>
        <p>
          The service is provided on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; basis without
          warranties of any kind, whether express or implied. To the maximum extent permitted by
          applicable law, the operator disclaims all liability for direct, indirect, incidental, or
          consequential damages resulting from the use or inability to use the service.
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
          href="/legal/report"
          className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Report Abuse
        </Link>
      </div>
    </article>
  );
}
