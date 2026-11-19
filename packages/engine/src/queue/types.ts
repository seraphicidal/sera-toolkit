import type { Job, JobError, JobProgress, JobResult, JobState } from '@sera/contracts/types';
import type { JobSpec } from '../jobs/runner.js';

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
  readonly spec: JobSpec;
  readonly clientKey: string;
  readonly uncounted?: boolean;
}

export type JobPatch = Partial<Pick<JobRecord, 'state' | 'step' | 'progress' | 'result' | 'error'>>;

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
  close(): Promise<void>;
}

export interface JobBackend {
  readonly driver: 'memory' | 'redis';

  submit(record: JobRecord): Promise<void>;

  get(id: string): Promise<JobRecord | undefined>;

  patch(id: string, patch: JobPatch): Promise<JobRecord | undefined>;

  subscribe(id: string, listener: (record: JobRecord) => void): () => void;

  waitingCount(): Promise<number>;

  activeCountFor(clientKey: string): Promise<number>;

  startWorker(handler: JobHandler, concurrency: number): WorkerHandle;

  close(): Promise<void>;
}

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
