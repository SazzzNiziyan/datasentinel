import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import './RegisterTableDialog.css';

/** Replaces a database source's username and password (D-53). Both fields
 * are write-only: nothing is prefilled, and the password is cleared after
 * every send. */
export function RotateLoginDialog({
  workspaceId,
  sourceId,
  sourceName,
  onClose,
  onRotated,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  onClose: () => void;
  onRotated: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/sources/${sourceId}/credentials/rotate`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onRotated();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The login could not be replaced.');
    } finally {
      setPassword('');
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="register-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="register-dialog__title">
        Replace the login for {sourceName}
      </h2>
      <form className="register-dialog__form" onSubmit={(e) => void submit(e)}>
        <p className="register-dialog__meta">
          Change the password in PostgreSQL first, then enter it here. The current login stops being
          used at once.
        </p>
        <label className="register-dialog__field">
          Username
          <input
            className="text-input"
            required
            maxLength={63}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="register-dialog__field">
          New password
          <input
            className="text-input"
            type="password"
            required
            maxLength={1024}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error !== null && (
          <p role="alert" className="register-dialog__error">
            {error}
          </p>
        )}
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving}>
            Replace login
          </button>
        </div>
      </form>
    </dialog>
  );
}
