import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';

interface BoundaryProps {
  children: ReactNode;
}

// Error boundaries must still be classes in React 19.
class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    // The error itself is never shown: it can contain internals.
    // React already logs it to the console for developers.
    return (
      <PageFrame title="Page error">
        <ErrorState
          title="This page failed to display"
          description="Reload the page to try again. If it keeps failing, use the navigation to go to another page."
          onRetry={() => window.location.reload()}
          retryLabel="Reload page"
        />
      </PageFrame>
    );
  }
}

/** Catches a crash in one page so the shell and navigation keep working.
 * Keyed by path: navigating elsewhere starts with a fresh boundary. */
export function RouteErrorBoundary({ children }: BoundaryProps) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
