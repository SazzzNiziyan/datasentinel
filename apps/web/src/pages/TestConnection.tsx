import type { ConnectionTestDetail } from '@datasentinel/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { StatusMark } from '../components/StatusMark.tsx';

const POLL_MS = 1000;
const POLL_LIMIT = 30;

type State =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; test: ConnectionTestDetail }
  | { phase: 'error'; message: string };

/** Starts a connection test for a database source and follows it to its
 * result (D-49). Shows only the safe message and hint. */
export function TestConnection({
  workspaceId,
  sourceId,
  name,
  onFinished,
}: {
  workspaceId: string;
  sourceId: string;
  name: string;
  /** After a result, e.g. to refresh "Last check". */
  onFinished: () => void;
}) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  async function run() {
    if (state.phase === 'testing') return;
    setState({ phase: 'testing' });
    try {
      let test = await apiFetch<ConnectionTestDetail>(
        `/workspaces/${workspaceId}/sources/${sourceId}/connection-tests`,
        { method: 'POST' },
      );
      for (
        let i = 0;
        (test.status === 'queued' || test.status === 'running') && i < POLL_LIMIT;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!alive.current) return;
        test = await apiFetch<ConnectionTestDetail>(
          `/workspaces/${workspaceId}/connection-tests/${test.id}`,
        );
      }
      if (!alive.current) return;
      if (test.status === 'queued' || test.status === 'running') {
        setState({ phase: 'error', message: 'The test is still running. Check again shortly.' });
        return;
      }
      setState({ phase: 'done', test });
      onFinished();
    } catch (e) {
      if (alive.current) {
        setState({
          phase: 'error',
          message: e instanceof ApiError ? e.message : 'The test could not start.',
        });
      }
    }
  }

  return (
    <div className="test-connection" aria-live="polite">
      <button
        type="button"
        className="button"
        aria-label={`Test connection to ${name}`}
        aria-disabled={state.phase === 'testing'}
        onClick={() => void run()}
      >
        {state.phase === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {state.phase === 'done' && state.test.status === 'succeeded' && (
        <StatusMark
          tone="healthy"
          label={`Connected: PostgreSQL ${state.test.serverVersion ?? ''}, ${state.test.latencyMs ?? 0} ms`}
        />
      )}
      {state.phase === 'done' && state.test.status === 'failed' && (
        <span className="test-connection__failed">
          <StatusMark tone="critical" label={state.test.error?.message ?? 'Failed'} />
          {state.test.error?.hint && (
            <span className="test-connection__hint">{state.test.error.hint}</span>
          )}
        </span>
      )}
      {state.phase === 'error' && (
        <span role="alert" className="test-connection__hint">
          {state.message}
        </span>
      )}
    </div>
  );
}
