import { Downloader } from '@/components/downloader';
import { Wordmark } from '@/components/wordmark';

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col justify-center pt-6 pb-14 sm:pt-10">
      <div className="mb-8 text-center sm:mb-10">
        <h1 className="mb-2.5">
          <Wordmark size="lg" />
        </h1>
        <p className="text-[0.9375rem] text-balance text-[var(--color-ink-muted)]">
          One link in, whatever media is available out.
        </p>
      </div>

      <Downloader />
    </div>
  );
}
