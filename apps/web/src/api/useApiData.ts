import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from './client.ts';

export type ApiData<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError; retrying: boolean }
  | { status: 'ready'; data: T };

/** Loads one API resource. A retry keeps the error on screen with
 * `retrying` set, so ErrorState keeps its button and focus (D-18). */
export function useApiData<T>(path: string): ApiData<T> & { retry: () => void } {
  const [state, setState] = useState<ApiData<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    apiFetch<T>(path).then(
      (data) => current && setState({ status: 'ready', data }),
      (error: unknown) =>
        current &&
        setState({
          status: 'error',
          error: error instanceof ApiError ? error : new ApiError(0, 'unreachable', 'Failed.'),
          retrying: false,
        }),
    );
    return () => {
      current = false;
    };
  }, [path, attempt]);

  const retry = useCallback(() => {
    setState((s) => (s.status === 'error' ? { ...s, retrying: true } : s));
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, retry };
}
