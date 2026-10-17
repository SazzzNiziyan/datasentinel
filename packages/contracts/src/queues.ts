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
}
