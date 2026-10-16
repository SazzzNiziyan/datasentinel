import type { DependencyName, ReadinessReport } from '@datasentinel/contracts';
import { useEffect, useState } from 'react';

export type ApiHealth =
  | { state: 'checking' }
  | { state: 'connected' }
  | { state: 'degraded'; down: DependencyName[] }
  | { state: 'unreachable' };

const POLL_MS = 30_000;
const TIMEOUT_MS = 5_000;

function isReport(body: unknown): body is ReadinessReport {
  if (typeof body !== 'object' || body === null) return false;
  const { status, dependencies } = body as Record<string, unknown>;
  return (
    (status === 'ready' || status === 'not_ready') &&
    typeof dependencies === 'object' &&
    dependencies !== null
  );
}

/** Anything other than a well-formed readiness report counts as
 * unreachable: a proxy error page must never read as healthy. */
async function check(baseUrl: string, signal: AbortSignal): Promise<ApiHealth> {
  try {
    const res = await fetch(`${baseUrl}/health/ready`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const body: unknown = await res.json();
    if (!isReport(body) || (res.status !== 200 && res.status !== 503)) {
      return { state: 'unreachable' };
    }
    if (res.status === 200 && body.status === 'ready') return { state: 'connected' };
    const down = Object.entries(body.dependencies)
      .filter(([, state]) => state === 'down')
      .map(([name]) => name as DependencyName);
    return { state: 'degraded', down };
  } catch {
    return { state: 'unreachable' };
  }
}

/** Polls the API's readiness endpoint while mounted. */
export function useApiHealth(baseUrl: string): ApiHealth {
  const [health, setHealth] = useState<ApiHealth>({ state: 'checking' });
  useEffect(() => {
    const controller = new AbortController();
    const run = () =>
      void check(baseUrl, controller.signal).then((next) => {
        if (!controller.signal.aborted) setHealth(next);
      });
    run();
    const timer = setInterval(run, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [baseUrl]);
  return health;
}
