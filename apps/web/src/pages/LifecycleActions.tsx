import type { LifecycleStatus, Role } from '@datasentinel/contracts';
import { useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { canArchive, canEdit } from './labels.ts';
import './LifecycleActions.css';

interface LifecycleActionsProps {
  kind: 'source' | 'dataset';
  workspaceId: string;
  id: string;
  /** Names the target in button labels and the archive dialog. */
  name: string;
  status: LifecycleStatus;
  role: Role;
  /** After a change, so the caller reloads. */
  onChanged: () => void;
}

const archiveEffect = {
  source:
    'Archives the source and all its datasets. Checks and uploads stop; their history stays readable. This cannot be undone here.',
  dataset:
    'Archives the dataset. Checks and uploads stop; its history stays readable. This cannot be undone here.',
};

/** Pause or resume (data engineer and above) and archive (administrator
 * and above) for one source or dataset (D-45). Archived items show none. */
export function LifecycleActions({
  kind,
  workspaceId,
  id,
  name,
  status,
  role,
  onChanged,
}: LifecycleActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A ref as well: a second click can land before React re-renders.
  const running = useRef(false);
  const path = `/workspaces/${workspaceId}/${kind === 'source' ? 'sources' : 'datasets'}/${id}`;

  if (status === 'archived' || !canEdit(role)) return null;

  async function toggle() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      await apiFetch(`${path}/${status === 'active' ? 'pause' : 'resume'}`, { method: 'POST' });
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? [e.message, e.detail].filter(Boolean).join(' ')
          : 'The change did not save.',
      );
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  const action = status === 'active' ? 'Pause' : 'Resume';
  return (
    <div className="lifecycle-actions">
      <div className="lifecycle-actions__buttons">
        <button
          type="button"
          className="button"
          aria-label={`${action} ${name}`}
          aria-disabled={pending}
          onClick={() => void toggle()}
        >
          {action}
        </button>
        {canArchive(role) && (
          <button
            type="button"
            className="button"
            aria-label={`Archive ${name}`}
            onClick={() => setConfirming(true)}
          >
            Archive
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="lifecycle-actions__error">
          {error}
        </p>
      )}
      {/* Mounted only while asked, so table rows hold no hidden dialogs. */}
      {confirming && (
        <ConfirmActionDialog
          open
          title={kind === 'source' ? 'Archive this source?' : 'Archive this dataset?'}
          target={name}
          effect={archiveEffect[kind]}
          permission="Administrator or owner"
          confirmLabel={kind === 'source' ? 'Archive source' : 'Archive dataset'}
          onConfirm={async () => {
            await apiFetch(path, { method: 'DELETE' });
            setConfirming(false);
            onChanged();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
