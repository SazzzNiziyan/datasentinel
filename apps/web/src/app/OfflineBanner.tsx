import { useState } from 'react';
import { StatusMark } from '../components/StatusMark.tsx';
import { useOnlineStatus } from './useOnlineStatus.ts';

/** A strip above the page while the browser is offline. The status region
 * is always present, so screen readers announce the change. */
export function OfflineBanner() {
  const online = useOnlineStatus();
  // Emptying a live region is not announced, so coming back online leaves
  // a short, visually hidden message instead.
  const [wasOnline, setWasOnline] = useState(online);
  const [reconnected, setReconnected] = useState(false);
  if (online !== wasOnline) {
    setWasOnline(online);
    setReconnected(online);
  }

  return (
    <div
      className="shell-banner"
      role="status"
      data-active={!online || undefined}
      data-tone="warning"
    >
      {!online && (
        <>
          <StatusMark tone="warning" label="You're offline." />
          <span>
            What's on screen may be out of date, and changes won't save until the connection is
            back.
          </span>
        </>
      )}
      {reconnected && <span className="visually-hidden">You're back online.</span>}
    </div>
  );
}
