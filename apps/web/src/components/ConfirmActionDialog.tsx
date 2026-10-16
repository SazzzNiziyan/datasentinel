import { useEffect, useId, useRef, useState } from 'react';
import './ConfirmActionDialog.css';

export interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  /** What the action changes, e.g. a dataset or source name. */
  target: string;
  /** The exact effect in plain words. */
  effect: string;
  /** Who may do this, e.g. "Data engineer or above". */
  permission?: string;
  /** Names the action, e.g. "Retry run". Never "OK" or "Submit". */
  confirmLabel: string;
  /** If set, the user must type this text before confirming (D-11 purge). */
  confirmText?: string;
  /** Runs the action. On success the caller must close the dialog (set
   * `open` to false); if it stays open, the action can be run again. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** Confirmation for consequential actions: shows target, effect, and
 * permission, and can never run the action twice from one dialog. */
export function ConfirmActionDialog({
  open,
  title,
  target,
  effect,
  permission,
  confirmLabel,
  confirmText,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A ref, not only state: a second click can arrive before React re-renders.
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  // Trimmed: pasted text often carries a trailing space or newline.
  const typedOk = confirmText === undefined || typed.trim() === confirmText;

  async function confirm() {
    if (running.current || !typedOk) return;
    running.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      // Upstream errors can contain internals; show a safe message only.
      setFailed(true);
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={titleId}
      onClose={() => {
        // The native close event: reset so the next opening starts clean.
        setTyped('');
        setFailed(false);
        // Chromium lets a repeated Escape close a dialog even when cancel is
        // prevented. If the parent still thinks it is open, tell it.
        if (open) onCancel();
      }}
      onCancel={(event) => {
        // Escape: let the caller close it, and never while the action runs.
        event.preventDefault();
        if (!running.current) onCancel();
      }}
    >
      <h2 id={titleId} className="confirm-dialog__title">
        {title}
      </h2>
      <dl className="confirm-dialog__facts">
        <dt>Target</dt>
        <dd>
          <strong>{target}</strong>
        </dd>
        <dt>Effect</dt>
        <dd>{effect}</dd>
        {permission !== undefined && (
          <>
            <dt>Requires</dt>
            <dd>{permission}</dd>
          </>
        )}
      </dl>

      {confirmText !== undefined && (
        <div className="confirm-dialog__type">
          <label htmlFor={inputId}>
            Type <strong>{confirmText}</strong> to confirm
          </label>
          <input
            id={inputId}
            className="text-input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      {/* Always present so screen readers announce the change to "Working". */}
      <p role="status" className="confirm-dialog__status" data-active={pending || undefined}>
        {pending ? 'Working…' : ''}
      </p>

      {failed && (
        <p role="alert" className="confirm-dialog__error">
          The action did not run. Try again, or check the activity log.
        </p>
      )}

      <div className="confirm-dialog__actions">
        <button type="button" className="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void confirm()}
          // aria-disabled, not disabled, while running: a disabled button
          // drops keyboard focus to the page. confirm() ignores repeat clicks.
          disabled={!typedOk}
          aria-disabled={pending || undefined}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
