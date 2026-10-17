import type { MeResponse, Role } from '@datasentinel/contracts';
import { createContext, useContext } from 'react';

export type Membership = MeResponse['memberships'][number];

export type SessionState =
  | { status: 'loading' }
  | { status: 'unreachable' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; me: MeResponse; workspace: Membership | undefined };

export interface Session {
  state: SessionState;
  /** Rejects with ApiError so the form can show what went wrong. */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Loads /auth/me again, e.g. after "Try again". */
  refresh: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession needs a SessionProvider');
  return session;
}

/** The signed-in user and active workspace, inside the app shell. */
export function useSignedIn() {
  const { state } = useSession();
  if (state.status !== 'signed_in') throw new Error('useSignedIn outside a signed-in route');
  return state;
}

/** D-02 roles as people say them. */
export const roleLabel: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  engineer: 'Data engineer',
  analyst: 'Analyst',
  viewer: 'Viewer',
};
