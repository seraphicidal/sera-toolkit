'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Job,
  JobError,
  MediaInfo,
  PackagingMode,
  ServiceInfo,
  SubtitleFormat,
} from '@sera/contracts/types';
import { ApiError, cancelJob, createJob, getServiceInfo, resolveMedia } from '@/lib/api';
import { cx, formatBytes, formatDuration, pluralize, stepRadio } from '@/lib/format';
import { addToHistory } from '@/lib/history';
import {
  availableKinds,
  initialKind,
  qualityLabels,
  resolveSelection,
  selectItemsUpToMax,
  type SelectableKind,
} from '@/lib/selection';
import { urlFromFragment } from '@/lib/share';
import {
  subtitleChoices,
  subtitleRequest,
  trackValue,
  type SubtitleChoices,
} from '@/lib/subtitles';
import { endPlaceholder, summarizeTrim, type TrimSummary } from '@/lib/trim';
import { ActiveJobPanel } from './active-job-panel';
import { DownloadIcon } from './icons';
import { ErrorPanel, type ErrorAction } from './error-panel';
import { FormatPicker } from './format-picker';
import { ItemPicker } from './item-picker';
import { MediaPreview } from './media-preview';
import { RecentDownloads } from './recent-downloads';
import { MAX_BATCH_URLS, UrlForm } from './url-form';

type Phase = 'idle' | 'analyzing' | 'ready' | 'submitting' | 'running' | 'done';
type BatchItemStatus = 'pending' | 'ready' | 'done' | 'failed';

const PREFERRED_KIND_KEY = 'sera-preferred-kind';
const DEFAULT_MAX_SELECTED_ITEMS = 25;

function getPreferredKind(): SelectableKind | undefined {
  try {
    const saved = localStorage.getItem(PREFERRED_KIND_KEY);
    if (
      saved === 'video' ||
      saved === 'audio' ||
      saved === 'image' ||
      saved === 'gif' ||
      saved === 'file'
    ) {
      return saved;
    }
  } catch {}
  return undefined;
}

function setPreferredKind(kind: SelectableKind): void {
  try {
    localStorage.setItem(PREFERRED_KIND_KEY, kind);
  } catch {}
}

function seedFrom(
  info: MediaInfo,
  maxItems: number,
): {
  kind: SelectableKind;
  selectedIds: Set<string>;
  label: string | undefined;
} {
  const selectedIds = selectItemsUpToMax(info.items, maxItems);
  const available = availableKinds(info, selectedIds);
  const preferred = getPreferredKind();
  const kind = preferred && available.includes(preferred) ? preferred : initialKind(info);
  return { kind, selectedIds, label: qualityLabels(info, kind, selectedIds)[0] };
}

export function Downloader({
  initialInfo,
  onResetImport,
}: {
  readonly initialInfo?: MediaInfo;
  readonly onResetImport?: () => void;
} = {}) {
  const router = useRouter();
  const importMode = initialInfo !== undefined;
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | undefined>(undefined);
  const maxSelectedItems = serviceInfo?.limits.maxItemsPerJob
    ? Math.max(1, Math.min(200, serviceInfo.limits.maxItemsPerJob))
    : DEFAULT_MAX_SELECTED_ITEMS;

  const initialSeed = useMemo(
    () => (initialInfo ? seedFrom(initialInfo, DEFAULT_MAX_SELECTED_ITEMS) : undefined),
    [initialInfo],
  );
  const [url, setUrl] = useState('');
  const [batchQueue, setBatchQueue] = useState<readonly string[]>([]);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchStatuses, setBatchStatuses] = useState<readonly BatchItemStatus[]>([]);
  const [phase, setPhase] = useState<Phase>(initialInfo ? 'ready' : 'idle');
  const [info, setInfo] = useState<MediaInfo | undefined>(initialInfo);
  const [error, setError] = useState<JobError | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();
  const [initialJob, setInitialJob] = useState<Job | undefined>();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => initialSeed?.selectedIds ?? new Set(),
  );
  const [kind, setKind] = useState<SelectableKind>(() => initialSeed?.kind ?? 'video');
  const [label, setLabel] = useState<string | undefined>(() => initialSeed?.label);
  const [filename, setFilename] = useState('');
  const [trimStart, setTrimStart] = useState('');
  const [trimEnd, setTrimEnd] = useState('');
  const [packaging, setPackaging] = useState<PackagingMode>('auto');
  const [subtitleTrack, setSubtitleTrack] = useState('');
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>('embed');
  const [subtitlesOnly, setSubtitlesOnly] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const analyzeAbort = useRef<AbortController | undefined>(undefined);
  const submitAbort = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(0);
  const sharedUrlRef = useRef<{ read: boolean; url: string | undefined }>({
    read: false,
    url: undefined,
  });
  const maxItemsRef = useRef(maxSelectedItems);
  maxItemsRef.current = maxSelectedItems;
  const activeJobIdRef = useRef<string | undefined>(jobId);
  activeJobIdRef.current = jobId;
  const activePhaseRef = useRef<Phase>(phase);
  activePhaseRef.current = phase;
  const batchIndexRef = useRef(batchIndex);
  batchIndexRef.current = batchIndex;

  useEffect(() => {
    const controller = new AbortController();
    getServiceInfo(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setServiceInfo(loaded);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
      submitAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!info) return;
    setSelectedIds((current) => {
      if (current.size <= maxSelectedItems) return current;
      const clamped = new Set<string>();
      for (const item of info.items) {
        if (current.has(item.id)) {
          clamped.add(item.id);
          if (clamped.size >= maxSelectedItems) break;
        }
      }
      return clamped;
    });
  }, [info, maxSelectedItems]);

  const updateBatchStatus = useCallback((idx: number, status: BatchItemStatus) => {
    setBatchStatuses((prev) => {
      if (idx < 0 || idx >= prev.length || prev[idx] === status) return prev;
      const next = [...prev];
      next[idx] = status;
      return next;
    });
  }, []);

  const reset = useCallback(
    (preserveBatch = false) => {
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
      submitAbort.current?.abort();
      setError(undefined);
      setJobId(undefined);
      setInitialJob(undefined);
      setFilename('');
      setTrimStart('');
      setTrimEnd('');
      setSubtitleTrack('');
      setSubtitleFormat('embed');
      setSubtitlesOnly(false);
      setPackaging('auto');
      setShowAdvanced(false);
      if (initialInfo) {
        const seeded = seedFrom(initialInfo, maxItemsRef.current);
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
      if (!preserveBatch) {
        setBatchQueue([]);
        setBatchIndex(0);
        setBatchStatuses([]);
      }
    },
    [initialInfo],
  );

  const clearAll = useCallback(() => {
    if (importMode) {
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
      submitAbort.current?.abort();
      if (onResetImport) onResetImport();
      else router.push('/');
      return;
    }
    reset(false);
    setUrl('');
  }, [importMode, onResetImport, reset, router]);

  const handleNewLink = useCallback(() => {
    if (importMode) {
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
      submitAbort.current?.abort();
      router.push('/');
      return;
    }
    clearAll();
  }, [importMode, clearAll, router]);

  const analyze = useCallback(
    async (raw: string, activeBatchIdx?: number) => {
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
      submitAbort.current?.abort();
      const controller = new AbortController();
      analyzeAbort.current = controller;

      setPhase('analyzing');
      setError(undefined);
      setInfo(undefined);
      setJobId(undefined);
      setInitialJob(undefined);
      setFilename('');
      setTrimStart('');
      setTrimEnd('');
      setSubtitleTrack('');
      setSubtitleFormat('embed');
      setSubtitlesOnly(false);
      setPackaging('auto');
      setShowAdvanced(false);

      try {
        const resolved = await resolveMedia(raw, controller.signal);
        if (controller.signal.aborted) return;

        const everyItem = selectItemsUpToMax(resolved.items, maxItemsRef.current);
        const available = availableKinds(resolved, everyItem);
        const preferred = getPreferredKind();
        const startingKind =
          preferred && available.includes(preferred) ? preferred : initialKind(resolved);

        setInfo(resolved);
        setKind(startingKind);
        setSelectedIds(everyItem);
        setLabel(qualityLabels(resolved, startingKind, everyItem)[0]);
        setPhase('ready');
        if (activeBatchIdx !== undefined) updateBatchStatus(activeBatchIdx, 'ready');
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
        if (activeBatchIdx !== undefined) updateBatchStatus(activeBatchIdx, 'failed');
      }
    },
    [updateBatchStatus],
  );

  useEffect(() => {
    if (importMode) return;
    if (!sharedUrlRef.current.read) {
      const shared = urlFromFragment(window.location.hash);
      sharedUrlRef.current = { read: true, url: shared };
      if (shared) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
    const shared = sharedUrlRef.current.url;
    if (!shared) return;
    setUrl(shared);
    void analyze(shared);
    return () => {
      analyzeAbort.current?.abort();
    };
  }, [importMode, analyze]);

  const again = useCallback(
    (link: string) => {
      const currentJobId = activeJobIdRef.current;
      const currentPhase = activePhaseRef.current;
      if (currentJobId && (currentPhase === 'running' || currentPhase === 'submitting')) {
        void cancelJob(currentJobId);
      }
      setBatchQueue([]);
      setBatchIndex(0);
      setBatchStatuses([]);
      setUrl(link);
      void analyze(link);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [analyze],
  );

  const activeKinds = useMemo(
    () => (info ? availableKinds(info, selectedIds) : []),
    [info, selectedIds],
  );
  const pickerKind: SelectableKind = activeKinds.includes(kind) ? kind : (activeKinds[0] ?? kind);
  const activeLabels = useMemo(
    () => (info ? qualityLabels(info, pickerKind, selectedIds) : []),
    [info, pickerKind, selectedIds],
  );
  const effectiveLabel = label && activeLabels.includes(label) ? label : activeLabels[0];

  const handleToggleItem = useCallback((itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else if (next.size < maxItemsRef.current) {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const handleSelectAllItems = useCallback(
    (all: boolean) => {
      setSelectedIds(all && info ? selectItemsUpToMax(info.items, maxItemsRef.current) : new Set());
    },
    [info],
  );

  const selection = useMemo(
    () => (info ? resolveSelection(info, selectedIds, pickerKind, effectiveLabel) : undefined),
    [info, selectedIds, pickerKind, effectiveLabel],
  );

  const singleItem =
    info && selection?.fileCount === 1
      ? (info.items.find((item) => item.options.some((o) => o.id === selection.optionIds[0])) ??
        info.items.find((item) => selectedIds.has(item.id)))
      : undefined;

  const singleItemId = singleItem?.id;
  const prevSingleItemId = useRef<string | undefined>(singleItemId);
  useEffect(() => {
    if (prevSingleItemId.current !== singleItemId) {
      prevSingleItemId.current = singleItemId;
      setSubtitleTrack('');
      setSubtitlesOnly(false);
      setTrimStart('');
      setTrimEnd('');
    }
  }, [singleItemId]);

  const singleOption = singleItem?.options.find((option) => option.id === selection?.optionIds[0]);
  const subtitles = subtitleChoices(singleItem, singleOption);
  const effectiveKind = singleOption?.kind ?? pickerKind;

  const canTrim = Boolean(singleItem && (effectiveKind === 'video' || effectiveKind === 'audio'));
  const rawTrim: TrimSummary = useMemo(
    () =>
      canTrim && singleItem
        ? summarizeTrim(trimStart, trimEnd, singleItem.duration, selection?.totalBytes)
        : { state: 'none' },
    [canTrim, singleItem, trimStart, trimEnd, selection?.totalBytes],
  );
  const rawSubtitlesRequested = subtitleRequest(
    subtitles,
    subtitleTrack,
    subtitleFormat,
    subtitlesOnly,
  );
  const subtitlesRequested = rawTrim.state !== 'none' ? undefined : rawSubtitlesRequested;
  const trim: TrimSummary = subtitlesRequested ? { state: 'none' } : rawTrim;

  const start = useCallback(async () => {
    if (!info) return;
    if (!selection?.optionIds.length) {
      setError({
        code: 'VALIDATION_ERROR',
        message: 'Select at least one item to download.',
        retryable: false,
      });
      return;
    }
    if (trim.state === 'invalid') {
      setShowAdvanced(true);
      setError({
        code: 'VALIDATION_ERROR',
        message: trim.message,
        retryable: false,
      });
      return;
    }
    const session = ++sessionRef.current;
    submitAbort.current?.abort();
    const controller = new AbortController();
    submitAbort.current = controller;
    setPhase('submitting');
    setError(undefined);

    try {
      const created: Job = await createJob(
        {
          infoId: info.id,
          optionIds: selection.optionIds,
          packaging,
          ...(filename.trim() ? { filename: filename.trim() } : {}),
          ...(trim.state === 'ok' ? { trim: trim.request } : {}),
          ...(subtitlesRequested ? { subtitles: subtitlesRequested } : {}),
        },
        controller.signal,
      );
      if (sessionRef.current !== session || controller.signal.aborted) {
        void cancelJob(created.id);
        return;
      }
      setInitialJob(created);
      setJobId(created.id);
      setPhase('running');
    } catch (caught) {
      if (sessionRef.current !== session || controller.signal.aborted) return;
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
  }, [info, selection, packaging, filename, trim, subtitlesRequested]);

  const handleJobReady = useCallback(
    (readyJob: Job) => {
      setPhase('done');
      if (batchQueue.length > 1) {
        updateBatchStatus(batchIndexRef.current, 'done');
      }
      if (readyJob.result && info) {
        const resultFiles = readyJob.result.files;
        addToHistory({
          jobId: readyJob.id,
          title: info.title,
          source: info.providerLabel,
          url: info.url,
          filename: readyJob.result.filename,
          downloadPath: readyJob.result.downloadPath,
          savedAt: new Date().toISOString(),
          expiresAt: readyJob.result.expiresAt,
          ...(resultFiles && resultFiles.length > 1
            ? {
                fileCount: resultFiles.length,
                isArchive: readyJob.result.isArchive,
                ...(!readyJob.result.isArchive
                  ? {
                      files: resultFiles.map((file) => ({
                        name: file.name,
                        downloadPath: file.downloadPath,
                      })),
                    }
                  : {}),
              }
            : {}),
        });
      }
    },
    [info, batchQueue.length, updateBatchStatus],
  );

  const handleJobFailed = useCallback(
    (failedJob: Job) => {
      setError(
        failedJob.error ?? { code: 'INTERNAL', message: 'The download failed.', retryable: true },
      );
      setPhase('ready');
      setJobId(undefined);
      setInitialJob(undefined);
      if (batchQueue.length > 1) {
        updateBatchStatus(batchIndexRef.current, 'failed');
      }
    },
    [batchQueue.length, updateBatchStatus],
  );

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    submitAbort.current?.abort();
    if (jobId) void cancelJob(jobId);
    setJobId(undefined);
    setInitialJob(undefined);
    setPhase('ready');
  }, [jobId]);

  const selectBatchItem = useCallback(
    (targetIdx: number) => {
      const target = batchQueue[targetIdx];
      if (!target) return;
      setBatchIndex(targetIdx);
      setUrl(target);
      void analyze(target, targetIdx);
    },
    [batchQueue, analyze],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (
          event.target instanceof HTMLElement &&
          event.target.matches('input, select, textarea, [contenteditable="true"]')
        ) {
          event.target.blur();
          return;
        }
        if (phase === 'running' || phase === 'submitting') cancel();
        else if (phase === 'ready' || phase === 'done' || phase === 'analyzing') {
          reset(batchQueue.length > 1);
        }
        return;
      }
      if (event.key === 'Enter' && !event.defaultPrevented) {
        if (error) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('#sera-url, [data-item-picker="true"]')) return;
        const isModifier = event.metaKey || event.ctrlKey;
        const isInteractive = Boolean(
          target?.closest(
            'a, summary, button, input, select, textarea, [role="button"], [contenteditable="true"]',
          ),
        );
        if (isModifier || !isInteractive) {
          if (phase === 'ready' && selection?.optionIds.length && trim.state !== 'invalid') {
            event.preventDefault();
            void start();
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, error, cancel, reset, selection, trim.state, start, batchQueue.length]);

  const handleUrlChange = useCallback(
    (next: string) => {
      setUrl(next);
      if (info || error || phase === 'analyzing') {
        reset(false);
      } else if (!next.trim() && batchQueue.length > 0) {
        setBatchQueue([]);
        setBatchIndex(0);
        setBatchStatuses([]);
      }
    },
    [info, error, phase, reset, batchQueue.length],
  );

  const handleUrlSubmit = useCallback(
    (next: string) => {
      setBatchQueue([]);
      setBatchIndex(0);
      setBatchStatuses([]);
      void analyze(next);
    },
    [analyze],
  );

  const handleBatchSubmit = useCallback(
    (urls: string[]) => {
      const capped = urls.slice(0, MAX_BATCH_URLS);
      setBatchQueue(capped);
      setBatchIndex(0);
      setBatchStatuses(capped.map(() => 'pending'));
      const first = capped[0] ?? '';
      setUrl(first);
      if (first) void analyze(first, 0);
    },
    [analyze],
  );

  const handleKindChange = useCallback((nextKind: SelectableKind) => {
    setKind(nextKind);
    setPreferredKind(nextKind);
  }, []);

  const busy = phase === 'analyzing';
  const working = phase === 'running' || phase === 'submitting';
  const isCollection = (info?.items.length ?? 0) > 1;
  const hasNextInBatch = !importMode && batchQueue.length > 1 && batchIndex < batchQueue.length - 1;
  const batchNextLabel = hasNextInBatch
    ? `Next in batch (${batchIndex + 2}/${batchQueue.length}) →`
    : undefined;

  const handleNextInBatch = useCallback(() => {
    if (batchIndex < batchQueue.length - 1) {
      selectBatchItem(batchIndex + 1);
    }
  }, [batchIndex, batchQueue.length, selectBatchItem]);

  const handleDownloadAgain = useCallback(() => {
    if (!info) return;
    void analyze(info.url, batchQueue.length > 1 ? batchIndex : undefined);
  }, [info, analyze, batchQueue.length, batchIndex]);

  const errorActions = useMemo<ErrorAction[]>(() => {
    if (!error) return [];
    const actions: ErrorAction[] = [];
    if (error.retryable) {
      actions.push({
        label: 'Try again',
        primary: true,
        onClick: () => {
          if (info) {
            void start();
          } else {
            setError(undefined);
            void analyze(url, batchQueue.length > 1 ? batchIndex : undefined);
          }
        },
      });
    }
    if (!importMode && error.code === 'PROVIDER_AUTH_REQUIRED') {
      actions.push({
        label: 'Download from your browser',
        primary: !error.retryable,
        onClick: () => router.push('/import'),
      });
    }
    if (hasNextInBatch) {
      actions.push({
        label: 'Skip to next',
        onClick: handleNextInBatch,
      });
    }
    if (info) actions.push({ label: 'Change format', onClick: () => setError(undefined) });
    actions.push({ label: info ? 'Start over' : 'Clear', onClick: clearAll });
    return actions;
  }, [
    error,
    info,
    url,
    importMode,
    hasNextInBatch,
    handleNextInBatch,
    analyze,
    start,
    clearAll,
    batchQueue.length,
    batchIndex,
    router,
  ]);

  const showActiveJob = working || phase === 'done';
  const nodesOffline =
    Boolean(serviceInfo?.nodeAvailability?.enabled) &&
    (serviceInfo?.nodeAvailability?.healthyNodes ?? 0) === 0;

  return (
    <div className="flex flex-col gap-4">
      {!importMode && nodesOffline && phase === 'idle' && !error && (
        <p
          role="status"
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-sunken)] px-3.5 py-2.5 text-center text-xs text-[var(--color-ink-muted)]"
        >
          Residential extraction nodes are currently offline — some sites may be temporarily
          unavailable.
        </p>
      )}
      {!importMode && (
        <UrlForm
          value={url}
          onChange={handleUrlChange}
          onSubmit={handleUrlSubmit}
          onSubmitBatch={handleBatchSubmit}
          busy={busy}
          disabled={working}
        />
      )}

      {!importMode && batchQueue.length > 1 && (
        <section
          aria-label="Batch URL queue"
          className="flex flex-col gap-2.5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
              Batch Queue · {batchIndex + 1} of {batchQueue.length}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={working || batchIndex <= 0}
                onClick={() => selectBatchItem(Math.max(0, batchIndex - 1))}
                className="min-h-8 cursor-pointer rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={working || batchIndex >= batchQueue.length - 1}
                onClick={() => selectBatchItem(Math.min(batchQueue.length - 1, batchIndex + 1))}
                className="min-h-8 cursor-pointer rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Next
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() => {
                  setBatchQueue([]);
                  setBatchIndex(0);
                  setBatchStatuses([]);
                }}
                className="min-h-8 cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Clear batch
              </button>
            </div>
          </div>

          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {batchQueue.map((queuedUrl, idx) => {
              const active = idx === batchIndex;
              const status = batchStatuses[idx] ?? 'pending';
              const marker = status === 'done' ? '✓ ' : status === 'failed' ? '! ' : '';
              return (
                <button
                  key={`${idx}-${queuedUrl}`}
                  type="button"
                  disabled={working}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => selectBatchItem(idx)}
                  className={cx(
                    'max-w-full cursor-pointer truncate rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed',
                    active
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent)]'
                      : status === 'done'
                        ? 'border-[var(--color-success)]/40 bg-[var(--color-canvas)] text-[var(--color-success)]'
                        : status === 'failed'
                          ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger-wash)] text-[var(--color-danger)]'
                          : 'border-[var(--color-line)] bg-[var(--color-canvas)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {marker}
                  {idx + 1}. {queuedUrl}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {busy && <AnalyzingSkeleton />}

      {error && !working && <ErrorPanel error={error} actions={errorActions} />}

      {info && phase !== 'analyzing' && (
        <>
          <MediaPreview info={info} />

          {showActiveJob ? (
            <ActiveJobPanel
              jobId={jobId}
              initialJob={initialJob}
              submitting={phase === 'submitting'}
              onReady={handleJobReady}
              onFailed={handleJobFailed}
              onCancel={cancel}
              onReset={handleNewLink}
              onDownloadAgain={importMode ? clearAll : handleDownloadAgain}
              downloadAgainLabel={importMode ? 'Import again' : undefined}
              hasNextInBatch={hasNextInBatch}
              batchNextLabel={batchNextLabel}
              onNextInBatch={handleNextInBatch}
            />
          ) : (
            <section className="animate-fade-up flex flex-col gap-5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)]">
              {isCollection && (
                <ItemPicker
                  info={info}
                  selectedIds={selectedIds}
                  onToggle={handleToggleItem}
                  onSelectAll={handleSelectAllItems}
                  onSelectIds={setSelectedIds}
                  maxItems={maxSelectedItems}
                />
              )}

              <FormatPicker
                info={info}
                selectedIds={selectedIds}
                kind={pickerKind}
                onKindChange={handleKindChange}
                label={effectiveLabel}
                onLabelChange={setLabel}
              />

              {subtitles && (
                <SubtitleFields
                  choices={subtitles}
                  track={subtitleTrack}
                  onTrackChange={(nextTrack) => {
                    setSubtitleTrack(nextTrack);
                    if (!nextTrack) setSubtitlesOnly(false);
                  }}
                  format={subtitlesRequested?.format ?? subtitleFormat}
                  onFormatChange={(nextFormat) => {
                    if (nextFormat === 'embed') setSubtitlesOnly(false);
                    setSubtitleFormat(nextFormat);
                  }}
                  only={subtitlesOnly}
                  onOnlyChange={setSubtitlesOnly}
                  disabled={trim.state !== 'none'}
                />
              )}

              <AdvancedOptions
                open={showAdvanced || trim.state === 'invalid'}
                onToggle={() => {
                  if (trim.state === 'invalid') return;
                  setShowAdvanced((open) => !open);
                }}
                filename={filename}
                onFilenameChange={setFilename}
                packaging={packaging}
                onPackagingChange={setPackaging}
                multiple={(selection?.fileCount ?? 0) > 1}
                trim={
                  canTrim && singleItem
                    ? {
                        start: trimStart,
                        end: trimEnd,
                        onStartChange: (next) => {
                          if (next.trim()) {
                            setSubtitleTrack('');
                            setSubtitlesOnly(false);
                          }
                          setTrimStart(next);
                        },
                        onEndChange: (next) => {
                          if (next.trim()) {
                            setSubtitleTrack('');
                            setSubtitlesOnly(false);
                          }
                          setTrimEnd(next);
                        },
                        summary: trim,
                        endPlaceholder: endPlaceholder(singleItem.duration),
                        disabled: Boolean(subtitlesRequested),
                      }
                    : undefined
                }
              />

              <button
                type="button"
                onClick={() => void start()}
                disabled={!selection?.optionIds.length || trim.state === 'invalid'}
                className={cx(
                  'flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-input)] text-[0.9375rem] font-medium transition-colors duration-200',
                  'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-hover)]',
                  'disabled:cursor-not-allowed disabled:bg-[var(--color-sunken)] disabled:text-[var(--color-ink-faint)]',
                  'focus-visible:shadow-[var(--shadow-focus)]',
                )}
              >
                <DownloadIcon size={17} />
                {subtitlesRequested?.only
                  ? 'Download subtitles'
                  : selection && selection.fileCount > 1
                    ? `Download ${pluralize(selection.fileCount, 'file')}`
                    : 'Download'}
                {subtitlesRequested?.only ? null : trim.state === 'ok' && trim.estimatedBytes ? (
                  <span className="tabular font-normal opacity-75">
                    · ~{formatBytes(trim.estimatedBytes)}
                  </span>
                ) : selection?.totalBytes ? (
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

      {!importMode && <RecentDownloads onAgain={again} disabled={working} />}
    </div>
  );
}

const PACKAGING_OPTIONS: readonly (readonly [PackagingMode, string])[] = [
  ['auto', 'Automatic'],
  ['zip', 'One ZIP'],
  ['individual', 'Separate files'],
];

function AdvancedOptions({
  open,
  onToggle,
  filename,
  onFilenameChange,
  packaging,
  onPackagingChange,
  multiple,
  trim,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly filename: string;
  readonly onFilenameChange: (value: string) => void;
  readonly packaging: PackagingMode;
  readonly onPackagingChange: (value: PackagingMode) => void;
  readonly multiple: boolean;
  readonly trim?: {
    readonly start: string;
    readonly end: string;
    readonly onStartChange: (value: string) => void;
    readonly onEndChange: (value: string) => void;
    readonly summary: TrimSummary;
    readonly endPlaceholder: string;
    readonly disabled?: boolean;
  };
}) {
  return (
    <div className="border-t border-[var(--color-line)] pt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-9 cursor-pointer items-center gap-1.5 text-[0.8125rem] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
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
              className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus-visible:shadow-[var(--shadow-focus)]"
            />
          </div>

          {trim && <TrimFields {...trim} />}

          {multiple && (
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
                Packaging
              </legend>
              <div
                role="radiogroup"
                aria-label="Packaging"
                className="flex gap-1 rounded-xl bg-[var(--color-sunken)] p-1"
              >
                {PACKAGING_OPTIONS.map(([value, text], index) => {
                  const selected = packaging === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => onPackagingChange(value)}
                      onKeyDown={(event) =>
                        stepRadio(
                          event,
                          PACKAGING_OPTIONS.map(([mode]) => mode),
                          index,
                          onPackagingChange,
                        )
                      }
                      className={cx(
                        'flex-1 cursor-pointer rounded-lg px-2 py-2 text-[0.8125rem] font-medium transition-all duration-150',
                        selected
                          ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                          : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                      )}
                    >
                      {text}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}

const FIELD_LABEL =
  'mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase';
const FIELD_INPUT =
  'tabular w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus-visible:shadow-[var(--shadow-focus)] aria-[invalid=true]:border-[var(--color-danger)]';

function SubtitleFields({
  choices,
  track,
  onTrackChange,
  format,
  onFormatChange,
  only,
  onOnlyChange,
  disabled,
}: {
  readonly choices: SubtitleChoices;
  readonly track: string;
  readonly onTrackChange: (value: string) => void;
  readonly format: SubtitleFormat;
  readonly onFormatChange: (value: SubtitleFormat) => void;
  readonly only: boolean;
  readonly onOnlyChange: (value: boolean) => void;
  readonly disabled?: boolean;
}) {
  const formats: readonly (readonly [SubtitleFormat, string])[] = [
    ...(choices.canEmbed ? ([['embed', 'In the video']] as const) : []),
    ['srt', 'SRT file'],
    ['vtt', 'VTT file'],
  ];
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className={FIELD_LABEL}>Subtitles</legend>
      <label htmlFor="sera-subtitles" className="sr-only">
        Subtitle language
      </label>
      <select
        id="sera-subtitles"
        value={disabled ? '' : track}
        disabled={disabled}
        onChange={(event) => onTrackChange(event.target.value)}
        className={cx(FIELD_INPUT, disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}
      >
        <option value="">None</option>
        {choices.tracks.map((candidate) => (
          <option key={trackValue(candidate)} value={trackValue(candidate)}>
            {candidate.label}
          </option>
        ))}
      </select>
      {disabled ? (
        <p className="text-xs text-[var(--color-ink-faint)]">
          Subtitles cannot be combined with trimming.
        </p>
      ) : (
        choices.tracks.some((candidate) => trackValue(candidate) === track) && (
          <>
            <div
              role="radiogroup"
              aria-label="Subtitle format"
              className="flex gap-1 rounded-xl bg-[var(--color-sunken)] p-1"
            >
              {formats.map(([value, text], index) => {
                const selected = format === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onFormatChange(value)}
                    onKeyDown={(event) =>
                      stepRadio(
                        event,
                        formats.map(([fmt]) => fmt),
                        index,
                        onFormatChange,
                      )
                    }
                    className={cx(
                      'flex-1 cursor-pointer rounded-lg px-2 py-2 text-[0.8125rem] font-medium transition-all duration-150',
                      selected
                        ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                        : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                    )}
                  >
                    {text}
                  </button>
                );
              })}
            </div>
            {format !== 'embed' && (
              <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-[var(--color-ink-muted)]">
                <input
                  type="checkbox"
                  checked={only}
                  onChange={(event) => onOnlyChange(event.target.checked)}
                  className="size-4 cursor-pointer accent-[var(--color-accent)]"
                />
                Only the subtitles
              </label>
            )}
          </>
        )
      )}
    </fieldset>
  );
}

function TrimFields({
  start,
  end,
  onStartChange,
  onEndChange,
  summary,
  endPlaceholder: placeholder,
  disabled,
}: NonNullable<Parameters<typeof AdvancedOptions>[0]['trim']>) {
  const invalid = !disabled && summary.state === 'invalid';
  return (
    <fieldset>
      <legend className={FIELD_LABEL}>Trim</legend>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label htmlFor="sera-trim-start" className="sr-only">
            Start time
          </label>
          <input
            id="sera-trim-start"
            type="text"
            inputMode="text"
            pattern="(?:[0-9]{1,2}:)?[0-5]?[0-9]:[0-5][0-9]"
            autoComplete="off"
            value={start}
            maxLength={9}
            disabled={disabled}
            onChange={(event) => onStartChange(event.target.value)}
            placeholder="0:00"
            aria-invalid={invalid}
            aria-describedby="sera-trim-summary"
            className={cx(FIELD_INPUT, disabled && 'cursor-not-allowed opacity-60')}
          />
        </div>
        <div>
          <label htmlFor="sera-trim-end" className="sr-only">
            End time
          </label>
          <input
            id="sera-trim-end"
            type="text"
            inputMode="text"
            pattern="(?:[0-9]{1,2}:)?[0-5]?[0-9]:[0-5][0-9]"
            autoComplete="off"
            value={end}
            maxLength={9}
            disabled={disabled}
            onChange={(event) => onEndChange(event.target.value)}
            placeholder={placeholder}
            aria-invalid={invalid}
            aria-describedby="sera-trim-summary"
            className={cx(FIELD_INPUT, disabled && 'cursor-not-allowed opacity-60')}
          />
        </div>
      </div>
      <p
        id="sera-trim-summary"
        role={invalid ? 'alert' : undefined}
        className={cx(
          'mt-1.5 text-xs',
          invalid ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-faint)]',
        )}
      >
        {disabled
          ? "Trimming isn't available when downloading subtitles."
          : summary.state === 'invalid'
            ? summary.message
            : summary.state === 'ok'
              ? [
                  summary.keptSeconds !== undefined
                    ? `Keeps ${formatDuration(summary.keptSeconds)}`
                    : 'Keeps the part between these times',
                  summary.estimatedBytes
                    ? `about ${formatBytes(summary.estimatedBytes)}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Optional: start and end as m:ss or h:mm:ss.'}
      </p>
    </fieldset>
  );
}

function AnalyzingSkeleton() {
  return (
    <section
      aria-label="Analyzing link"
      className="animate-fade-up rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
    >
      <span role="status" aria-live="polite" className="sr-only">
        Analyzing link…
      </span>
      <div className="flex gap-4" aria-hidden="true">
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
