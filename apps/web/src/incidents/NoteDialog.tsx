import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import '../pages/RegisterTableDialog.css';

export interface NoteDialogProps {
  title: string;
  fieldLabel: string;
  maxLength: number;
  help?: string;
  /** Shown when the text is empty or only spaces. */
  emptyMessage: string;
  submitLabel: string;
  /** Sends the change. Returns an error text to keep the dialog open, or null. */
  onSubmit: (text: string) => Promise<string | null>;
  onClose: () => void;
}

/** A modal with one required text field, shared by resolving and reopening. */
export function NoteDialog({
  title,
  fieldLabel,
  maxLength,
  help,
  emptyMessage,
  submitLabel,
  onSubmit,
  onClose,
}: NoteDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const helpId = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (text.trim() === '') {
      setError(emptyMessage);
      return;
    }
    setSaving(true);
    setError(null);
    const problem = await onSubmit(text.trim());
    if (problem === null) {
      onClose();
      return;
    }
    setError(problem);
    setSaving(false);
  }

  return (
    <dialog
      ref={dialog}
      className="register-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
      <h2 id={titleId} className="register-dialog__title">
        {title}
      </h2>
      <form className="register-dialog__form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="register-dialog__field">
          <label htmlFor={fieldId}>{fieldLabel}</label>
          <textarea
            id={fieldId}
            className="text-input"
            required
            rows={4}
            maxLength={maxLength}
            aria-describedby={help === undefined ? undefined : helpId}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {help !== undefined && (
            <span id={helpId} className="register-dialog__help">
              {help}
            </span>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="register-dialog__error">
            {error}
          </p>
        )}
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={saving || undefined}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
