import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { useSession } from './session.ts';
import './RequireSession.css';

/** Shows the app only to a signed-in member of a workspace; otherwise the
 * matching state: loading, API unreachable, sign-in, or no workspace. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { state, refresh, signOut } = useSession();
  const location = useLocation();

  switch (state.status) {
    case 'loading':
      return (
        <main className="session-gate">
          <LoadingState label="Loading your workspace" />
        </main>
      );
    case 'unreachable':
      return (
        <main className="session-gate">
          <ErrorState
            title="Can't reach DataSentinel"
            description="The service did not answer. Check your connection, then try again."
            onRetry={refresh}
          />
        </main>
      );
    case 'signed_out':
      // Comes back to the page the user asked for after signing in.
      return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
    case 'signed_in':
      if (state.workspace === undefined) {
        return (
          <main className="session-gate">
            <h1 className="visually-hidden">No workspace</h1>
            <EmptyState
              title="You're not in a workspace yet"
              description="Ask a workspace administrator to add you. You will see the workspace here after they do."
              action={
                <button type="button" className="button" onClick={() => void signOut()}>
                  Sign out
                </button>
              }
            />
          </main>
        );
      }
      return children;
  }
}
