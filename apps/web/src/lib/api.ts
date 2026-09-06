import type {
  ApiErrorBody,
  CreateJobRequest,
  Job,
  JobError,
  MediaInfo,
  ServiceInfo,
} from '@sera/contracts/types';

/**
 * The browser's view of the API.
 *
 * Every request is same-origin, because the Next server rewrites `/api/*` to the
 * backend. The client therefore has no base URL to configure and no CORS to negotiate,
 * and the page's CSP can forbid outbound connections outright.
 */

/** A failure that already carries a sentence worth showing someone. */
export class ApiError extends Error {
  readonly code: JobError['code'];
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(error: JobError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.hint = error.hint;
    this.retryable = error.retryable;
  }
}

const NETWORK_FAILURE: JobError = {
  code: 'NETWORK_ERROR',
  message: "We couldn't reach the server.",
  hint: 'Check your connection and try again.',
  retryable: true,
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    // A thrown fetch is a transport failure; the server never got the request.
    throw new ApiError(NETWORK_FAILURE);
  }

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(
      body?.error ?? {
        code: 'INTERNAL',
        message: 'Something went wrong on our side.',
        retryable: true,
      },
    );
  }

  return (await response.json()) as T;
}

export function resolveMedia(url: string, signal?: AbortSignal): Promise<MediaInfo> {
  return call<MediaInfo>('/api/media/info', {
    method: 'POST',
    body: JSON.stringify({ url }),
    ...(signal ? { signal } : {}),
  });
}

export function createJob(request: CreateJobRequest): Promise<Job> {
  return call<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(request) });
}

export function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return call<Job>(`/api/jobs/${id}`, { ...(signal ? { signal } : {}) });
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

export function getServiceInfo(signal?: AbortSignal): Promise<ServiceInfo> {
  return call<ServiceInfo>('/api/info', { ...(signal ? { signal } : {}) });
}
