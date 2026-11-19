import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJob, type ApiError } from './api';

describe('web api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits content-type on GET requests and URI-encodes job ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'job/1',
          state: 'queued',
          step: 'Waiting',
          progress: { percent: 0 },
          createdAt: '',
          updatedAt: '',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getJob('job/1?bad=1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/jobs/job%2F1%3Fbad%3D1');
    const headers = init.headers as Headers;
    expect(headers.has('content-type')).toBe(false);
  });

  it('wraps invalid JSON on 200 OK into ApiError INTERNAL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));

    await expect(getJob('id1')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INTERNAL',
      retryable: true,
    } satisfies Partial<ApiError>);
  });
});
