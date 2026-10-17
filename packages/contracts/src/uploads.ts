import { z } from 'zod';

/** CSV limits (D-08). The web checks size before sending; the API and the
 * worker enforce all of them. */
export const CSV_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxColumns: 1000,
  maxRowBytes: 1024 * 1024,
} as const;

/** POST /workspaces/{workspaceId}/sources/{sourceId}/uploads (engineer+).
 * Name an existing dataset of the source, or a new one to create (D-10). */
export const CreateUploadRequest = z
  .object({
    filename: z.string().min(1).max(255),
    sizeBytes: z.number().int().min(1).max(CSV_LIMITS.maxBytes),
    /** SHA-256 of the file, lowercase hex. */
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    datasetId: z.uuid().optional(),
    newDatasetName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => (v.datasetId === undefined) !== (v.newDatasetName === undefined), {
    message: 'Give either datasetId or newDatasetName.',
  });
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export type UploadStatus = 'awaiting_upload' | 'queued' | 'parsing' | 'succeeded' | 'failed';

/** Safe failure text, the same shape as ConnectorFailure.toJSON(). */
export interface UploadFailure {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
}

/** GET /workspaces/{workspaceId}/uploads/{uploadId} */
export interface UploadDetail {
  id: string;
  sourceId: string;
  datasetId: string | null;
  /** Set until completion creates the requested dataset. */
  newDatasetName: string | null;
  filename: string;
  sizeBytes: number;
  status: UploadStatus;
  error: UploadFailure | null;
  /** Set once parsing succeeds; the header row is not counted. */
  rowCount: number | null;
  columnCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** How the browser sends the file: one PUT with exactly these headers. The
 * signature covers the size and checksum, so storage refuses anything else. */
export interface UploadInstructions {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

/** The only response with the signed URL; it is not shown again. */
export interface UploadCreated {
  upload: UploadDetail;
  instructions: UploadInstructions;
}
