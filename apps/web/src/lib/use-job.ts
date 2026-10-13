'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, JobEvent } from '@sera/contracts/types';
import { ApiError, getJob } from './api';
import { isRunning } from './format';

const STREAM_GRACE_MS = 6_000;
const POLL_INTERVAL_MS = 700;

export interface UseJobResult {
  readonly job: Job | undefined;
  readonly following: boolean;
}

export function useJob(jobId: string | undefined, initial?: Job): UseJobResult {
  const [job, setJob] = useState<Job | undefined>(() =>
    jobId && initial?.id === jobId ? initial : undefined,
  );
  const [following, setFollowing] = useState(false);
  const activeId = useRef<string | undefined>(undefined);

  const apply = useCallback((next: Job) => {
    if (next.id !== activeId.current) return;
    setJob((previous) => {
      if (!previous) return next;
      if (previous.progress.percent > next.progress.percent && isRunning(next.state)) {
        return { ...next, progress: previous.progress };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!jobId) {
      activeId.current = undefined;
      setJob(undefined);
      setFollowing(false);
      return;
    }

    activeId.current = jobId;
    setJob((prev) => (prev?.id === jobId ? prev : initial?.id === jobId ? initial : undefined));
    setFollowing(true);

    let stopped = false;
    let polling = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let sawStreamEvent = false;
    const controller = new AbortController();

    const finish = (): void => {
      stopped = true;
      setFollowing(false);
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (graceTimer) clearTimeout(graceTimer);
      controller.abort();
    };

    const poll = (): void => {
      if (stopped || jobId !== activeId.current) return;
      void getJob(jobId, controller.signal)
        .then((next) => {
          if (stopped || jobId !== activeId.current) return;
          apply(next);
          if (!isRunning(next.state)) {
            finish();
            return;
          }
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        })
        .catch((caught: unknown) => {
          if (stopped || jobId !== activeId.current) return;
          if (caught instanceof ApiError && !caught.retryable) {
            setJob((previous) => ({
              id: jobId,
              state: caught.code === 'EXPIRED' ? 'expired' : 'failed',
              step: 'Failed',
              progress: previous?.progress ?? { percent: 0 },
              provider: previous?.provider ?? 'generic',
              createdAt: previous?.createdAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: {
                code: caught.code,
                message: caught.message,
                ...(caught.hint ? { hint: caught.hint } : {}),
                retryable: caught.retryable,
              },
            }));
            finish();
            return;
          }
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS * 2);
        });
    };

    const startPolling = (): void => {
      if (stopped || polling) return;
      polling = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      source?.close();
      source = undefined;
      poll();
    };

    try {
      source = new EventSource(`/api/jobs/${jobId}/events`);

      const onMessage = (raw: MessageEvent<string>): void => {
        if (typeof raw.data !== 'string') return;
        sawStreamEvent = true;
        let event: Partial<JobEvent>;
        try {
          event = JSON.parse(raw.data) as Partial<JobEvent>;
        } catch {
          return;
        }
        if (event.type === 'ping') return;
        if (!('job' in event) || !event.job) {
          startPolling();
          return;
        }
        apply(event.job);
        if (!isRunning(event.job.state)) finish();
      };

      for (const type of ['state', 'progress', 'done', 'error', 'ping'] as const) {
        source.addEventListener(type, onMessage as EventListener);
      }
      source.onerror = () => {
        startPolling();
      };

      graceTimer = setTimeout(() => {
        if (!sawStreamEvent) startPolling();
      }, STREAM_GRACE_MS);
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (graceTimer) clearTimeout(graceTimer);
      controller.abort();
    };
  }, [jobId, initial, apply]);

  const currentJob = jobId
    ? job?.id === jobId
      ? job
      : initial?.id === jobId
        ? initial
        : undefined
    : undefined;

  return { job: currentJob, following };
}
