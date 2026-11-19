'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, JobEvent } from '@sera/contracts/types';
import { ApiError, getJob } from './api';
import { isRunning } from './format';

const STREAM_GRACE_MS = 6_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_INTERVAL_MS = 4_000;

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
  const initialRef = useRef(initial);
  initialRef.current = initial;

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
    setJob((prev) =>
      prev?.id === jobId ? prev : initialRef.current?.id === jobId ? initialRef.current : undefined,
    );
    setFollowing(true);

    let stopped = false;
    let polling = false;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let sawStreamEvent = false;
    const controller = new AbortController();

    let pollDelayMs = POLL_INTERVAL_MS;
    let waitingVisibility = false;

    const finish = (): void => {
      stopped = true;
      setFollowing(false);
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      controller.abort();
    };

    const schedulePoll = (delayMs: number): void => {
      if (stopped || jobId !== activeId.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        waitingVisibility = true;
        return;
      }
      const jitter = 0.85 + Math.random() * 0.3;
      pollTimer = setTimeout(poll, Math.round(delayMs * jitter));
    };

    const onVisibilityChange = (): void => {
      if (stopped || !polling) return;
      if (document.visibilityState !== 'hidden' && waitingVisibility) {
        waitingVisibility = false;
        pollDelayMs = POLL_INTERVAL_MS;
        poll();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    const poll = (): void => {
      if (stopped || jobId !== activeId.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        waitingVisibility = true;
        return;
      }
      void getJob(jobId, controller.signal)
        .then((next) => {
          if (stopped || jobId !== activeId.current) return;
          apply(next);
          if (!isRunning(next.state)) {
            finish();
            return;
          }
          pollDelayMs = Math.min(Math.round(pollDelayMs * 1.25), MAX_POLL_INTERVAL_MS);
          schedulePoll(pollDelayMs);
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
          pollDelayMs = Math.min(pollDelayMs * 2, MAX_POLL_INTERVAL_MS);
          schedulePoll(pollDelayMs);
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
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      controller.abort();
    };
  }, [jobId, apply]);

  const currentJob = jobId
    ? job?.id === jobId
      ? job
      : initial?.id === jobId
        ? initial
        : undefined
    : undefined;

  return { job: currentJob, following };
}
