'use client';

import { useState } from 'react';
import type { MediaInfo } from '@sera/contracts/types';
import { AudioIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatDuration, pluralize } from '@/lib/format';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  unknown: VideoIcon,
} as const;

/**
 * Confirmation that SERA found the right thing.
 *
 * Its whole job is to let someone recognise their link before committing to a download,
 * so the thumbnail is large, the title is not truncated to one line, and the provider is
 * named. Everything else — view counts, descriptions, ids — is left out; it is not what
 * anyone is checking for.
 */
export function MediaPreview({ info }: { readonly info: MediaInfo }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const primary = info.items[0];
  const Icon = KIND_ICON[primary?.kind ?? 'unknown'];
  const showThumbnail = Boolean(info.thumbnail) && !thumbnailFailed;

  const subtitle = [
    info.author,
    info.duration ? formatDuration(info.duration) : undefined,
    info.items.length > 1 ? pluralize(info.items.length, 'item') : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label="Detected media"
      className="animate-fade-up overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-lift)]"
    >
      <div className="flex gap-4 p-4">
        <div
          className={cx(
            'relative grid shrink-0 place-items-center overflow-hidden rounded-xl bg-[var(--color-sunken)]',
            'size-20 sm:size-24',
          )}
        >
          {/* A plain img, not next/image: the source is a proxied API path whose
              dimensions are unknown, so the optimizer would add a round trip and no
              benefit. */}
          {showThumbnail ? (
            <img
              src={info.thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbnailFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <Icon size={26} className="text-[var(--color-ink-faint)]" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <h2 className="text-[0.9375rem] leading-snug font-medium text-balance text-[var(--color-ink)] sm:text-base">
            {info.title}
          </h2>
          {subtitle && (
            <p className="truncate text-[0.8125rem] text-[var(--color-ink-muted)]">{subtitle}</p>
          )}
          <p className="text-xs text-[var(--color-ink-faint)]">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full bg-[var(--color-success)]"
              />
              {info.providerLabel}
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
