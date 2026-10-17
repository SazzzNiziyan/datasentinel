/** Queue and job names shared by the API (producer) and worker (consumer).
 * Job data holds IDs and safe values only, never secrets (docs/08). */

/** Internal housekeeping jobs. */
export const SYSTEM_QUEUE = 'system';

/** Harmless job that proves API, Redis, and worker are wired together. */
export const PING_JOB = 'ping';

export interface PingJobData {
  /** ISO time the job was added. */
  sentAt: string;
}

export interface PingJobResult {
  pong: true;
  sentAt: string;
}

/** CSV parsing and profiling. */
export const UPLOAD_QUEUE = 'uploads';

/** Parses one completed upload. The job ID is the upload ID, so a repeated
 * completion cannot queue the same file twice. */
export const PARSE_UPLOAD_JOB = 'parse-upload';

export interface ParseUploadJobData {
  workspaceId: string;
  uploadId: string;
}

/** Source jobs such as connection tests (D-49). */
export const SOURCE_QUEUE = 'sources';

/** Tests one source's connection. The job ID is the test ID. */
export const TEST_CONNECTION_JOB = 'test-connection';

export interface TestConnectionJobData {
  workspaceId: string;
  connectionTestId: string;
}

/** Lists a source's readable tables (D-50). The API waits for the result. */
export const DISCOVER_TABLES_JOB = 'discover-tables';

export interface DiscoverTablesJobData {
  workspaceId: string;
  sourceId: string;
}

/** Profiles one database dataset (D-52). Job ID `profile-<datasetId>`, so
 * one run per dataset is pending at a time. */
export const PROFILE_DATASET_JOB = 'profile-dataset';

export interface ProfileDatasetJobData {
  workspaceId: string;
  datasetId: string;
  /** Set by the scheduler: the dataset's rules are queued after the
   * profile finishes (D-71). */
  occurrenceId?: string;
}

/** Runs one queued check (D-59). Job ID `check-<checkRunId>`; the run row
 * is claimed once, so a repeated delivery does nothing. */
export const RUN_CHECK_JOB = 'run-check';

export interface RunCheckJobData {
  workspaceId: string;
  checkRunId: string;
}

/** What a queue keeps of finished jobs (BullMQ `removeOnComplete` and
 * `removeOnFail` values; `age` is in seconds). */
export type JobRetention = boolean | { age: number; count?: number } | { count: number };

/** Options every producer passes to `queue.add` (D-77). */
export interface JobOptions {
  jobId: string;
  attempts: number;
  backoff?: { type: 'exponential'; delay: number };
  removeOnComplete: JobRetention;
  removeOnFail: JobRetention;
}

/** Terminally failed jobs stay this long, up to this many, so an operator
 * can see them (D-77). Job data holds IDs only, never secrets. */
export const FAILED_JOB_RETENTION = { age: 7 * 24 * 60 * 60, count: 1000 } as const;
/** First retry delay; each further retry doubles it (5 s, 10 s, ...). */
export const RETRY_BASE_DELAY_MS = 5000;

interface JobPolicy {
  /** Total tries, the first included. */
  attempts: number;
  complete: JobRetention;
  failed: JobRetention;
}

/** Retries and retention per job (D-77). A job tried once is one where the
 * person who asked sees the result and decides to try again. A job whose ID
 * repeats while it is pending (`profile-dataset`) must not keep failed
 * jobs: a kept job would make the queue ignore the next job with that ID. */
export const JOB_POLICIES: Record<string, JobPolicy> = {
  [TEST_CONNECTION_JOB]: { attempts: 1, complete: { count: 1000 }, failed: FAILED_JOB_RETENTION },
  [RUN_CHECK_JOB]: { attempts: 3, complete: true, failed: FAILED_JOB_RETENTION },
  [PROFILE_DATASET_JOB]: { attempts: 2, complete: true, failed: true },
  [PARSE_UPLOAD_JOB]: { attempts: 3, complete: { count: 1000 }, failed: FAILED_JOB_RETENTION },
  // The answer holds table names and leaves Redis within a minute.
  [DISCOVER_TABLES_JOB]: { attempts: 1, complete: { age: 60 }, failed: { age: 60 } },
};

/** The options for adding one job. Unknown jobs throw: a new job needs a
 * deliberate policy, not a default. */
export function jobOptions(name: string, jobId: string): JobOptions {
  const policy = JOB_POLICIES[name];
  if (policy === undefined) throw new Error(`No retry policy for job "${name}"`);
  return {
    jobId,
    attempts: policy.attempts,
    ...(policy.attempts > 1
      ? { backoff: { type: 'exponential' as const, delay: RETRY_BASE_DELAY_MS } }
      : {}),
    removeOnComplete: policy.complete,
    removeOnFail: policy.failed,
  };
}

/** A queue job an operator should look at (D-78). `failed`: out of
 * attempts. `stalled`: still waiting or running 15 minutes after it was
 * added. Job data is never shown, only these fields. */
export interface QueueJobSummary {
  queue: string;
  jobId: string;
  /** The job kind, e.g. `run-check`. */
  name: string;
  state: 'failed' | 'stalled';
  attemptsMade: number;
  attempts: number;
  addedAt: string;
  finishedAt: string | null;
  /** First line of the failure, redacted and cut to 200 characters. */
  failure: string | null;
}

export interface QueueJobList {
  jobs: QueueJobSummary[];
  /** Jobs beyond the 100 shown, so the list is never silently cut. */
  omitted: number;
}
