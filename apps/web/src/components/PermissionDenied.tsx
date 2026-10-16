import { useId, type ReactNode } from 'react';
import './PermissionDenied.css';

interface PermissionDeniedProps {
  /** What the user cannot do, e.g. "You can't change alert routing". */
  title: string;
  currentRole: string;
  /** The lowest role that can, e.g. "Administrator or Owner". */
  requiredRole: string;
  /** Who can grant access. */
  contact: string;
  /** Optional way out, e.g. a link back to the overview. */
  action?: ReactNode;
}

/** The user is signed in but their role does not allow this. Not an error,
 * so it is neutral, not red, and offers no retry. The server enforces the
 * rule; this only explains it. */
export function PermissionDenied({
  title,
  currentRole,
  requiredRole,
  contact,
  action,
}: PermissionDeniedProps) {
  const titleId = useId();
  return (
    <section className="permission-denied" aria-labelledby={titleId}>
      <h2 id={titleId} className="permission-denied__title">
        {title}
      </h2>
      <dl className="permission-denied__roles">
        <dt>Your role</dt>
        <dd>{currentRole}</dd>
        <dt>Needed</dt>
        <dd>{requiredRole}</dd>
      </dl>
      <p>{contact}</p>
      {action !== undefined && <div className="permission-denied__action">{action}</div>}
    </section>
  );
}
