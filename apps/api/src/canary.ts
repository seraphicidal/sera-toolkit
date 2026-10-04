import type { DownloadOption, Job, MediaInfo } from '@sera/contracts/types';

/**
 * The canary: a real download per source, through the API's own front door.
 *
 * /health says the tools are installed and a node is connected. It cannot say that YouTube
 * still hands out playable streams, or that a site has not changed its pages overnight —
 * everything can be green while a source returns nothing. So once a day the server asks
 * itself for one small file from each source, by the same route a visitor uses: resolve,
 * pick an option, run the job, fetch the result. YouTube goes through the extraction nodes
 * exactly as a visitor's link would.
 *
 * The requests carry `x-sera-canary`, which exempts them from rate limits and abuse
 * strikes (a source that is down must not lock the canary out of noticing it is back) and
 * keeps them out of usage counts.
 */

/** One entry of scripts/provider-cases.json that the canary runs. */
export interface CanaryCase {
  readonly id: string;
  readonly url: string;
  readonly canary: {
    /** The source's name, as an alert says it: "YouTube downloads failing". */
    readonly label: string;
    readonly kind: 'video' | 'audio' | 'image' | 'gif';
  };
}

export interface CanaryResult {
  readonly source: string;
  readonly label: string;
  readonly ok: boolean;
  /** The API's error code, or one of the canary's own (TIMEOUT, NO_OPTION, EMPTY). */
  readonly code?: string;
  readonly durationMs: number;
  /** ISO-8601, when this source's check finished. */
  readonly at: string;
  readonly bytes?: number;
}

export interface CanaryOptions {
  /** The API's origin, e.g. http://127.0.0.1:4000. */
  readonly apiUrl: string;
  readonly token: string;
  readonly cases: readonly CanaryCase[];
  /** The ceiling for one source: resolve, job and download together. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly fetch?: typeof fetch;
}

/** The cases a list marks for the canary, from the parsed provider-cases.json. */
export function canaryCases(all: readonly unknown[]): CanaryCase[] {
  return all.filter((entry): entry is CanaryCase => {
    if (!entry || typeof entry !== 'object') return false;
    const { id, url, canary } = entry as Partial<CanaryCase>;
    return (
      typeof id === 'string' &&
      typeof url === 'string' &&
      typeof canary?.label === 'string' &&
      ['video', 'audio', 'image', 'gif'].includes(canary.kind)
    );
  });
}

/**
 * The cheapest option of a kind: the smallest by declared size, or, where no size is
 * declared, the last one listed, since options come best first.
 */
export function smallestOption(info: MediaInfo, kind: string): DownloadOption | undefined {
  const options = info.items.flatMap((item) => item.options).filter((o) => o.kind === kind);
  const sized = options.filter((o) => typeof o.filesizeBytes === 'number');
  if (sized.length) {
    return sized.reduce((a, b) => ((b.filesizeBytes ?? 0) < (a.filesizeBytes ?? 0) ? b : a));
  }
  return options.at(-1);
}

/** A failure the canary reports by code, whether the API's or its own. */
class CanaryFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function runCanary(options: CanaryOptions): Promise<CanaryResult[]> {
  const results: CanaryResult[] = [];
  // One source at a time: the canary should look like one patient visitor, not a burst.
  for (const entry of options.cases) {
    results.push(await checkOne(entry, options));
  }
  return results;
}

async function checkOne(entry: CanaryCase, options: CanaryOptions): Promise<CanaryResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  const finish = (fields: { ok: boolean; code?: string; bytes?: number }): CanaryResult => ({
    source: entry.id,
    label: entry.canary.label,
    ...fields,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  });

  try {
    const bytes = await download(entry, options, signal);
    return finish({ ok: true, bytes });
  } catch (error) {
    if (error instanceof CanaryFailure) return finish({ ok: false, code: error.code });
    if (signal.aborted) return finish({ ok: false, code: 'TIMEOUT' });
    return finish({ ok: false, code: 'NETWORK_ERROR' });
  }
}

async function download(
  entry: CanaryCase,
  options: CanaryOptions,
  signal: AbortSignal,
): Promise<number> {
  const call = options.fetch ?? fetch;
  const base = options.apiUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'x-sera-canary': options.token };

  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await call(`${base}${path}`, { ...init, headers, signal });
    const body = (await response.json().catch(() => undefined)) as
      (T & { error?: { code?: string } }) | undefined;
    if (!response.ok) {
      throw new CanaryFailure(body?.error?.code ?? `HTTP_${String(response.status)}`);
    }
    return body as T;
  };

  const info = await json<MediaInfo>('/api/media/info', {
    method: 'POST',
    body: JSON.stringify({ url: entry.url }),
  });
  const option = smallestOption(info, entry.canary.kind);
  if (!option) throw new CanaryFailure('NO_OPTION');

  let job = await json<Job>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ infoId: info.id, optionIds: [option.id] }),
  });
  while (!['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2000));
    if (signal.aborted) throw signal.reason;
    job = await json<Job>(`/api/jobs/${job.id}`);
  }
  if (job.state !== 'ready' || !job.result) {
    throw new CanaryFailure(job.error?.code ?? job.state.toUpperCase());
  }

  // The bytes themselves, counted as they arrive: a result that cannot be fetched is a
  // failure as real as one that never resolved.
  const response = await call(`${base}${job.result.downloadPath}`, { headers, signal });
  if (!response.ok || !response.body) {
    throw new CanaryFailure(`HTTP_${String(response.status)}`);
  }
  let bytes = 0;
  for await (const chunk of response.body) bytes += (chunk as Uint8Array).byteLength;
  if (bytes === 0) throw new CanaryFailure('EMPTY');
  return bytes;
}
