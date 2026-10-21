'use client';

import { useEffect, useRef, useState } from 'react';
import type { Job } from '@sera/contracts/types';
import { CheckIcon, CopyIcon, DownloadIcon, PlayIcon } from './icons';
import { formatBytes, pluralize } from '@/lib/format';

function isSafeDownloadPath(path: string): boolean {
  return path.startsWith('/api/') && !path.startsWith('//');
}

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

function mediaKindFromFilename(name: string): 'video' | 'audio' | 'image' | undefined {
  const lower = name.toLowerCase();
  if (/\.(mp4|webm|mov|mkv)$/.test(lower)) return 'video';
  if (/\.(mp3|m4a|aac|opus|ogg|wav|flac)$/.test(lower)) return 'audio';
  if (/\.(jpg|jpeg|png|webp|gif)$/.test(lower)) return 'image';
  return undefined;
}

export function ResultPanel({ job, onReset }: { readonly job: Job; readonly onReset: () => void }) {
  const result = job.result;
  const startedFor = useRef<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [copiedMain, setCopiedMain] = useState(false);
  const [copiedFile, setCopiedFile] = useState<string | undefined>(undefined);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (
      !result ||
      startedFor.current === result.downloadPath ||
      !isSafeDownloadPath(result.downloadPath)
    ) {
      return;
    }
    startedFor.current = result.downloadPath;
    window.location.assign(result.downloadPath);
  }, [result]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const copyMainLink = async (): Promise<void> => {
    if (!result || !isSafeDownloadPath(result.downloadPath)) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl(result.downloadPath));
      setCopiedMain(true);
      setTimeout(() => setCopiedMain(false), 2000);
    } catch {}
  };

  const copyItemLink = async (path: string): Promise<void> => {
    if (!isSafeDownloadPath(path)) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl(path));
      setCopiedFile(path);
      setTimeout(() => setCopiedFile(undefined), 2000);
    } catch {}
  };

  if (!result) return null;

  const expires = new Date(result.expiresAt);
  const minutesLeft = Math.max(0, Math.round((expires.getTime() - now) / 60_000));
  const previewKind = !result.isArchive ? mediaKindFromFilename(result.filename) : undefined;

  return (
    <section
      aria-label="Download ready"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-success)]/12 text-[var(--color-success)]">
            <CheckIcon size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[0.9375rem] font-medium text-[var(--color-ink)]">Ready</h2>
            <p className="truncate text-[0.8125rem] text-[var(--color-ink-muted)]">
              {result.filename} · {formatBytes(result.sizeBytes)}
            </p>
          </div>
        </div>
        {previewKind && (
          <button
            type="button"
            onClick={() => setShowPreview((prev) => !prev)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          >
            <PlayIcon size={13} />
            {showPreview ? 'Hide preview' : 'Preview'}
          </button>
        )}
      </div>

      {showPreview && previewKind === 'video' && (
        <div className="mt-3 overflow-hidden rounded-xl border border-[var(--color-line)] bg-black">
          <video
            controls
            preload="metadata"
            src={result.downloadPath}
            className="max-h-[360px] w-full"
          />
        </div>
      )}
      {showPreview && previewKind === 'audio' && (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
          <audio controls preload="metadata" src={result.downloadPath} className="w-full" />
        </div>
      )}
      {showPreview && previewKind === 'image' && (
        <div className="mt-3 flex justify-center overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-2">
          <img
            src={result.downloadPath}
            alt={result.filename}
            className="max-h-[360px] rounded-lg object-contain"
          />
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <a
          href={isSafeDownloadPath(result.downloadPath) ? result.downloadPath : '#'}
          download
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)] text-[0.9375rem] font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          <DownloadIcon size={17} />
          {result.isArchive ? 'Download ZIP' : 'Download'}
        </a>

        <button
          type="button"
          onClick={() => void copyMainLink()}
          aria-label="Copy download link"
          className="flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-input)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[0.875rem] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)]"
        >
          {copiedMain ? (
            <>
              <CheckIcon size={15} className="text-[var(--color-success)]" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <CopyIcon size={15} className="text-[var(--color-ink-muted)]" />
              <span>Copy link</span>
            </>
          )}
        </button>
      </div>

      {result.files && result.files.length > 1 && (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]">
            <span className="transition-transform group-open:rotate-90">›</span>
            {pluralize(result.files.length, 'file')} individually
          </summary>
          <ul className="mt-2 flex flex-col gap-1 border-l border-[var(--color-line)] pl-3">
            {result.files.map((file) => (
              <li
                key={file.downloadPath || file.name}
                className="flex items-center justify-between gap-2 py-1"
              >
                <a
                  href={isSafeDownloadPath(file.downloadPath) ? file.downloadPath : '#'}
                  download
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-accent)]"
                >
                  <span className="truncate">{file.name}</span>
                  <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </a>
                <button
                  type="button"
                  onClick={() => void copyItemLink(file.downloadPath)}
                  aria-label={`Copy link for ${file.name}`}
                  title="Copy link"
                  className="grid size-7 shrink-0 cursor-pointer place-items-center rounded text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
                >
                  {copiedFile === file.downloadPath ? (
                    <CheckIcon size={13} className="text-[var(--color-success)]" />
                  ) : (
                    <CopyIcon size={13} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--color-line)] pt-3">
        <p className="text-xs text-[var(--color-ink-faint)]">
          {minutesLeft > 0
            ? `Deleted from the server in about ${pluralize(minutesLeft, 'minute')}.`
            : 'Deleted from the server shortly.'}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 cursor-pointer rounded-md text-[0.8125rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          New link
        </button>
      </div>
    </section>
  );
}
