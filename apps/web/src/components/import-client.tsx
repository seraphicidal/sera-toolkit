'use client';

import { useEffect, useState } from 'react';
import type { JobError, MediaInfo } from '@sera/contracts/types';
import Link from 'next/link';
import { ApiError, importMedia } from '@/lib/api';
import { openImportChannel } from '@/lib/import-handshake';
import { BookmarkletLink } from './bookmarklet-link';
import { Downloader } from './downloader';
import { ErrorPanel } from './error-panel';
import { SpinnerIcon } from './icons';

/**
 * Receives a post the visitor's own browser read, and hands it to the downloader.
 *
 * This page is the far end of the /import handshake: instagram.com, where the visitor is
 * signed in, opens it and posts the one post it is showing. The bytes never touch a SERA
 * session — there isn't one — and what arrives is checked by the server before anything is
 * fetched. Opened any other way, with no post to receive, the page explains what it is for
 * rather than spinning.
 */
type Phase = 'waiting' | 'ready' | 'error' | 'idle';

export function ImportClient() {
  const [phase, setPhase] = useState<Phase>('waiting');
  const [info, setInfo] = useState<MediaInfo>();
  const [error, setError] = useState<JobError>();

  useEffect(() => {
    // No opener means nobody opened this to hand it a post — someone navigated here directly.
    // There is nothing to wait for, so explain the page at once rather than spin for the whole
    // handshake timeout. The bookmarklet always opens this window, so it always has an opener.
    if (!window.opener) {
      setPhase('idle');
      return;
    }

    const channel = openImportChannel(window);
    const controller = new AbortController();

    channel.received
      .then((request) => importMedia(request, controller.signal))
      .then((resolved) => {
        if (controller.signal.aborted) return;
        setInfo(resolved);
        setPhase('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError) {
          setError({
            code: caught.code,
            message: caught.message,
            ...(caught.hint ? { hint: caught.hint } : {}),
            retryable: caught.retryable,
          });
          setPhase('error');
        } else {
          // No post arrived — opened directly, or the handshake never completed. Not a
          // failure to apologise for; a page that needs to say how it is meant to be used.
          setPhase('idle');
        }
      });

    return () => {
      channel.close();
      controller.abort();
    };
  }, []);

  if (phase === 'ready' && info) {
    return (
      <div className="flex flex-1 flex-col justify-center py-8">
        <Downloader initialInfo={info} />
      </div>
    );
  }

  if (phase === 'error' && error) {
    return (
      <div className="flex flex-1 flex-col justify-center py-8">
        <ErrorPanel
          error={error}
          actions={[
            { label: 'Back to SERA', primary: true, onClick: () => (window.location.href = '/') },
          ]}
        />
      </div>
    );
  }

  if (phase === 'idle') return <HowItWorks />;

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <SpinnerIcon size={22} className="text-[var(--color-accent)]" />
      <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">
        Reading the post from your browser…
      </p>
    </section>
  );
}

/**
 * What this page is, for anyone who lands on it without a post to hand over.
 *
 * The one place SERA explains the visitor-import idea in the product itself: the post is read
 * by your own browser, signed in as you, and only the media is sent here.
 */
function HowItWorks() {
  return (
    <section className="animate-fade-up mx-auto flex max-w-[34rem] flex-1 flex-col justify-center gap-4 py-12">
      <h1 className="text-lg font-medium text-[var(--color-ink)]">
        Send an Instagram post to SERA
      </h1>
      <p className="text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        Instagram serves photos only to a signed-in browser, so SERA cannot fetch them for you from
        its own server. This page takes the other route: your own browser, already signed in, reads
        the post and sends just the media here. Your Instagram login never reaches SERA.
      </p>
      <ol className="flex flex-col gap-3 text-[0.9375rem] text-[var(--color-ink-muted)]">
        <Step n={1}>
          <span className="flex flex-wrap items-center gap-2">
            <span>Drag this to your bookmarks bar, once:</span>
            <BookmarkletLink />
          </span>
        </Step>
        <Step n={2}>Open the photo post or carousel you want on instagram.com.</Step>
        <Step n={3}>Click the bookmark. This page opens with the post ready to download.</Step>
      </ol>
      <p className="text-[0.8125rem] text-[var(--color-ink-faint)]">
        Reels and videos need none of this — paste their link on the{' '}
        <Link href="/" className="text-[var(--color-accent)] hover:opacity-75">
          home page
        </Link>
        .
      </p>
    </section>
  );
}

function Step({ n, children }: { readonly n: number; readonly children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-sunken)] text-[0.75rem] font-medium text-[var(--color-ink)]">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}
