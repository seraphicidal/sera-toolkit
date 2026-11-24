import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, getJob, getServiceInfo, type ApiError } from './api';

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

  it('re-throws AbortError instead of converting it to NETWORK_ERROR', async () => {
    const controller = new AbortController();
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));
    controller.abort();

    await expect(getJob('id1', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('passes AbortSignal to createJob and fetches /api/info in getServiceInfo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'job1',
            state: 'queued',
            step: 'Queued',
            progress: { percent: 0 },
            provider: 'generic',
            createdAt: '',
            updatedAt: '',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'SERA.toolkit',
            version: '1.8.0',
            providers: [],
            limits: {
              maxFilesizeBytes: 1024,
              maxDurationSeconds: 3600,
              maxItemsPerJob: 50,
              retentionSeconds: 1800,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await createJob({ infoId: 'info1', optionIds: ['opt1'] }, controller.signal);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);

    const info = await getServiceInfo(controller.signal);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/info');
    expect(info.limits.maxItemsPerJob).toBe(50);
  });
});
