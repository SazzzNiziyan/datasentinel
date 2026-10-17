import type { AiSettings, Role } from '@datasentinel/contracts';
import { useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { canArchive } from '../pages/labels.ts';
import './DestinationsPanel.css';

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

/** Whether AI investigation is on for this workspace. Turning it on needs an
 * explicit acknowledgement (D-99). The API enforces the roles too. */
export function AiSettingsPanel({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const path = `/workspaces/${workspaceId}/ai-settings`;
  const settings = useApiData<AiSettings>(path);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function update(body: { enabled: false } | { enabled: true; acknowledge: true }) {
    setError(undefined);
    setBusy(true);
    try {
      await apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
      setAcknowledged(false);
    } catch (caught) {
      setError(problemText(caught, 'The setting was not changed.'));
    }
    setBusy(false);
    settings.retry();
  }

  return (
    <section className="panel" aria-labelledby="ai-settings-title">
      <h2 id="ai-settings-title" className="panel__title">
        AI investigation
      </h2>
      <p>
        Explains incidents using an outside AI provider. It only advises: it never changes data or
        runs anything. Only redacted incident facts are sent, never table rows, passwords, or keys.
      </p>
      {settings.status === 'loading' && <p>Loading AI settings</p>}
      {settings.status === 'error' && (
        <ErrorState
          title="Could not load AI settings"
          description={settings.error.detail ?? settings.error.message}
          onRetry={settings.retry}
          retrying={settings.retrying}
        />
      )}
      {settings.status === 'ready' &&
        (!settings.data.available ? (
          <p role="status">AI investigation is not available in this deployment.</p>
        ) : (
          <>
            <dl className="dataset-summary">
              <div>
                <dt>Provider</dt>
                <dd>{settings.data.provider}</dd>
              </div>
              <div>
                <dt>Region</dt>
                <dd>{settings.data.region}</dd>
              </div>
              <div>
                <dt>Retention</dt>
                <dd>{settings.data.retention}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{settings.data.enabled ? 'On' : 'Off'}</dd>
              </div>
            </dl>
            {canArchive(role) &&
              (settings.data.enabled ? (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void update({ enabled: false })}
                >
                  Turn off AI investigation
                </button>
              ) : (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />{' '}
                    I understand that redacted incident facts will be sent to{' '}
                    {settings.data.provider} in {settings.data.region}. Retention:{' '}
                    {settings.data.retention}.
                  </label>
                  <div className="destinations__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={!acknowledged || busy}
                      onClick={() => void update({ enabled: true, acknowledge: true })}
                    >
                      Turn on AI investigation
                    </button>
                  </div>
                </>
              ))}
          </>
        ))}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
    </section>
  );
}
