'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, JobError, MediaInfo, PackagingMode } from '@sera/contracts/types';
import { ApiError, cancelJob, createJob, resolveMedia } from '@/lib/api';
import { cx, formatBytes, isRunning, pluralize } from '@/lib/format';
import { initialKind, qualityLabels, resolveSelection, type SelectableKind } from '@/lib/selection';
import { useJob } from '@/lib/use-job';
import { DownloadIcon, SpinnerIcon } from './icons';
import { ErrorPanel, type ErrorAction } from './error-panel';
import { FormatPicker } from './format-picker';
import { ItemPicker } from './item-picker';
import { MediaPreview } from './media-preview';
import { ProgressPanel } from './progress-panel';
import { ResultPanel } from './result-panel';
import { UrlForm } from './url-form';

type Phase = 'idle' | 'analyzing' | 'ready' | 'submitting' | 'running' | 'done';

/** The starting kind, selection and quality for a resolution, chosen the same way everywhere. */
function seedFrom(info: MediaInfo): {
  kind: SelectableKind;
  selectedIds: Set<string>;
  label: string | undefined;
} {
  const kind = initialKind(info);
  const selectedIds = new Set(info.items.map((item) => item.id));
  return { kind, selectedIds, label: qualityLabels(info, kind, selectedIds)[0] };
}

/**
 * The whole interaction, in one component.
 *
 * It is a small state machine rather than a router: paste, analyze, choose, download.
 * Keeping it in one place is what makes the transitions honest — every phase knows what
 * the previous one produced, so the screen can never show a stale preview beside a fresh
 * error, and pressing Escape or changing the link always returns to a coherent state.
 *
 * `initialInfo` is the one entry that skips the paste-and-analyze step: a post the visitor's
 * own browser already read, handed to /import. There is no link to type in that mode, so the
 * form is gone and "Start over" returns to the post rather than to an empty page.
 */
export function Downloader({ initialInfo }: { readonly initialInfo?: MediaInfo } = {}) {
  const importMode = initialInfo !== undefined;
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>(initialInfo ? 'ready' : 'idle');
  const [info, setInfo] = useState<MediaInfo | undefined>(initialInfo);
  const [error, setError] = useState<JobError | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() =>
    initialInfo ? seedFrom(initialInfo).selectedIds : new Set(),
  );
  const [kind, setKind] = useState<SelectableKind>(() =>
    initialInfo ? seedFrom(initialInfo).kind : 'video',
  );
  const [label, setLabel] = useState<string | undefined>(() =>
    initialInfo ? seedFrom(initialInfo).label : undefined,
  );
  const [filename, setFilename] = useState('');
  const [packaging, setPackaging] = useState<PackagingMode>('auto');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const analyzeAbort = useRef<AbortController | undefined>(undefined);
  const { job } = useJob(jobId);

  /* ---------------------------------------------------------------- */

  const reset = useCallback(() => {
    analyzeAbort.current?.abort();
    setError(undefined);
    setJobId(undefined);
    setFilename('');
    setPackaging('auto');
    setShowAdvanced(false);
    // Import mode has nowhere to go back to but the post the browser read: reseed it rather
    // than leaving a blank page with no way to type a link.
    if (initialInfo) {
      const seeded = seedFrom(initialInfo);
      setInfo(initialInfo);
      setKind(seeded.kind);
      setSelectedIds(seeded.selectedIds);
      setLabel(seeded.label);
      setPhase('ready');
      return;
    }
    setPhase('idle');
    setInfo(undefined);
    setSelectedIds(new Set());
    setLabel(undefined);
  }, [initialInfo]);

  const analyze = useCallback(async (raw: string) => {
    analyzeAbort.current?.abort();
    const controller = new AbortController();
    analyzeAbort.current = controller;

    setPhase('analyzing');
    setError(undefined);
    setInfo(undefined);
    setJobId(undefined);

    try {
      const resolved = await resolveMedia(raw, controller.signal);
      if (controller.signal.aborted) return;

      const startingKind = initialKind(resolved);
      const everyItem = new Set(resolved.items.map((item) => item.id));

      setInfo(resolved);
      setKind(startingKind);
      setSelectedIds(everyItem);
      setLabel(qualityLabels(resolved, startingKind, everyItem)[0]);
      setPhase('ready');
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof ApiError
          ? {
              code: caught.code,
              message: caught.message,
              hint: caught.hint,
              retryable: caught.retryable,
            }
          : { code: 'INTERNAL', message: 'Something went wrong.', retryable: true },
      );
      setPhase('idle');
    }
  }, []);

  // Keep the quality choice valid when the format changes.
  useEffect(() => {
    if (!info) return;
    const labels = qualityLabels(info, kind, selectedIds);
    if (!labels.length) {
      setLabel(undefined);
      return;
    }
    setLabel((current) => (current && labels.includes(current) ? current : labels[0]));
  }, [info, kind, selectedIds]);

  const selection = useMemo(
    () => (info ? resolveSelection(info, selectedIds, kind, label) : undefined),
    [info, selectedIds, kind, label],
  );

  const start = useCallback(async () => {
    if (!info || !selection?.optionIds.length) return;
    setPhase('submitting');
    setError(undefined);

    try {
      const created: Job = await createJob({
        infoId: info.id,
        optionIds: selection.optionIds,
        packaging,
        ...(filename.trim() ? { filename: filename.trim() } : {}),
      });
      setJobId(created.id);
      setPhase('running');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? {
              code: caught.code,
              message: caught.message,
              hint: caught.hint,
              retryable: caught.retryable,
            }
          : { code: 'INTERNAL', message: 'Something went wrong.', retryable: true },
      );
      setPhase('ready');
    }
  }, [info, selection, packaging, filename]);

  // Follow the job to its conclusion.
  useEffect(() => {
    if (!job) return;
    if (job.state === 'ready') {
      setPhase('done');
      return;
    }
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired') {
      setError(job.error ?? { code: 'INTERNAL', message: 'The download failed.', retryable: true });
      setPhase('ready');
      setJobId(undefined);
    }
  }, [job]);

  const cancel = useCallback(() => {
    if (jobId) void cancelJob(jobId);
    setJobId(undefined);
    setPhase('ready');
  }, [jobId]);

  // Escape backs out of whatever is on screen, one step at a time.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (phase === 'running') cancel();
      else if (phase === 'ready' || phase === 'done') reset();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, cancel, reset]);

  /* ---------------------------------------------------------------- */

  const busy = phase === 'analyzing';
  const working = phase === 'running' || phase === 'submitting';
  const isCollection = (info?.items.length ?? 0) > 1;

  const errorActions = useMemo<ErrorAction[]>(() => {
    if (!error) return [];
    const actions: ErrorAction[] = [];
    if (error.retryable) {
      actions.push({
        label: 'Try again',
        primary: true,
        onClick: () => {
          setError(undefined);
          if (info) void start();
          else void analyze(url);
        },
      });
    }
    // The one refusal a different route answers: Instagram serves photos only to a signed-in
    // browser, and the visitor has one. /import is where that route is explained and begun.
    if (!importMode && error.code === 'PROVIDER_AUTH_REQUIRED') {
      actions.push({
        label: 'Download from your browser',
        primary: !error.retryable,
        onClick: () => window.open('/import', '_blank', 'noopener'),
      });
    }
    if (info) actions.push({ label: 'Change format', onClick: () => setError(undefined) });
    actions.push({ label: info ? 'Start over' : 'Clear', onClick: reset });
    return actions;
  }, [error, info, url, importMode, analyze, start, reset]);

  return (
    <div className="flex flex-col gap-4">
      {!importMode && (
        <UrlForm
          value={url}
          onChange={(next) => {
            setUrl(next);
            if (info || error) {
              setInfo(undefined);
              setError(undefined);
              setJobId(undefined);
              setPhase('idle');
            }
          }}
          onSubmit={(next) => void analyze(next)}
          busy={busy}
          disabled={working}
        />
      )}

      {busy && <AnalyzingSkeleton />}

      {error && !working && <ErrorPanel error={error} actions={errorActions} />}

      {info && phase !== 'analyzing' && (
        <>
          <MediaPreview info={info} />

          {phase === 'done' && job ? (
            <ResultPanel job={job} onReset={reset} />
          ) : working && job && isRunning(job.state) ? (
            <ProgressPanel job={job} onCancel={cancel} />
          ) : working ? (
            <QueuedNotice />
          ) : (
            <section className="animate-fade-up flex flex-col gap-5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]">
              {isCollection && (
                <ItemPicker
                  info={info}
                  selectedIds={selectedIds}
                  onToggle={(itemId) =>
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      if (next.has(itemId)) next.delete(itemId);
                      else next.add(itemId);
                      return next;
                    })
                  }
                  onSelectAll={(all) =>
                    setSelectedIds(all ? new Set(info.items.map((item) => item.id)) : new Set())
                  }
                />
              )}

              <FormatPicker
                info={info}
                selectedIds={selectedIds}
                kind={kind}
                onKindChange={setKind}
                label={label}
                onLabelChange={setLabel}
              />

              <AdvancedOptions
                open={showAdvanced}
                onToggle={() => setShowAdvanced((open) => !open)}
                filename={filename}
                onFilenameChange={setFilename}
                packaging={packaging}
                onPackagingChange={setPackaging}
                multiple={(selection?.fileCount ?? 0) > 1}
              />

              <button
                type="button"
                onClick={() => void start()}
                disabled={!selection?.optionIds.length}
                className={cx(
                  'flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] text-[0.9375rem] font-medium transition-colors duration-200',
                  'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]',
                  'disabled:cursor-not-allowed disabled:bg-[var(--color-sunken)] disabled:text-[var(--color-ink-faint)]',
                )}
              >
                <DownloadIcon size={17} />
                {selection && selection.fileCount > 1
                  ? `Download ${pluralize(selection.fileCount, 'file')}`
                  : 'Download'}
                {selection?.totalBytes ? (
                  <span className="tabular font-normal opacity-75">
                    · {selection.anyApproximate ? '~' : ''}
                    {formatBytes(selection.totalBytes)}
                  </span>
                ) : null}
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AdvancedOptions({
  open,
  onToggle,
  filename,
  onFilenameChange,
  packaging,
  onPackagingChange,
  multiple,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly filename: string;
  readonly onFilenameChange: (value: string) => void;
  readonly packaging: PackagingMode;
  readonly onPackagingChange: (value: PackagingMode) => void;
  readonly multiple: boolean;
}) {
  return (
    <div className="border-t border-[var(--color-line)] pt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
      >
        <span
          aria-hidden="true"
          className={cx('inline-block transition-transform duration-200', open && 'rotate-90')}
        >
          ›
        </span>
        More options
      </button>

      {open && (
        <div className="mt-3.5 flex flex-col gap-3.5">
          <div>
            <label
              htmlFor="sera-filename"
              className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase"
            >
              Filename
            </label>
            <input
              id="sera-filename"
              type="text"
              value={filename}
              maxLength={200}
              onChange={(event) => onFilenameChange(event.target.value)}
              placeholder="From the post's title"
              className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]"
            />
          </div>

          {multiple && (
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
                Packaging
              </legend>
              <div className="flex gap-1 rounded-xl bg-[var(--color-sunken)] p-1">
                {(
                  [
                    ['auto', 'Automatic'],
                    ['zip', 'One ZIP'],
                    ['individual', 'Separate files'],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={packaging === value}
                    onClick={() => onPackagingChange(value)}
                    className={cx(
                      'flex-1 cursor-pointer rounded-lg px-2 py-2 text-[0.8125rem] font-medium transition-all duration-150',
                      packaging === value
                        ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                        : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}

function QueuedNotice() {
  return (
    <section className="animate-fade-up flex items-center gap-2.5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <SpinnerIcon size={17} className="text-[var(--color-accent)]" />
      <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">Starting…</p>
    </section>
  );
}

function AnalyzingSkeleton() {
  return (
    <section
      aria-hidden="true"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex gap-4">
        <div className="shimmer size-20 shrink-0 rounded-xl bg-[var(--color-sunken)] sm:size-24" />
        <div className="flex flex-1 flex-col justify-center gap-2.5">
          <div className="shimmer h-3.5 w-3/4 rounded bg-[var(--color-sunken)]" />
          <div className="shimmer h-3 w-1/2 rounded bg-[var(--color-sunken)]" />
          <div className="shimmer h-3 w-1/4 rounded bg-[var(--color-sunken)]" />
        </div>
      </div>
    </section>
  );
}
