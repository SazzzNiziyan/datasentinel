import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';

type Kind = 'csv' | 'postgres';

const empty = { host: '', port: '5432', database: '', sslMode: 'verify-full', username: '' };

/** Adds a CSV (D-44) or PostgreSQL (D-47) source. The password field is
 * write-only: it is sent once, cleared from state, and never shown again. */
export function AddSource({ workspaceId, onAdded }: { workspaceId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('csv');
  const [name, setName] = useState('');
  const [pg, setPg] = useState(empty);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function close() {
    setOpen(false);
    setName('');
    setPg(empty);
    setPassword('');
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const body =
      kind === 'csv'
        ? { type: 'csv', name: name.trim() }
        : {
            type: 'postgres',
            name: name.trim(),
            settings: {
              host: pg.host.trim(),
              port: Number(pg.port),
              database: pg.database.trim(),
              sslMode: pg.sslMode,
            },
            credentials: { username: pg.username, password },
          };
    try {
      await apiFetch(`/workspaces/${workspaceId}/sources`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      close();
      onAdded();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? { title: e.message, detail: e.detail }
          : { title: 'The source could not be added.' },
      );
    } finally {
      // Never kept after a send, successful or not.
      setPassword('');
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="page-actions">
        <button type="button" className="button button--primary" onClick={() => setOpen(true)}>
          Add source
        </button>
      </div>
    );
  }

  const field = (label: string, input: ReactNode, wide = false) => (
    <label className={wide ? 'add-source__field add-source__field--wide' : 'add-source__field'}>
      {label}
      {input}
    </label>
  );
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setPg((v) => ({ ...v, [key]: e.target.value }));

  return (
    <section className="add-source" aria-labelledby="add-source-title">
      <h2 id="add-source-title" className="add-source__title">
        Add a source
      </h2>
      <form className="add-source__form" onSubmit={(e) => void submit(e)}>
        <fieldset className="add-source__kind">
          <legend>Type</legend>
          <label className="add-source__option">
            <input
              type="radio"
              name="source-kind"
              checked={kind === 'csv'}
              onChange={() => setKind('csv')}
            />
            CSV uploads
          </label>
          <label className="add-source__option">
            <input
              type="radio"
              name="source-kind"
              checked={kind === 'postgres'}
              onChange={() => setKind('postgres')}
            />
            PostgreSQL database (read-only)
          </label>
        </fieldset>
        {field(
          'Name',
          <input
            className="text-input"
            required
            maxLength={80}
            placeholder={kind === 'csv' ? 'For example, Finance exports' : 'For example, Warehouse'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />,
          true,
        )}
        {kind === 'postgres' && (
          <>
            {field(
              'Host',
              <input
                className="text-input"
                required
                maxLength={253}
                placeholder="db.example.com"
                value={pg.host}
                onChange={set('host')}
              />,
            )}
            {field(
              'Port',
              <input
                className="text-input"
                required
                inputMode="numeric"
                pattern="[0-9]+"
                value={pg.port}
                onChange={set('port')}
              />,
            )}
            {field(
              'Database',
              <input
                className="text-input"
                required
                maxLength={63}
                value={pg.database}
                onChange={set('database')}
              />,
            )}
            {field(
              'Encryption',
              <select className="text-input" value={pg.sslMode} onChange={set('sslMode')}>
                <option value="verify-full">Verify certificate (recommended)</option>
                <option value="require">Require encryption</option>
                <option value="disable">None (local development only)</option>
              </select>,
            )}
            {field(
              'Username',
              <input
                className="text-input"
                required
                maxLength={63}
                autoComplete="off"
                value={pg.username}
                onChange={set('username')}
              />,
            )}
            {field(
              'Password',
              <input
                className="text-input"
                type="password"
                required
                maxLength={1024}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />,
            )}
            <p className="add-source__help">
              Use an account that can only read. The password is stored encrypted and never shown
              again.
            </p>
          </>
        )}
        <div className="add-source__actions">
          <button type="submit" className="button button--primary" disabled={saving}>
            {kind === 'csv' ? 'Add CSV source' : 'Add PostgreSQL source'}
          </button>
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
      {error !== null && (
        <div role="alert" className="add-source__error">
          <p>{error.title}</p>
          {error.detail !== undefined && <p>{error.detail}</p>}
        </div>
      )}
    </section>
  );
}
