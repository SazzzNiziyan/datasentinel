import type { MeResponse } from '@datasentinel/contracts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { SessionContext, type SessionState } from './session.ts';

async function loadSession(): Promise<SessionState> {
  try {
    const me = await apiFetch<MeResponse>('/auth/me');
    // One workspace at a time; a switcher comes with more workspaces.
    return { status: 'signed_in', me, workspace: me.memberships[0] };
  } catch (error) {
    return error instanceof ApiError && error.status === 401
      ? { status: 'signed_out' }
      : { status: 'unreachable' };
  }
}

/** Holds the API session (D-34). The session cookie is HttpOnly, so the
 * browser can only learn who is signed in by asking /auth/me. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void loadSession().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await apiFetch('/auth/sessions', { method: 'POST', body: JSON.stringify({ email, password }) });
    setState(await loadSession());
  }, []);

  const signOut = useCallback(async () => {
    await apiFetch('/auth/sessions/current', { method: 'DELETE' });
    setState({ status: 'signed_out' });
  }, []);

  return (
    <SessionContext.Provider value={{ state, signIn, signOut, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}
