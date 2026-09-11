'use client';

import { useEffect, useRef, useState } from 'react';
import type { JobError, MediaInfo } from '@sera/contracts/types';
import Link from 'next/link';
import { ApiError, importMedia } from '@/lib/api';
import { openImportChannel, readImportFragment } from '@/lib/import-handshake';
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

/** "instagram.com/p/<code>" from the post's canonical URL, for the provenance line. */
function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

export function ImportClient() {
  const [phase, setPhase] = useState<Phase>('waiting');
  const [info, setInfo] = useState<MediaInfo>();
  const [error, setError] = useState<JobError>();
  // Read the fragment at most once. reading it clears the hash from history, and StrictMode runs
  // this effect twice in development — without the guard the second run would see the cleared hash
  // and fall through to the idle page. In production the effect runs once and this is a no-op.
  const fragment = useRef<{ read: boolean; value: ReturnType<typeof readImportFragment> }>({
    read: false,
    value: undefined,
  });

  useEffect(() => {
    const controller = new AbortController();
    if (!fragment.current.read) {
      fragment.current = { read: true, value: readImportFragment(window) };
    }

    const onResolved = (resolved: MediaInfo): void => {
      if (controller.signal.aborted) return;
      setInfo(resolved);
      setPhase('ready');
    };
    const showError = (caught: unknown): void => {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof ApiError
          ? {
              code: caught.code,
              message: caught.message,
              ...(caught.hint ? { hint: caught.hint } : {}),
              retryable: caught.retryable,
            }
          : { code: 'INTERNAL', message: 'Something went wrong.', retryable: true },
      );
      setPhase('error');
    };

    // Transport v2: the bookmarklet read the post and navigated this tab here with it in the
    // URL fragment. The mobile-safe path, and now the default — no popup, no postMessage.
    const fragmentResult = fragment.current.value;
    if (fragmentResult) {
      if (fragmentResult.ok) {
        setPhase('waiting');
        importMedia(fragmentResult.request, controller.signal).then(onResolved).catch(showError);
      } else {
        // Refused before any POST. Off-CDN media on a crafted link would otherwise cost this
        // browser's own address an abuse strike; an oversized fragment is a broken or hostile link.
        setError(
          fragmentResult.reason === 'too-large'
            ? {
                code: 'TOO_LARGE',
                message: 'That import link is too large to open.',
                hint: 'Open the post on Instagram and send it again.',
                retryable: false,
              }
            : {
                code: 'BLOCKED_ADDRESS',
                message: 'That link points at media somewhere other than Instagram.',
                hint: 'Open the post on Instagram and send it from there.',
                retryable: false,
              },
        );
        setPhase('error');
      }
      return () => controller.abort();
    }

    // Transport v1: opened as a popup, post arrives over postMessage. Kept for a transition
    // while old bookmarklets are still installed. No opener means someone navigated here
    // directly, so explain the page at once rather than wait out the handshake timeout.
    if (!window.opener) {
      setPhase('idle');
      return () => controller.abort();
    }

    const channel = openImportChannel(window);
    channel.received
      .then((request) => importMedia(request, controller.signal))
      .then(onResolved)
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        // A message that arrived and was refused is a real error; nothing arriving at all is
        // just a page opened without a post, which explains itself.
        if (caught instanceof ApiError) showError(caught);
        else setPhase('idle');
      });

    return () => {
      channel.close();
      controller.abort();
    };
  }, []);

  if (phase === 'ready' && info) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-3 py-8">
        {/* Provenance: a crafted /import link is now possible, so say plainly which post this is,
            above everything, before any download. Plain text; the URL was validated server-side. */}
        <p className="text-[0.8125rem] text-[var(--color-ink-faint)]">
          From <span className="text-[var(--color-ink-muted)]">{sourceLabel(info.url)}</span>
        </p>
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
    <section className="animate-fade-up mx-auto flex w-full max-w-[34rem] flex-1 flex-col justify-center gap-5 py-10 sm:py-12">
      <h1 className="text-lg font-medium text-[var(--color-ink)]">
        Send an Instagram post to SERA
      </h1>
      <p className="text-[0.9375rem] leading-relaxed text-[var(--color-ink-muted)]">
        Instagram serves photos only to a signed-in browser, so SERA cannot fetch them for you from
        its own server. This page takes the other route: your own browser, already signed in, reads
        the post and sends just the media here. Your Instagram login never reaches SERA.
      </p>

      {/* The one thing a phone user most often misses, so it leads and stands out. */}
      <div className="rounded-[var(--radius-panel)] border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/8 px-4 py-3.5">
        <p className="text-[0.9375rem] leading-relaxed text-[var(--color-ink)]">
          <span className="font-semibold">First — sign in to instagram.com in this browser.</span>{' '}
          <span className="text-[var(--color-ink-muted)]">
            The Instagram app’s login doesn’t carry over; you have to be logged in on the website
            itself, in the same browser you run SERA from. From the app, tap Share → Copy link and
            open that link in your browser (on iPhone, if it opens the app, paste the link into
            Safari’s address bar).
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 sm:p-5">
        <p className="text-[0.8125rem] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
          Then install it, once
        </p>
        <BookmarkletLink />
        <div className="flex flex-col gap-2.5 text-[0.8125rem] leading-relaxed text-[var(--color-ink-muted)]">
          <p>
            <span className="font-medium text-[var(--color-ink)]">On a computer:</span> drag the
            button to your bookmarks bar. Click it while you’re viewing a post.
          </p>
          <p>
            <span className="font-medium text-[var(--color-ink)]">On iPhone (Safari):</span> tap{' '}
            <span className="font-medium">Copy code</span>, bookmark this page (Share → Add
            Bookmark) and name it <span className="font-medium">SERA</span>, then edit that bookmark
            and replace its address with the copied code.
          </p>
          <p>
            <span className="font-medium text-[var(--color-ink)]">On Android (Chrome):</span> tap{' '}
            <span className="font-medium">Copy code</span>, bookmark any page, then edit it, name it{' '}
            <span className="font-medium">SERA</span>, and paste the code as the address.
          </p>
        </div>
      </div>

      <ol className="flex flex-col gap-3 text-[0.9375rem] text-[var(--color-ink-muted)]">
        <Step n={1}>
          Open the photo post or carousel on instagram.com, signed in <span>(see above)</span>.
        </Step>
        <Step n={2}>
          Run the <span className="font-medium">SERA</span> bookmark:
          <span className="mt-1 block text-[0.8125rem] text-[var(--color-ink-faint)]">
            On a computer, click it in the bookmarks bar. On a phone, tap the address bar, type{' '}
            <span className="font-medium">SERA</span>, and tap the bookmark.
          </span>
        </Step>
        <Step n={3}>The tab turns into SERA with the post ready to download.</Step>
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
