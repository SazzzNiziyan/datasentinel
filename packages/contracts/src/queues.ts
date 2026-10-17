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
