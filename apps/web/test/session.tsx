import type { Role } from '@datasentinel/contracts';
import type { ReactNode } from 'react';
import { SessionContext, type Session, type SessionState } from '../src/app/session.ts';

/** A signed-in session for tests, without calling the API. */
export function signedIn(role: Role = 'engineer'): SessionState {
  return {
    status: 'signed_in',
    me: {
      user: { id: 'u1', email: 'ana@northwind.example', displayName: 'Ana Kovac' },
      memberships: [
        { workspaceId: 'w1', workspaceName: 'Northwind Retail', slug: 'northwind', role },
      ],
    },
    workspace: { workspaceId: 'w1', workspaceName: 'Northwind Retail', slug: 'northwind', role },
  };
}

export function fakeSession(
  state: SessionState = signedIn(),
  overrides: Partial<Session> = {},
): Session {
  return {
    state,
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    refresh: () => {},
    ...overrides,
  };
}

export function WithSession({
  session = fakeSession(),
  children,
}: {
  session?: Session;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
