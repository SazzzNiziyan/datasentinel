import type { Problem } from '@datasentinel/contracts';

/** A failed API call: the problem response (D-28), or status 0 when the
 * API could not be reached at all. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const baseUrl = () => import.meta.env.VITE_API_BASE_URL;

/** Calls the API with the session cookie. Resolves with the JSON body, or
 * undefined for 204; rejects with ApiError. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'unreachable', "Can't reach the DataSentinel API.");
  }
  if (res.ok) {
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  const problem = (await res.json().catch(() => null)) as Partial<Problem> | null;
  throw new ApiError(
    res.status,
    problem?.code ?? `http_${res.status}`,
    problem?.title ?? 'The request failed.',
    problem?.detail,
  );
}
