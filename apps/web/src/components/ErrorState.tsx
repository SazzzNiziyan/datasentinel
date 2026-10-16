import { useId, useState } from 'react';
import { Shape } from './Shape.tsx';
import './ErrorState.css';

interface ErrorStateProps {
  /** What failed, e.g. "Could not load incidents". */
  title: string;
  /** What to do next. Never the raw error: it can expose internals. */
  description: string;
  /** Offers a retry button. Omit when trying again cannot help. */
  onRetry?: () => void;
  retryLabel?: string;
  /** True while the retry runs. The button stays in place, so keyboard
   * focus is kept, instead of being swapped for a loading state. */
  retrying?: boolean;
  /** Support reference, e.g. the request ID from the problem response. */
  reference?: string;
}

/** A page or section that failed to load: what failed, what to do, and
 * a reference support can trace. */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = 'Try again',
  retrying = false,
  reference,
}: ErrorStateProps) {
  const titleId = useId();
  // Remember whether a retry has finished while this state stayed on
  // screen: that means it failed again, which must be announced too.
  const [wasRetrying, setWasRetrying] = useState(retrying);
  const [failedAgain, setFailedAgain] = useState(false);
  if (retrying !== wasRetrying) {
    setWasRetrying(retrying);
    if (!retrying) setFailedAgain(true);
  }

  const status = retrying ? 'Trying again…' : failedAgain ? 'That attempt failed too.' : '';

  return (
    <section className="error-state" role="alert" aria-labelledby={titleId}>
      <h2 id={titleId} className="error-state__title">
        <Shape kind="square" />
        {title}
      </h2>
      <p className="error-state__description">{description}</p>
      {reference !== undefined && (
        <p className="error-state__reference">
          Reference <code>{reference}</code>
        </p>
      )}
      {onRetry !== undefined && (
        <div className="error-state__actions">
          <button
            type="button"
            className="button button--primary"
            // aria-disabled, not disabled: a disabled button drops focus.
            aria-disabled={retrying || undefined}
            onClick={() => {
              if (!retrying) onRetry();
            }}
          >
            {retryLabel}
          </button>
          <p role="status" className="error-state__status">
            {status}
          </p>
        </div>
      )}
    </section>
  );
}
