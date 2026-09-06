import type { Metadata } from 'next';
import Link from 'next/link';
import type { ServiceInfo } from '@sera/contracts/types';
import { Wordmark } from '@/components/wordmark';

export const metadata: Metadata = {
  title: 'About',
  description:
    'What SERA.toolkit supports, what it keeps, and what you are responsible for when you use it.',
};

// The supported-source list is read from the running API, so this page describes the
// deployment the visitor is actually using rather than a list that drifts out of date.
export const revalidate = 60;

const API_ORIGIN = (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

async function loadServiceInfo(): Promise<ServiceInfo | undefined> {
  try {
    const response = await fetch(`${API_ORIGIN}/api/info`, { next: { revalidate: 60 } });
    if (!response.ok) return undefined;
    return (await response.json()) as ServiceInfo;
  } catch {
    return undefined;
  }
}

function formatGigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default async function AboutPage() {
  const service = await loadServiceInfo();
  const providers = service?.providers ?? [];
  const degraded = providers.filter((provider) => provider.status !== 'ok');

  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header>
        <h1 className="mb-2">
          <Wordmark size="lg" />
        </h1>
        <p className="text-[0.9375rem] text-balance text-[var(--color-ink-muted)]">
          A universal media toolkit for downloading and converting publicly accessible media.
        </p>
        {service && (
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Version {service.version}</p>
        )}
      </header>

      <Section title="How it works">
        <p>
          Paste a link. SERA works out which site it belongs to, asks that site what media the post
          contains, and offers you the formats that genuinely exist for it. There is no source
          picker, because there is nothing useful to pick from until the link has been read.
        </p>
        <p>
          A post with several images or videos resolves to all of them, not just the first. Pick the
          parts you want; several files come back as one archive, or separately if you would rather.
        </p>
      </Section>

      <Section title="Supported sources">
        {providers.length > 0 ? (
          <>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              {providers.map((provider) => (
                <li key={provider.id} className="flex items-center gap-2 text-[0.875rem]">
                  <span
                    aria-hidden="true"
                    className={
                      provider.status === 'ok'
                        ? 'inline-block size-1.5 shrink-0 rounded-full bg-[var(--color-success)]'
                        : 'inline-block size-1.5 shrink-0 rounded-full bg-[var(--color-danger)]'
                    }
                  />
                  <span className={provider.status === 'ok' ? '' : 'text-[var(--color-ink-faint)]'}>
                    {provider.label}
                  </span>
                </li>
              ))}
            </ul>
            {degraded.length > 0 && (
              <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-3.5 py-3 text-[0.875rem]">
                {degraded.map((provider) => provider.label).join(', ')}{' '}
                {degraded.length === 1 ? 'is' : 'are'} temporarily unavailable. Sites change how
                they serve media, and support returns once the extractor catches up. Everything else
                keeps working in the meantime.
              </p>
            )}
            <p>
              Beyond these, SERA reads any page that publishes its own media in the standard way,
              and accepts a direct link to a media file.
            </p>
          </>
        ) : (
          <p>
            The list of supported sources is read from the API, which is not reachable right now.
          </p>
        )}
      </Section>

      <Section title="Formats">
        <p>
          Video comes back as MP4, WebM or MOV — whichever the source can be put into without
          re-encoding — at whatever resolutions the site actually publishes. Audio can be extracted
          as MP3, M4A, Opus or WAV. Images come back untouched, and short videos can be converted to
          GIF.
        </p>
        <p>
          A quality is only offered when the source has it. If the original audio is 128 kbps, SERA
          will not offer to hand you a 320 kbps file, because there would be nothing extra in it.
        </p>
      </Section>

      {service && (
        <Section title="Limits">
          <ul className="flex flex-col gap-1.5 text-[0.875rem]">
            <Limit
              label="Maximum file size"
              value={formatGigabytes(service.limits.maxFilesizeBytes)}
            />
            <Limit
              label="Maximum duration"
              value={`${Math.round(service.limits.maxDurationSeconds / 3600)} hours`}
            />
            <Limit label="Items per download" value={String(service.limits.maxItemsPerJob)} />
            <Limit
              label="Files kept on the server"
              value={`${Math.round(service.limits.retentionSeconds / 60)} minutes`}
            />
          </ul>
        </Section>
      )}

      <Section title="Privacy">
        <p>
          There is no account and no tracking. Nothing you paste is stored: the link is used to
          fetch the media and then discarded, and the server logs record which site a request went
          to and whether it worked, not which video you asked for.
        </p>
        <p>
          Finished files live in a temporary directory and are deleted automatically
          {service
            ? ` after about ${Math.round(service.limits.retentionSeconds / 60)} minutes`
            : ''}
          , whether or not you downloaded them. Thumbnails are fetched by the server rather than
          your browser, so the site you pasted from never sees your address.
        </p>
      </Section>

      <Section title="Responsible use">
        <p>
          You are responsible for making sure you have the right to download and convert whatever
          you put through SERA. Copyright, platform terms and local law all still apply, and nothing
          here changes them.
        </p>
        <p>
          SERA only handles media that is already publicly accessible. It does not defeat DRM, sign
          in on your behalf, bypass paywalls, or reach content behind an access control — if a post
          is private, SERA will tell you so rather than trying to get around it.
        </p>
      </Section>

      <Section title="Open source">
        <p>
          SERA.toolkit is MIT licensed and self-hostable. It is built on{' '}
          <ExternalNote>yt-dlp</ExternalNote> for extraction and <ExternalNote>FFmpeg</ExternalNote>{' '}
          for conversion, both of which do the genuinely hard work here.
        </p>
        <p className="text-[0.875rem] text-[var(--color-ink-faint)]">
          Run it yourself with Docker, or from source. The README covers both.
        </p>
      </Section>

      <p className="border-t border-[var(--color-line)] pt-6">
        <Link
          href="/"
          className="text-[0.9375rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          ← Back to the toolkit
        </Link>
      </p>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        {children}
      </div>
    </section>
  );
}

function Limit({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-dashed border-[var(--color-line)] pb-1.5 last:border-0">
      <span>{label}</span>
      <span className="tabular text-[var(--color-ink)]">{value}</span>
    </li>
  );
}

/** Names a dependency without linking out: the page makes no third-party requests. */
function ExternalNote({ children }: { readonly children: React.ReactNode }) {
  return <span className="font-medium text-[var(--color-ink)]">{children}</span>;
}
