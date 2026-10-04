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
import { initialKind, qualityLabels, resolveSelection, type SelectableKind } from '@/lib/selection';
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
  const [trimStart, setTrimStart] = useState('');
  const [trimEnd, setTrimEnd] = useState('');
  const [packaging, setPackaging] = useState<PackagingMode>('auto');
  const [subtitleTrack, setSubtitleTrack] = useState('');
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>('embed');
  const [subtitlesOnly, setSubtitlesOnly] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const analyzeAbort = useRef<AbortController | undefined>(undefined);
  const { job } = useJob(jobId);

  /* ---------------------------------------------------------------- */

  const reset = useCallback(() => {
    analyzeAbort.current?.abort();
    setError(undefined);
    setJobId(undefined);
    setFilename('');
    setTrimStart('');
    setTrimEnd('');
    setSubtitleTrack('');
    setSubtitleFormat('embed');
    setSubtitlesOnly(false);
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

  // A link shared to SERA arrives as /#url=… (see lib/share.ts) and is read straight away.
  // The fragment is cleared first, so a reload or Back does not analyse it a second time.
  useEffect(() => {
    if (importMode) return;
    const shared = urlFromFragment(window.location.hash);
    if (!shared) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setUrl(shared);
    void analyze(shared);
  }, [importMode, analyze]);

  /** "Download again" on an expired entry: the original link, read afresh. */
  const again = useCallback(
    (link: string) => {
      setUrl(link);
      void analyze(link);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [analyze],
  );

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

  const singleItem =
    info && selection?.fileCount === 1
      ? info.items.find((item) => selectedIds.has(item.id))
      : undefined;

  // Subtitles: one item that has tracks, as video or audio. A track is never added to a
  // trimmed download (the server would refuse it), so a trim typed first hides the choice,
  // and a track chosen first hides the trim.
  const subtitles = subtitleChoices(
    singleItem,
    singleItem?.options.find((option) => option.id === selection?.optionIds[0]),
  );
  const subtitlesRequested = subtitleRequest(
    subtitles,
    subtitleTrack,
    subtitleFormat,
    subtitlesOnly,
  );

  // Trimming applies to one video or audio item; for anything else the fields are hidden and
  // whatever was typed in them is ignored.
  const trimItem =
    singleItem && (kind === 'video' || kind === 'audio') && !subtitlesRequested
      ? singleItem
      : undefined;
  const trim: TrimSummary = useMemo(
    () =>
      trimItem
        ? summarizeTrim(trimStart, trimEnd, trimItem.duration, selection?.totalBytes)
        : { state: 'none' },
    [trimItem, trimStart, trimEnd, selection?.totalBytes],
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
        ...(trim.state === 'ok' ? { trim: trim.request } : {}),
        ...(subtitlesRequested ? { subtitles: subtitlesRequested } : {}),
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
  }, [info, selection, packaging, filename, trim, subtitlesRequested]);

  // Follow the job to its conclusion.
  useEffect(() => {
    if (!job) return;
    if (job.state === 'ready') {
      setPhase('done');
      // Remembered in this browser only; see lib/history.ts.
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
    }
  }, [job, info]);

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

              {subtitles && trim.state !== 'ok' && (
                <SubtitleFields
                  choices={subtitles}
                  track={subtitleTrack}
                  onTrackChange={setSubtitleTrack}
                  format={subtitlesRequested?.format ?? subtitleFormat}
                  onFormatChange={setSubtitleFormat}
                  only={subtitlesOnly}
                  onOnlyChange={setSubtitlesOnly}
                />
              )}

              <AdvancedOptions
                open={showAdvanced}
                onToggle={() => setShowAdvanced((open) => !open)}
                filename={filename}
                onFilenameChange={setFilename}
                packaging={packaging}
                onPackagingChange={setPackaging}
                multiple={(selection?.fileCount ?? 0) > 1}
                trim={
                  trimItem
                    ? {
                        start: trimStart,
                        end: trimEnd,
                        onStartChange: setTrimStart,
                        onEndChange: setTrimEnd,
                        summary: trim,
                        endPlaceholder: endPlaceholder(trimItem.duration),
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

/* -------------------------------------------------------------------------- */

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
  /** Present only when the selection is one video or audio item. */
  readonly trim?: {
    readonly start: string;
    readonly end: string;
    readonly onStartChange: (value: string) => void;
    readonly onEndChange: (value: string) => void;
    readonly summary: TrimSummary;
    readonly endPlaceholder: string;
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

const FIELD_LABEL =
  'mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-ink-faint)] uppercase';
const FIELD_INPUT =
  'tabular w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-canvas)] px-3.5 py-2.5 text-[0.875rem] text-[var(--color-ink)] transition-colors outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-danger)]';

/**
 * A subtitle track: the language, then how it comes — embedded in the video as a track the
 * player can switch on, or as an SRT or VTT file beside it or on its own.
 */
function SubtitleFields({
  choices,
  track,
  onTrackChange,
  format,
  onFormatChange,
  only,
  onOnlyChange,
}: {
  readonly choices: SubtitleChoices;
  readonly track: string;
  readonly onTrackChange: (value: string) => void;
  readonly format: SubtitleFormat;
  readonly onFormatChange: (value: SubtitleFormat) => void;
  readonly only: boolean;
  readonly onOnlyChange: (value: boolean) => void;
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
        value={track}
        onChange={(event) => onTrackChange(event.target.value)}
        className={cx(FIELD_INPUT, 'cursor-pointer')}
      >
        <option value="">None</option>
        {choices.tracks.map((candidate) => (
          <option key={trackValue(candidate)} value={trackValue(candidate)}>
            {candidate.label}
          </option>
        ))}
      </select>
      {choices.tracks.some((candidate) => trackValue(candidate) === track) && (
        <>
          <div
            role="radiogroup"
            aria-label="Subtitle format"
            className="flex gap-1 rounded-xl bg-[var(--color-sunken)] p-1"
          >
            {formats.map(([value, text]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={format === value}
                onClick={() => onFormatChange(value)}
                className={cx(
                  'flex-1 cursor-pointer rounded-lg px-2 py-2 text-[0.8125rem] font-medium transition-all duration-150',
                  format === value
                    ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_1px_2px_oklch(0_0_0/0.06)]'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                )}
              >
                {text}
              </button>
            ))}
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
      )}
    </fieldset>
  );
}

/** Start and end times, with what they keep or why they cannot be used. */
function TrimFields({
  start,
  end,
  onStartChange,
  onEndChange,
  summary,
  endPlaceholder: placeholder,
}: NonNullable<Parameters<typeof AdvancedOptions>[0]['trim']>) {
  const invalid = summary.state === 'invalid';
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
            onChange={(event) => onStartChange(event.target.value)}
            placeholder="0:00"
            aria-invalid={invalid}
            aria-describedby="sera-trim-summary"
            className={FIELD_INPUT}
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
            onChange={(event) => onEndChange(event.target.value)}
            placeholder={placeholder}
            aria-invalid={invalid}
            aria-describedby="sera-trim-summary"
            className={FIELD_INPUT}
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
        {summary.state === 'invalid'
          ? summary.message
          : summary.state === 'ok'
            ? [
                summary.keptSeconds !== undefined
                  ? `Keeps ${formatDuration(summary.keptSeconds)}`
                  : 'Keeps the part between these times',
                summary.estimatedBytes ? `about ${formatBytes(summary.estimatedBytes)}` : undefined,
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
