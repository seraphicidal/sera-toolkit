import type { Job, JobError, JobProgress, JobResult, JobState } from '@sera/contracts/types';
import type { JobSpec } from '../jobs/runner.js';

/** Everything stored about a job. `spec` never leaves the server. */
export interface JobRecord {
  readonly id: string;
  readonly state: JobState;
  readonly step: string;
  readonly progress: JobProgress;
  readonly provider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: JobResult;
  readonly error?: JobError;
  /** How to run it. Server-side only. */
  readonly spec: JobSpec;
  /** Opaque per-client key used for concurrency accounting. Never logged. */
  readonly clientKey: string;
}

export type JobPatch = Partial<Pick<JobRecord, 'state' | 'step' | 'progress' | 'result' | 'error'>>;

/** The client-facing projection of a record. */
export function toPublicJob(record: JobRecord): Job {
  return {
    id: record.id,
    state: record.state,
    step: record.step,
    progress: record.progress,
    provider: record.provider,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

export type JobHandler = (record: JobRecord) => Promise<void>;

export interface WorkerHandle {
  /** Stops accepting work and waits for in-flight jobs to finish. */
  close(): Promise<void>;
}

/**
 * Storage and dispatch for jobs.
 *
 * One interface covers both deployment shapes. The in-process driver runs the API and
 * its workers in a single container, which is what most self-hosted installs want. The
 * Redis driver puts a queue between them so workers scale independently. Nothing above
 * this interface knows which one is in use.
 */
export interface JobBackend {
  readonly driver: 'memory' | 'redis';

  /** Stores the record and queues it for a worker. */
  submit(record: JobRecord): Promise<void>;

  get(id: string): Promise<JobRecord | undefined>;

  /** Applies a patch and publishes the updated record to subscribers. */
  patch(id: string, patch: JobPatch): Promise<JobRecord | undefined>;

  /** Streams updates for one job. Returns an unsubscribe function. */
  subscribe(id: string, listener: (record: JobRecord) => void): () => void;

  /** Jobs waiting for a worker, used to shed load before the queue grows without bound. */
  waitingCount(): Promise<number>;

  /** Jobs currently queued or running for one client, for the per-client cap. */
  activeCountFor(clientKey: string): Promise<number>;

  /** Begins processing. Only worker processes call this. */
  startWorker(handler: JobHandler, concurrency: number): WorkerHandle;

  close(): Promise<void>;
}

/** States in which a job still occupies a slot in the per-client concurrency budget. */
export const ACTIVE_STATES: readonly JobState[] = [
  'queued',
  'resolving',
  'downloading',
  'merging',
  'converting',
  'packaging',
  'finalizing',
];

export function isActive(state: JobState): boolean {
  return ACTIVE_STATES.includes(state);
}
