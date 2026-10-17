import { useState } from 'react';
import { roleLabel, useSession, useSignedIn } from './session.ts';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** Account button with role context. Uses the native popover: Escape and
 * clicking outside close it, and focus returns to the button. */
export function AccountMenu() {
  const { me, workspace } = useSignedIn();
  const { signOut } = useSession();
  const [failed, setFailed] = useState(false);
  const { user } = me;
  const role = workspace === undefined ? '' : roleLabel[workspace.role];

  return (
    <>
      <button
        type="button"
        className="account-button"
        popoverTarget="account-menu"
        aria-label={`Account: ${user.displayName}, ${role}`}
      >
        <span className="account-button__initials" aria-hidden="true">
          {initials(user.displayName)}
        </span>
        <span className="account-button__text" aria-hidden="true">
          <span className="account-button__name">{user.displayName}</span>
          <span className="account-button__role">{role}</span>
        </span>
      </button>
      <div id="account-menu" className="account-menu" popover="auto">
        <p className="account-menu__name">{user.displayName}</p>
        <p className="account-menu__detail">{user.email}</p>
        <dl className="account-menu__facts">
          <dt>Role</dt>
          <dd>{role}</dd>
          <dt>Workspace</dt>
          <dd>{workspace?.workspaceName}</dd>
        </dl>
        <button
          type="button"
          className="button"
          onClick={() => {
            setFailed(false);
            signOut().catch(() => setFailed(true));
          }}
        >
          Sign out
        </button>
        {failed && (
          <p role="alert" className="account-menu__note">
            Sign-out did not reach the server, so you are still signed in. Check your connection and
            try again.
          </p>
        )}
      </div>
    </>
  );
}
