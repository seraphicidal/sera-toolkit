import { checkTrim, formatTimecode, type TrimRequest } from '@sera/contracts/types';

/**
 * What the trim fields amount to, for the form.
 *
 * The same `checkTrim` the server runs decides whether the times are usable, so a trim the
 * form accepts is never refused after Download is pressed. The size is an estimate: a share
 * of the whole file in proportion to the time kept, which is what the bitrate makes it.
 */
export type TrimSummary =
  | { readonly state: 'none' }
  | { readonly state: 'invalid'; readonly message: string }
  | {
      readonly state: 'ok';
      readonly request: TrimRequest;
      /** "Keeps 0:20 of 10:00" — absent when the length of the media is unknown. */
      readonly keptSeconds?: number;
      readonly estimatedBytes?: number;
    };

export function summarizeTrim(
  start: string,
  end: string,
  durationSeconds: number | undefined,
  totalBytes: number | undefined,
): TrimSummary {
  if (!start.trim() && !end.trim()) return { state: 'none' };
  const request: TrimRequest = {
    ...(start.trim() ? { start: start.trim() } : {}),
    ...(end.trim() ? { end: end.trim() } : {}),
  };
  const checked = checkTrim(request, durationSeconds);
  if (!checked.ok) return { state: 'invalid', message: checked.message };

  const stop = checked.range.end ?? durationSeconds;
  const keptSeconds = stop !== undefined ? stop - checked.range.start : undefined;
  const estimatedBytes =
    keptSeconds !== undefined && totalBytes && durationSeconds
      ? Math.round(totalBytes * (keptSeconds / durationSeconds))
      : undefined;
  return {
    state: 'ok',
    request,
    ...(keptSeconds !== undefined ? { keptSeconds } : {}),
    ...(estimatedBytes !== undefined ? { estimatedBytes } : {}),
  };
}

/** The placeholder for the end field: the media's own length, so the format is shown. */
export function endPlaceholder(durationSeconds: number | undefined): string {
  return durationSeconds ? formatTimecode(durationSeconds) : 'End';
}
