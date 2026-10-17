import type { UploadInstructions } from '@datasentinel/contracts';

/** Sends a file to storage with the signed instructions. XMLHttpRequest,
 * not fetch, because only it reports upload progress. The browser streams
 * the file from disk and sets Content-Length itself. */
export function putFile(
  instructions: UploadInstructions,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(instructions.method, instructions.url);
    for (const [name, value] of Object.entries(instructions.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`storage answered ${xhr.status}`));
    xhr.onerror = () => reject(new Error('storage unreachable'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export type PutFile = typeof putFile;
