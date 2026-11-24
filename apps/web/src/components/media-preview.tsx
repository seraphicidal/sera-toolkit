'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { MediaInfo } from '@sera/contracts/types';
import { AudioIcon, FileIcon, GifIcon, ImageIcon, VideoIcon } from './icons';
import { cx, formatDuration, isSafeDownloadPath, pluralize } from '@/lib/format';

const KIND_ICON = {
  video: VideoIcon,
  audio: AudioIcon,
  image: ImageIcon,
  gif: GifIcon,
  file: FileIcon,
  unknown: VideoIcon,
} as const;

export const MediaPreview = memo(function MediaPreview({ info }: { readonly info: MediaInfo }) {
  const [retries, setRetries] = useState(0);
  const [failedThumbnail, setFailedThumbnail] = useState<string>();
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const primary = info.items[0];
  const Icon = KIND_ICON[primary?.kind ?? 'unknown'];
  const safeThumbnail =
    info.thumbnail && isSafeDownloadPath(info.thumbnail) ? info.thumbnail : undefined;
  const showThumbnail = Boolean(safeThumbnail) && failedThumbnail !== safeThumbnail;

  useEffect(() => {
    setRetries(0);
    setFailedThumbnail(undefined);
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [safeThumbnail]);

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
          {showThumbnail ? (
            <img
              src={
                retries > 0 && safeThumbnail
                  ? `${safeThumbnail}${safeThumbnail.includes('?') ? '&' : '?'}retry=${retries}`
                  : safeThumbnail
              }
              alt=""
              loading="eager"
              fetchPriority="high"
              decoding="async"
              onError={() => {
                if (retries < 1) {
                  if (retryTimer.current) clearTimeout(retryTimer.current);
                  retryTimer.current = setTimeout(() => setRetries((r) => r + 1), 1000);
                } else {
                  setFailedThumbnail(safeThumbnail);
                }
              }}
              className="size-full object-cover"
            />
          ) : (
            <Icon size={26} className="text-[var(--color-ink-faint)]" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <h2
            title={info.title}
            className="line-clamp-3 text-[0.9375rem] leading-snug font-medium text-balance text-[var(--color-ink)] sm:text-base"
          >
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
});
