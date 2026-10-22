'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Job,
  JobError,
  MediaInfo,
  PackagingMode,
  SubtitleFormat,
} from '@sera/contracts/types';
import { ApiError, cancelJob, createJob, resolveMedia } from '@/lib/api';
import { cx, formatBytes, formatDuration, isRunning, pluralize } from '@/lib/format';
import { addToHistory } from '@/lib/history';
import {
  availableKinds,
  initialKind,
  qualityLabels,
  resolveSelection,
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
import { useJob } from '@/lib/use-job';
import { DownloadIcon, SpinnerIcon } from './icons';
import { ErrorPanel, type ErrorAction } from './error-panel';
import { FormatPicker } from './format-picker';
import { ItemPicker } from './item-picker';
import { MediaPreview } from './media-preview';
import { ProgressPanel } from './progress-panel';
import { RecentDownloads } from './recent-downloads';
import { ResultPanel } from './result-panel';
import { UrlForm } from './url-form';

type Phase = 'idle' | 'analyzing' | 'ready' | 'submitting' | 'running' | 'done';

const PREFERRED_KIND_KEY = 'sera-preferred-kind';

function getPreferredKind(): SelectableKind | undefined {
  try {
    const saved = localStorage.getItem(PREFERRED_KIND_KEY);
    if (saved === 'video' || saved === 'audio' || saved === 'image' || saved === 'gif') {
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

function seedFrom(info: MediaInfo): {
  kind: SelectableKind;
  selectedIds: Set<string>;
  label: string | undefined;
} {
  const selectedIds = new Set(info.items.map((item) => item.id));
  const available = availableKinds(info, selectedIds);
  const preferred = getPreferredKind();
  const kind = preferred && available.includes(preferred) ? preferred : initialKind(info);
  return { kind, selectedIds, label: qualityLabels(info, kind, selectedIds)[0] };
}

export function Downloader({ initialInfo }: { readonly initialInfo?: MediaInfo } = {}) {
  const importMode = initialInfo !== undefined;
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>(initialInfo ? 'ready' : 'idle');
  const [info, setInfo] = useState<MediaInfo | undefined>(initialInfo);
  const [error, setError] = useState<JobError | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();
  const [initialJob, setInitialJob] = useState<Job | undefined>();

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
  const [trimStart, setTrimStart] = useState('');
  const [trimEnd, setTrimEnd] = useState('');
  const [packaging, setPackaging] = useState<PackagingMode>('auto');
  const [subtitleTrack, setSubtitleTrack] = useState('');
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>('embed');
  const [subtitlesOnly, setSubtitlesOnly] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const analyzeAbort = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(0);
  const { job } = useJob(jobId, initialJob);

  useEffect(
    () => () => {
      sessionRef.current += 1;
      analyzeAbort.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => {
    sessionRef.current += 1;
    analyzeAbort.current?.abort();
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
    sessionRef.current += 1;
    analyzeAbort.current?.abort();
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

      const everyItem = new Set(resolved.items.map((item) => item.id));
      const available = availableKinds(resolved, everyItem);
      const preferred = getPreferredKind();
      const startingKind =
        preferred && available.includes(preferred) ? preferred : initialKind(resolved);

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

  useEffect(() => {
    if (importMode) return;
    const shared = urlFromFragment(window.location.hash);
    if (!shared) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setUrl(shared);
    void analyze(shared);
  }, [importMode, analyze]);

  const again = useCallback(
    (link: string) => {
      setUrl(link);
      void analyze(link);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [analyze],
  );

  useEffect(() => {
    if (!info) return;
    const kinds = availableKinds(info, selectedIds);
    if (kinds.length > 0 && !kinds.includes(kind)) {
      const fallbackKind = kinds[0];
      if (fallbackKind) {
        setKind(fallbackKind);
        setLabel(qualityLabels(info, fallbackKind, selectedIds)[0]);
        return;
      }
    }
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

  const singleItem =
    info && selection?.fileCount === 1
      ? (info.items.find((item) => item.options.some((o) => o.id === selection.optionIds[0])) ??
        info.items.find((item) => selectedIds.has(item.id)))
      : undefined;

  const singleOption = singleItem?.options.find((option) => option.id === selection?.optionIds[0]);
  const subtitles = subtitleChoices(singleItem, singleOption);
  const effectiveKind = singleOption?.kind ?? kind;

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
    if (!info || !selection?.optionIds.length) return;
    const session = ++sessionRef.current;
    setPhase('submitting');
    setError(undefined);

    try {
      const created: Job = await createJob({
        infoId: info.id,
        optionIds: selection.optionIds,
        packaging,
        ...(filename.trim() ? { filename: filename.trim() } : {}),
        ...(trim.state === 'ok' ? { trim: trim.request } : {}),
        ...(subtitlesRequested ? { subtitles: subtitlesRequested } : {}),
      });
      if (sessionRef.current !== session) {
        void cancelJob(created.id);
        return;
      }
      setInitialJob(created);
      setJobId(created.id);
      setPhase('running');
    } catch (caught) {
      if (sessionRef.current !== session) return;
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

  useEffect(() => {
    if (!job || !jobId || job.id !== jobId) return;
    if (job.state === 'ready') {
      setPhase('done');
      if (job.result && info) {
        addToHistory({
          jobId: job.id,
          title: info.title,
          source: info.providerLabel,
          url: info.url,
          filename: job.result.filename,
          downloadPath: job.result.downloadPath,
          savedAt: new Date().toISOString(),
          expiresAt: job.result.expiresAt,
        });
      }
      return;
    }
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired') {
      setError(job.error ?? { code: 'INTERNAL', message: 'The download failed.', retryable: true });
      setPhase('ready');
      setJobId(undefined);
      setInitialJob(undefined);
    }
  }, [job, jobId, info]);

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    if (jobId) void cancelJob(jobId);
    setJobId(undefined);
    setInitialJob(undefined);
    setPhase('ready');
  }, [jobId]);

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
        else if (phase === 'ready' || phase === 'done' || phase === 'analyzing') reset();
        return;
      }
      if (event.key === 'Enter') {
        const isModifier = event.metaKey || event.ctrlKey;
        const isInteractive =
          event.target instanceof Element &&
          Boolean(
            event.target.closest(
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
  }, [phase, cancel, reset, selection, trim.state, start]);

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
            if (info || error || phase === 'analyzing') {
              reset();
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
                onKindChange={(nextKind) => {
                  setKind(nextKind);
                  setPreferredKind(nextKind);
                }}
                label={label}
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

      {!importMode && <RecentDownloads onAgain={again} />}
    </div>
  );
}

const PACKAGING_OPTIONS: readonly (readonly [PackagingMode, string])[] = [
  ['auto', 'Automatic'],
  ['zip', 'One ZIP'],
  ['individual', 'Separate files'],
];

function stepRadio<T>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  index: number,
  onSelect: (value: T) => void,
): void {
  let offset = 0;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') offset = 1;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') offset = -1;
  if (!offset || !values.length) return;
  event.preventDefault();
  const nextIndex = (index + offset + values.length) % values.length;
  const nextValue = values[nextIndex];
  if (nextValue === undefined) return;
  onSelect(nextValue);
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    [nextIndex]?.focus();
}

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
            inputMode="numeric"
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
            inputMode="numeric"
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

function QueuedNotice() {
  return (
    <section
      role="status"
      aria-live="polite"
      className="animate-fade-up flex items-center gap-2.5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <SpinnerIcon size={17} className="text-[var(--color-accent)]" />
      <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">Starting…</p>
    </section>
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
