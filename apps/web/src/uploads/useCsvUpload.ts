import {
  CSV_LIMITS,
  type UploadCreated,
  type UploadDetail,
  type UploadFailure,
} from '@datasentinel/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { hashFile } from './hashFile.ts';
import { putFile as defaultPutFile, type PutFile } from './putFile.ts';

/** The three steps the user watches, in order. */
export type UploadStep = 'read' | 'send' | 'check';

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'reading'; progress: number }
  | { phase: 'sending'; progress: number }
  /** `slow`: polling stopped; the result will show on the dataset page. */
  | { phase: 'checking'; upload: UploadDetail; slow: boolean }
  | { phase: 'succeeded'; upload: UploadDetail }
  | { phase: 'failed'; step: UploadStep; title: string; hint?: string; upload?: UploadDetail };

export interface UploadRequest {
  workspaceId: string;
  sourceId: string;
  file: File;
  /** An existing dataset, or the name of a new one (D-10). */
  target: { datasetId: string } | { newDatasetName: string };
}

const POLL_MS = 1000;
const POLL_LIMIT = 120;

const MB = 1024 * 1024;

const fromFailure = (upload: UploadDetail, error: UploadFailure | null): UploadState => ({
  phase: 'failed',
  step: 'check',
  title: error?.message ?? 'The file could not be checked.',
  hint: error?.hint,
  upload,
});

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Runs one CSV upload: hash the file in chunks, start the upload, send
 * the file straight to storage, complete it, then follow the check until
 * it succeeds or fails (D-44). Leaving the page cancels it. */
export function useCsvUpload(putFile: PutFile = defaultPutFile) {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const reset = useCallback(() => {
    controller.current?.abort();
    setState({ phase: 'idle' });
  }, []);

  const start = useCallback(
    async ({ workspaceId, sourceId, file, target }: UploadRequest) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const { signal } = abort;
      const set = (next: UploadState) => !signal.aborted && setState(next);

      if (file.size === 0) {
        set({ phase: 'failed', step: 'read', title: 'This file is empty.' });
        return;
      }
      if (file.size > CSV_LIMITS.maxBytes) {
        set({
          phase: 'failed',
          step: 'read',
          title: `This file is larger than ${CSV_LIMITS.maxBytes / MB} MB.`,
          hint: 'Split it into smaller files and upload each one.',
        });
        return;
      }

      let step: UploadStep = 'read';
      try {
        set({ phase: 'reading', progress: 0 });
        const checksumSha256 = await hashFile(
          file,
          (progress) => set({ phase: 'reading', progress }),
          signal,
        );

        step = 'send';
        set({ phase: 'sending', progress: 0 });
        const created = await apiFetch<UploadCreated>(
          `/workspaces/${workspaceId}/sources/${sourceId}/uploads`,
          {
            method: 'POST',
            body: JSON.stringify({
              filename: file.name,
              sizeBytes: file.size,
              checksumSha256,
              ...target,
            }),
            signal,
          },
        );
        try {
          await putFile(
            created.instructions,
            file,
            (progress) => set({ phase: 'sending', progress }),
            signal,
          );
        } catch (error) {
          if (isAbort(error)) return;
          set({
            phase: 'failed',
            step: 'send',
            title: 'The file could not be sent to storage.',
            hint: 'Check your connection, then upload the file again.',
          });
          return;
        }

        step = 'check';
        const path = `/workspaces/${workspaceId}/uploads/${created.upload.id}`;
        let upload = await apiFetch<UploadDetail>(`${path}/complete`, { method: 'POST', signal });
        for (let tries = 0; upload.status === 'queued' || upload.status === 'parsing'; tries++) {
          if (tries === POLL_LIMIT) {
            set({ phase: 'checking', upload, slow: true });
            return;
          }
          set({ phase: 'checking', upload, slow: false });
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (signal.aborted) return;
          upload = await apiFetch<UploadDetail>(path, { signal });
        }
        set(
          upload.status === 'succeeded'
            ? { phase: 'succeeded', upload }
            : fromFailure(upload, upload.error),
        );
      } catch (error) {
        if (isAbort(error) || signal.aborted) return;
        set({
          phase: 'failed',
          step,
          title: error instanceof ApiError ? error.message : 'The upload stopped unexpectedly.',
          hint: error instanceof ApiError ? error.detail : 'Upload the file again.',
        });
      }
    },
    [putFile],
  );

  return { state, start, reset };
}
