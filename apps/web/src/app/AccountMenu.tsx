import { sampleSession } from './sampleSession.ts';

const { user, role, workspace } = sampleSession;

/** Account button with role context. Uses the native popover: Escape and
 * clicking outside close it, and focus returns to the button. */
export function AccountMenu() {
  return (
    <>
      <button
        type="button"
        className="account-button"
        popoverTarget="account-menu"
        aria-label={`Account: ${user.name}, ${role}`}
      >
        <span className="account-button__initials" aria-hidden="true">
          {user.initials}
        </span>
        <span className="account-button__text" aria-hidden="true">
          <span className="account-button__name">{user.name}</span>
          <span className="account-button__role">{role}</span>
        </span>
      </button>
      <div id="account-menu" className="account-menu" popover="auto">
        <p className="account-menu__name">{user.name}</p>
        <p className="account-menu__detail">{user.email}</p>
        <dl className="account-menu__facts">
          <dt>Role</dt>
          <dd>{role}</dd>
          <dt>Workspace</dt>
          <dd>{workspace.name}</dd>
        </dl>
        <p className="account-menu__note">
          Sample account. Sign-in and role management arrive with workspace access.
        </p>
      </div>
    </>
  );
}
