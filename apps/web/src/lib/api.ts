import type {
  ApiErrorBody,
  CreateJobRequest,
  ImportRequest,
  Job,
  JobError,
  MediaInfo,
  ServiceInfo,
} from '@sera/contracts/types';

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

function isAbortError(caught: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return caught instanceof Error && caught.name === 'AbortError';
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
    });
  } catch (caught) {
    if (isAbortError(caught, init?.signal)) throw caught;
    throw new ApiError(NETWORK_FAILURE);
  }

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch (caught) {
      if (isAbortError(caught, init?.signal)) throw caught;
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

  try {
    return (await response.json()) as T;
  } catch (caught) {
    if (isAbortError(caught, init?.signal)) throw caught;
    throw new ApiError({
      code: 'INTERNAL',
      message: 'Something went wrong on our side.',
      retryable: true,
    });
  }
}

export function getServiceInfo(signal?: AbortSignal): Promise<ServiceInfo> {
  return call<ServiceInfo>('/api/info', {
    ...(signal ? { signal } : {}),
  });
}

export function resolveMedia(url: string, signal?: AbortSignal): Promise<MediaInfo> {
  return call<MediaInfo>('/api/media/info', {
    method: 'POST',
    body: JSON.stringify({ url }),
    ...(signal ? { signal } : {}),
  });
}

export function importMedia(request: ImportRequest, signal?: AbortSignal): Promise<MediaInfo> {
  return call<MediaInfo>('/api/media/import', {
    method: 'POST',
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
}

export function createJob(request: CreateJobRequest, signal?: AbortSignal): Promise<Job> {
  return call<Job>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
}

export function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return call<Job>(`/api/jobs/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
}
