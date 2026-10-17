import type { DatasetDetail, DiscoveredTable, TableDiscovery } from '@datasentinel/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, apiFetch } from '../api/client.ts';
import { LoadingState } from '../components/LoadingState.tsx';
import './RegisterTableDialog.css';

const kindLabel: Record<DiscoveredTable['kind'], string> = {
  table: 'Table',
  view: 'View',
  materialized_view: 'Materialized view',
  foreign_table: 'Foreign table',
};

type Load =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail?: string }
  | { status: 'ready'; discovery: TableDiscovery };

const keyOf = (t: DiscoveredTable) => `${t.schema}.${t.name}`;

/** Lists the tables a database source's login can read and registers the
 * chosen one as a dataset (D-51), then opens it. */
export function RegisterTableDialog({
  workspaceId,
  sourceId,
  sourceName,
  onClose,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<DiscoveredTable | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    let current = true;
    apiFetch<TableDiscovery>(`/workspaces/${workspaceId}/sources/${sourceId}/discoveries`, {
      method: 'POST',
    }).then(
      (discovery) => current && setLoad({ status: 'ready', discovery }),
      (e: unknown) =>
        current &&
        setLoad(
          e instanceof ApiError
            ? { status: 'error', title: e.message, detail: e.detail }
            : { status: 'error', title: 'The tables could not be listed.' },
        ),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, sourceId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const dataset = await apiFetch<DatasetDetail>(`/workspaces/${workspaceId}/datasets`, {
        method: 'POST',
        body: JSON.stringify({
          sourceId,
          schema: chosen.schema,
          table: chosen.name,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
        }),
      });
      onClose();
      void navigate(`/datasets/${dataset.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The dataset could not be registered.');
    } finally {
      setSaving(false);
    }
  }

  const needle = filter.trim().toLowerCase();
  const tables =
    load.status === 'ready'
      ? load.discovery.tables.filter((t) => keyOf(t).toLowerCase().includes(needle))
      : [];

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
        Add a dataset from {sourceName}
      </h2>
      {load.status === 'loading' && <LoadingState label="Listing tables" />}
      {load.status === 'error' && (
        <div role="alert" className="register-dialog__error">
          <p>{load.title}</p>
          {load.detail !== undefined && <p>{load.detail}</p>}
        </div>
      )}
      {load.status === 'ready' && (
        <form className="register-dialog__form" onSubmit={(e) => void submit(e)}>
          <label className="register-dialog__field">
            Find a table
            <input
              className="text-input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <fieldset className="register-dialog__tables">
            <legend>Readable tables and views ({tables.length})</legend>
            {tables.length === 0 && (
              <p className="register-dialog__help">
                {load.discovery.tables.length === 0
                  ? 'The login cannot read any table. Grant SELECT on the tables to check.'
                  : 'No table matches.'}
              </p>
            )}
            {tables.map((t) => (
              <label key={keyOf(t)} className="register-dialog__table">
                <input
                  type="radio"
                  name="table"
                  checked={chosen !== null && keyOf(chosen) === keyOf(t)}
                  onChange={() => setChosen(t)}
                />
                <span className="mono">{keyOf(t)}</span>
                <span className="register-dialog__meta">
                  {kindLabel[t.kind]}
                  {t.estimatedRows !== null &&
                    `, about ${t.estimatedRows.toLocaleString('en-US')} rows`}
                </span>
              </label>
            ))}
            {load.discovery.truncated && (
              <p className="register-dialog__help">
                Only the first 1,000 are listed. Type to narrow the list.
              </p>
            )}
          </fieldset>
          <label className="register-dialog__field">
            Name (optional)
            <input
              className="text-input"
              maxLength={120}
              placeholder={chosen?.name ?? 'Defaults to the table name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
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
            <button
              type="submit"
              className="button button--primary"
              disabled={chosen === null || saving}
            >
              Register dataset
            </button>
          </div>
        </form>
      )}
      {load.status !== 'ready' && (
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </dialog>
  );
}
