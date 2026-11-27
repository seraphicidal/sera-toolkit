'use client';

import { useEffect, useRef } from 'react';
import type { Job } from '@sera/contracts/types';
import { isRunning } from '@/lib/format';
import { useJob } from '@/lib/use-job';
import { SpinnerIcon } from './icons';
import { ProgressPanel } from './progress-panel';
import { ResultPanel } from './result-panel';

export function ActiveJobPanel({
  jobId,
  initialJob,
  submitting,
  onReady,
  onFailed,
  onCancel,
  onReset,
  onDownloadAgain,
  downloadAgainLabel,
  hasNextInBatch,
  batchNextLabel,
  onNextInBatch,
}: {
  readonly jobId: string | undefined;
  readonly initialJob: Job | undefined;
  readonly submitting: boolean;
  readonly onReady: (job: Job) => void;
  readonly onFailed: (job: Job) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  readonly onDownloadAgain?: () => void;
  readonly downloadAgainLabel?: string;
  readonly hasNextInBatch?: boolean;
  readonly batchNextLabel?: string;
  readonly onNextInBatch?: () => void;
}) {
  const { job, reconnecting } = useJob(jobId, initialJob);
  const notifiedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!job || !jobId || job.id !== jobId) return;
    if (job.state === 'ready') {
      if (notifiedIdRef.current !== `${job.id}:ready`) {
        notifiedIdRef.current = `${job.id}:ready`;
        onReady(job);
      }
      return;
    }
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'expired') {
      if (notifiedIdRef.current !== `${job.id}:${job.state}`) {
        notifiedIdRef.current = `${job.id}:${job.state}`;
        onFailed(job);
      }
    }
  }, [job, jobId, onReady, onFailed]);

  if (job?.state === 'ready' && job.result) {
    return (
      <ResultPanel
        job={job}
        onReset={onReset}
        onDownloadAgain={onDownloadAgain}
        downloadAgainLabel={downloadAgainLabel}
        hasNextInBatch={hasNextInBatch}
        batchNextLabel={batchNextLabel}
        onNextInBatch={onNextInBatch}
      />
    );
  }

  if (job && isRunning(job.state)) {
    return <ProgressPanel job={job} reconnecting={reconnecting} onCancel={onCancel} />;
  }

  if (submitting || (jobId && !job)) {
    return <QueuedNotice />;
  }

  return null;
}

function QueuedNotice() {
  return (
    <section
      role="status"
      aria-live="polite"
      className="animate-fade-up flex items-center gap-2.5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <SpinnerIcon size={17} className="text-[var(--color-accent)]" />
      <p className="text-[0.9375rem] text-[var(--color-ink-muted)]">Starting…</p>
    </section>
  );
}
