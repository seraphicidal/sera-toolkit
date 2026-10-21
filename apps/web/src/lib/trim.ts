import { checkTrim, formatTimecode, type TrimRequest } from '@sera/contracts/types';

export type TrimSummary =
  | { readonly state: 'none' }
  | { readonly state: 'invalid'; readonly message: string }
  | {
      readonly state: 'ok';
      readonly request: TrimRequest;
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

export function endPlaceholder(durationSeconds: number | undefined): string {
  return durationSeconds ? formatTimecode(durationSeconds) : 'End';
}
