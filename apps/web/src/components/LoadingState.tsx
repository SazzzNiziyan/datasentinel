import { useEffect, useState } from 'react';
import './LoadingState.css';

interface LoadingStateProps {
  /** What is loading, e.g. "Loading incidents". The ellipsis is added. */
  label: string;
}

/** Shown while a page or section loads. Nothing shows for the first 400ms:
 * most loads finish sooner, and a message that flashes reads as a glitch.
 * The status region is present from the start and filled later, because
 * screen readers announce changes to a region, not a region that arrives full. */
export function LoadingState({ label }: LoadingStateProps) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="loading-state" role="status">
      {shown && (
        <>
          <p className="loading-state__label">{label}…</p>
          <div className="loading-state__track" aria-hidden="true">
            <div className="loading-state__bar" />
          </div>
        </>
      )}
    </div>
  );
}
