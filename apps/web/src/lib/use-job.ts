'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, JobEvent } from '@sera/contracts/types';
import { getJob } from './api';
import { isRunning } from './format';

/**
 * Follows a job to completion.
 *
 * Server-sent events are the primary channel, with polling as a fallback. That is not
 * belt-and-braces for its own sake: a buffering reverse proxy will happily hold an event
 * stream open and deliver nothing, and a progress bar that silently stops moving is
 * worse than one that updates a little less often. If the stream produces nothing within
 * a few seconds, or errors, the hook quietly switches to polling and the user sees no
 * difference.
 */

const STREAM_GRACE_MS = 6_000;
const POLL_INTERVAL_MS = 700;

export interface UseJobResult {
  readonly job: Job | undefined;
  /** True while a transport is attached and the job has not finished. */
  readonly following: boolean;
}

export function useJob(jobId: string | undefined, initial?: Job): UseJobResult {
  const [job, setJob] = useState<Job | undefined>(initial);
  const [following, setFollowing] = useState(false);
  // Guards against a late event from a previous job overwriting the current one.
  const activeId = useRef<string | undefined>(undefined);

  const apply = useCallback((next: Job) => {
    if (next.id !== activeId.current) return;
    setJob((previous) => {
      if (!previous) return next;
      // Progress is monotonic; an out-of-order delivery must not rewind the bar.
      if (previous.progress.percent > next.progress.percent && isRunning(next.state)) {
        return { ...next, progress: previous.progress };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!jobId) {
      activeId.current = undefined;
      setFollowing(false);
      return;
    }

    activeId.current = jobId;
    setFollowing(true);

    let stopped = false;
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
      if (stopped) return;
      void getJob(jobId, controller.signal)
        .then((next) => {
          if (stopped) return;
          apply(next);
          if (!isRunning(next.state)) {
            finish();
            return;
          }
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        })
        .catch(() => {
          if (stopped) return;
          // Keep trying: a transient failure should not abandon a running download.
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS * 2);
        });
    };

    const startPolling = (): void => {
      if (stopped || pollTimer) return;
      source?.close();
      source = undefined;
      poll();
    };

    try {
      source = new EventSource(`/api/jobs/${jobId}/events`);

      const onMessage = (raw: MessageEvent<string>): void => {
        sawStreamEvent = true;
        let event: JobEvent;
        try {
          event = JSON.parse(raw.data) as JobEvent;
        } catch {
          return;
        }
        if (event.type === 'ping') return;
        apply(event.job);
        if (!isRunning(event.job.state)) finish();
      };

      for (const type of ['state', 'progress', 'done', 'error'] as const) {
        source.addEventListener(type, onMessage as EventListener);
      }
      source.onerror = () => {
        // EventSource retries on its own, but a proxy that never flushes looks identical
        // to a healthy idle stream. Falling back is the only way to tell.
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
  }, [jobId, apply]);

  return { job, following };
}
