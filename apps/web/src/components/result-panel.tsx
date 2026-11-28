'use client';

import { useEffect, useRef, useState } from 'react';
import type { Job } from '@sera/contracts/types';
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon, PlayIcon } from './icons';
import { formatBytes, isSafeDownloadPath, pluralize } from '@/lib/format';

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

function mediaKindFromFilename(name: string): 'video' | 'audio' | 'image' | undefined {
  const lower = name.toLowerCase();
  if (/\.(mp4|webm|mov|mkv)$/.test(lower)) return 'video';
  if (/\.(mp3|m4a|aac|opus|ogg|wav|flac)$/.test(lower)) return 'audio';
  if (/\.(jpg|jpeg|png|webp|gif|avif)$/.test(lower)) return 'image';
  return undefined;
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

export function ResultPanel({
  job,
  onReset,
  onDownloadAgain,
  downloadAgainLabel = 'Analyze again',
  hasNextInBatch = false,
  batchNextLabel,
  onNextInBatch,
}: {
  readonly job: Job;
  readonly onReset: () => void;
  readonly onDownloadAgain?: () => void;
  readonly downloadAgainLabel?: string;
  readonly hasNextInBatch?: boolean;
  readonly batchNextLabel?: string;
  readonly onNextInBatch?: () => void;
}) {
  const result = job.result;
  const startedFor = useRef<string | undefined>(undefined);
  const copiedMainTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copiedFileTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [copiedMain, setCopiedMain] = useState(false);
  const [copiedFile, setCopiedFile] = useState<string | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const expiresMs = result ? Date.parse(result.expiresAt) : Number.NaN;
  const expired = result ? Number.isNaN(expiresMs) || now >= expiresMs : false;

  useEffect(() => {
    setShowPreview(false);
    setPreviewError(false);
    setCopiedMain(false);
    setCopiedFile(undefined);
    setCopyStatus('');
    setCopyFailed(false);
    setNow(Date.now());
  }, [job.id, result?.downloadPath]);

  useEffect(() => {
    return () => {
      if (copiedMainTimer.current) clearTimeout(copiedMainTimer.current);
      if (copiedFileTimer.current) clearTimeout(copiedFileTimer.current);
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    };
  }, []);

  useEffect(() => {
    if (
      !result ||
      expired ||
      startedFor.current === result.downloadPath ||
      !isSafeDownloadPath(result.downloadPath)
    ) {
      return;
    }
    startedFor.current = result.downloadPath;
    const a = document.createElement('a');
    a.href = result.downloadPath;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [result, expired]);

  useEffect(() => {
    if (!result || expired) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.visibilityState !== 'visible') return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 30_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [result, expired]);

  const announceCopy = (message: string, isFailure: boolean) => {
    setCopyStatus(message);
    setCopyFailed(isFailure);
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = setTimeout(() => {
      setCopyStatus('');
      setCopyFailed(false);
    }, 3_000);
  };

  const copyMainLink = async (): Promise<void> => {
    if (!result || expired || !isSafeDownloadPath(result.downloadPath)) return;
    const ok = await copyTextWithFallback(absoluteUrl(result.downloadPath));
    if (ok) {
      setCopiedMain(true);
      announceCopy('Download link copied to clipboard.', false);
      if (copiedMainTimer.current) clearTimeout(copiedMainTimer.current);
      copiedMainTimer.current = setTimeout(() => setCopiedMain(false), 2000);
    } else {
      announceCopy(
        "Couldn't copy automatically. Right-click the Download button to copy the link.",
        true,
      );
    }
  };

  const copyItemLink = async (path: string, filename: string): Promise<void> => {
    if (expired || !isSafeDownloadPath(path)) return;
    const ok = await copyTextWithFallback(absoluteUrl(path));
    if (ok) {
      setCopiedFile(path);
      announceCopy(`Download link copied for ${filename}.`, false);
      if (copiedFileTimer.current) clearTimeout(copiedFileTimer.current);
      copiedFileTimer.current = setTimeout(() => setCopiedFile(undefined), 2000);
    } else {
      announceCopy(`Couldn't copy link for ${filename}.`, true);
    }
  };

  if (!result) return null;

  const minutesLeft = expired ? 0 : Math.max(1, Math.round((expiresMs - now) / 60_000));
  const previewKind = !result.isArchive ? mediaKindFromFilename(result.filename) : undefined;
  const safeMainUrl =
    !expired && isSafeDownloadPath(result.downloadPath) ? result.downloadPath : undefined;
  const isMultiIndividual = !result.isArchive && Boolean(result.files && result.files.length > 1);
  const totalBytes =
    isMultiIndividual && result.files
      ? result.files.reduce((sum, file) => sum + file.sizeBytes, 0)
      : result.sizeBytes;
  const headerName =
    isMultiIndividual && result.files
      ? `${pluralize(result.files.length, 'file')} · ${result.filename}`
      : result.filename;

  return (
    <section
      aria-label={expired ? 'Download expired' : 'Download ready'}
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className={
              expired
                ? 'grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-danger-wash)] text-[var(--color-danger)]'
                : 'grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-success)]/12 text-[var(--color-success)]'
            }
          >
            {expired ? <AlertIcon size={16} /> : <CheckIcon size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[0.9375rem] font-medium text-[var(--color-ink)]">
              {expired ? 'Download expired' : 'Ready'}
            </h2>
            <p className="flex items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)]">
              <span className="truncate" title={headerName}>
                {headerName}
              </span>
              <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
                · {formatBytes(totalBytes)}
              </span>
            </p>
          </div>
        </div>
        {previewKind && safeMainUrl && (
          <button
            type="button"
            onClick={() => {
              setPreviewError(false);
              setShowPreview((prev) => !prev);
            }}
            className="flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.8125rem] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          >
            <PlayIcon size={13} />
            {showPreview ? 'Hide preview' : 'Preview'}
          </button>
        )}
      </div>

      {showPreview && safeMainUrl && (
        <div className="mt-3">
          {previewError ? (
            <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-3.5 py-3 text-[0.8125rem] text-[var(--color-ink-muted)]">
              In-browser preview isn&apos;t supported for this format. Use Download instead.
            </p>
          ) : previewKind === 'video' ? (
            <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-black">
              <video
                controls
                preload="metadata"
                src={safeMainUrl}
                onError={() => setPreviewError(true)}
                className="max-h-[360px] w-full"
              />
            </div>
          ) : previewKind === 'audio' ? (
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
              <audio
                controls
                preload="metadata"
                src={safeMainUrl}
                onError={() => setPreviewError(true)}
                className="w-full"
              />
            </div>
          ) : previewKind === 'image' ? (
            <div className="flex justify-center overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-2">
              <img
                src={safeMainUrl}
                alt={result.filename}
                onError={() => setPreviewError(true)}
                className="max-h-[360px] rounded-lg object-contain"
              />
            </div>
          ) : null}
        </div>
      )}

      {expired ? (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] p-3.5">
          <p className="text-[0.8125rem] text-[var(--color-ink-muted)]">
            This file has expired and was deleted from the server.
          </p>
          {onDownloadAgain && (
            <button
              type="button"
              onClick={onDownloadAgain}
              className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)] text-[0.9375rem] font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              {downloadAgainLabel}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {safeMainUrl ? (
            <a
              href={safeMainUrl}
              download={result.filename}
              className="flex h-12 min-w-[11rem] flex-1 items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)] px-4 text-[0.9375rem] font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              <DownloadIcon size={17} />
              {result.isArchive
                ? 'Download ZIP'
                : isMultiIndividual
                  ? 'Download 1st file'
                  : 'Download'}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="flex h-12 min-w-[11rem] flex-1 cursor-not-allowed items-center justify-center gap-2 rounded-[var(--radius-input)] bg-[var(--color-accent)]/50 px-4 text-[0.9375rem] font-medium text-[var(--color-accent-ink)]"
            >
              <DownloadIcon size={17} />
              Download unavailable
            </button>
          )}

          <button
            type="button"
            onClick={() => void copyMainLink()}
            disabled={!safeMainUrl}
            aria-label="Copy download link"
            title="Temporary link tied to your current network"
            className="flex h-12 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-input)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[0.875rem] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-sunken)] disabled:cursor-not-allowed disabled:opacity-50"
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
      )}

      {copyFailed && copyStatus && (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {copyStatus}
        </p>
      )}

      {!expired && result.files && result.files.length > 1 && (
        <details open={!result.isArchive} className="group mt-3">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]">
            <span className="transition-transform group-open:rotate-90">›</span>
            {pluralize(result.files.length, 'file')} individually
          </summary>
          <ul className="mt-2 flex flex-col gap-1 border-l border-[var(--color-line)] pl-3">
            {result.files.map((file) => {
              const safeItemUrl = isSafeDownloadPath(file.downloadPath)
                ? file.downloadPath
                : undefined;
              return (
                <li
                  key={file.downloadPath || file.name}
                  className="flex items-center justify-between gap-2 py-0.5"
                >
                  {safeItemUrl ? (
                    <a
                      href={safeItemUrl}
                      download={file.name}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-accent)]"
                    >
                      <span className="truncate">{file.name}</span>
                      <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
                        {formatBytes(file.sizeBytes)}
                      </span>
                    </a>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5 text-[0.8125rem] text-[var(--color-ink-faint)]">
                      <span className="truncate">{file.name}</span>
                      <span className="tabular shrink-0">{formatBytes(file.sizeBytes)}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={!safeItemUrl}
                    onClick={() => void copyItemLink(file.downloadPath, file.name)}
                    aria-label={`Copy link for ${file.name}`}
                    title="Copy temporary link (works from this network)"
                    className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copiedFile === file.downloadPath ? (
                      <CheckIcon size={14} className="text-[var(--color-success)]" />
                    ) : (
                      <CopyIcon size={14} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
        <p className="text-xs text-[var(--color-ink-faint)]">
          {expired
            ? 'Removed from temporary server storage.'
            : `Deleted in ~${pluralize(minutesLeft, 'minute')} · Links are tied to this network.`}
        </p>
        <div className="flex items-center gap-3">
          {hasNextInBatch && onNextInBatch && (
            <button
              type="button"
              onClick={onNextInBatch}
              className="inline-flex min-h-9 shrink-0 cursor-pointer items-center rounded-md bg-[var(--color-accent-wash)] px-2.5 text-[0.8125rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80"
            >
              {batchNextLabel ?? 'Next in batch →'}
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="inline-flex min-h-9 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-[0.8125rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
          >
            New link
          </button>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {copyStatus || (expired ? 'Download expired.' : `Download is ready: ${result.filename}`)}
      </p>
    </section>
  );
}
