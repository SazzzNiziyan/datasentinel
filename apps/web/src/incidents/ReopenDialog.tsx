import { REOPEN_REASON_MAX } from '@datasentinel/contracts';
import { NoteDialog } from './NoteDialog.tsx';

/** Reopening a resolved incident needs a reason (D-84). */
export function ReopenDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (reason: string) => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <NoteDialog
      title="Reopen incident"
      fieldLabel="Reason"
      maxLength={REOPEN_REASON_MAX}
      emptyMessage="Give a reason."
      submitLabel="Reopen incident"
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
