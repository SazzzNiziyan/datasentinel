import { RESOLUTION_NOTE_MAX } from '@datasentinel/contracts';
import { NoteDialog } from './NoteDialog.tsx';

/** Resolving needs a note that stays with the incident (D-84). */
export function ResolveDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (note: string) => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <NoteDialog
      title="Resolve incident"
      fieldLabel="Resolution note"
      maxLength={RESOLUTION_NOTE_MAX}
      help="Say what was wrong and what fixed it. The note stays with the incident."
      emptyMessage="Write a resolution note."
      submitLabel="Resolve incident"
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
