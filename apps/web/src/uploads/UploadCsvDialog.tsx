import { CSV_LIMITS, type DatasetSummary, type SourceSummary } from '@datasentinel/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { StatusMark, type Tone } from '../components/StatusMark.tsx';
import type { PutFile } from './putFile.ts';
import { useCsvUpload, type UploadState, type UploadStep } from './useCsvUpload.ts';
import './UploadCsvDialog.css';

interface UploadCsvDialogProps {
  workspaceId: string;
  /** Preselects the source and dataset, e.g. from a dataset page. */
  sourceId?: string;
  datasetId?: string;
  onClose: () => void;
  /** Once an upload has a result (checked or failed), so the caller can
   * reload its data. */
  onUploaded?: () => void;
  /** Tests replace the storage request. */
  putFile?: PutFile;
}

const steps: { step: UploadStep; label: string }[] = [
  { step: 'read', label: 'Read the file' },
  { step: 'send', label: 'Send it to storage' },
  { step: 'check', label: 'Check the contents' },
];

const order: Record<UploadStep, number> = { read: 0, send: 1, check: 2 };

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** Where the upload is, as one index: which step runs (or failed), or 3 once done. */
function position(state: UploadState): number {
  switch (state.phase) {
    case 'idle':
      return -1;
    case 'reading':
      return 0;
    case 'sending':
      return 1;
    case 'checking':
      return 2;
    case 'succeeded':
      return 3;
    case 'failed':
      return order[state.step];
  }
}

function stepMark(state: UploadState, index: number): { tone: Tone; label: string } {
  const at = position(state);
  if (index < at) return { tone: 'healthy', label: 'Done' };
  if (index > at) return { tone: 'neutral', label: 'Waiting' };
  if (state.phase === 'failed') return { tone: 'critical', label: 'Failed' };
  if (state.phase === 'reading' || state.phase === 'sending') {
    return { tone: 'info', label: `In progress, ${percent(state.progress)}` };
  }
  return { tone: 'info', label: 'In progress' };
}

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** Upload one CSV file to a CSV source, into an existing or new dataset,
 * and follow it until DataSentinel has checked it (D-44). */
export function UploadCsvDialog({
  workspaceId,
  sourceId: initialSource,
  datasetId: initialDataset,
  onClose,
  onUploaded,
  putFile,
}: UploadCsvDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fileHelpId = useId();
  const sources = useApiData<SourceSummary[]>(`/workspaces/${workspaceId}/sources`);
  const datasets = useApiData<DatasetSummary[]>(`/workspaces/${workspaceId}/datasets`);
  const { state, start, reset } = useCsvUpload(putFile);

  const csvSources =
    sources.status === 'ready'
      ? sources.data.filter((s) => s.type === 'csv' && s.status === 'active')
      : [];
  const [sourceId, setSourceId] = useState(initialSource ?? '');
  const chosenSource = sourceId || csvSources[0]?.id || '';
  const sourceDatasets =
    datasets.status === 'ready' ? datasets.data.filter((d) => d.sourceId === chosenSource) : [];

  const [mode, setMode] = useState<'existing' | 'new'>(initialDataset ? 'existing' : 'new');
  const [datasetId, setDatasetId] = useState(initialDataset ?? '');
  const chosenDataset = datasetId || sourceDatasets[0]?.id || '';
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  // A failed check is history too: the caller's upload list must show it.
  const finished =
    state.phase === 'succeeded' || (state.phase === 'failed' && state.upload !== undefined);
  useEffect(() => {
    if (finished) onUploaded?.();
  }, [finished, onUploaded]);

  const busy = state.phase === 'reading' || state.phase === 'sending' || state.phase === 'checking';
  const canStart =
    !busy &&
    chosenSource !== '' &&
    file !== null &&
    (mode === 'existing' ? chosenDataset !== '' : newName.trim() !== '');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    void start({
      workspaceId,
      sourceId: chosenSource,
      file,
      target:
        mode === 'existing' ? { datasetId: chosenDataset } : { newDatasetName: newName.trim() },
    });
  }

  const resultDataset =
    state.phase === 'succeeded' || state.phase === 'checking' ? state.upload.datasetId : null;

  return (
    <dialog
      ref={dialog}
      className="upload-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape closes; a running upload is cancelled with it.
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="upload-dialog__title">
        Upload a CSV file
      </h2>

      {sources.status === 'error' || (sources.status === 'ready' && csvSources.length === 0) ? (
        <div className="upload-dialog__none">
          {sources.status === 'error' ? (
            <p role="alert">Could not load your sources. Close this and try again.</p>
          ) : (
            <>
              <p>CSV files are added to a CSV source, and this workspace has none yet.</p>
              <p>
                <Link to="/sources" onClick={onClose}>
                  Add a CSV source
                </Link>
              </p>
            </>
          )}
          <div className="upload-dialog__actions">
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="upload-dialog__form" onSubmit={submit}>
          <fieldset
            className="upload-dialog__fields"
            disabled={busy || state.phase === 'succeeded'}
          >
            <label className="upload-dialog__field">
              Source
              <select
                className="text-input"
                value={chosenSource}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setDatasetId('');
                }}
              >
                {csvSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="upload-dialog__choice">
              <legend>Dataset</legend>
              <label className="upload-dialog__option">
                <input
                  type="radio"
                  name="dataset-mode"
                  checked={mode === 'existing'}
                  disabled={sourceDatasets.length === 0}
                  onChange={() => setMode('existing')}
                />
                Add to an existing dataset
              </label>
              {mode === 'existing' && (
                <select
                  className="text-input"
                  aria-label="Existing dataset"
                  value={chosenDataset}
                  onChange={(e) => setDatasetId(e.target.value)}
                >
                  {sourceDatasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
              <label className="upload-dialog__option">
                <input
                  type="radio"
                  name="dataset-mode"
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                />
                Create a new dataset
              </label>
              {mode === 'new' && (
                <input
                  className="text-input"
                  aria-label="New dataset name"
                  placeholder="For example, Daily sales"
                  maxLength={120}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              )}
            </fieldset>

            <label className="upload-dialog__field">
              File
              <input
                className="text-input"
                type="file"
                accept=".csv,text/csv"
                aria-describedby={fileHelpId}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  if (state.phase === 'failed') reset();
                }}
              />
            </label>
            <p id={fileHelpId} className="upload-dialog__help">
              Comma-separated UTF-8 text with a header row, up to{' '}
              {CSV_LIMITS.maxBytes / 1024 / 1024} MB and{' '}
              {CSV_LIMITS.maxColumns.toLocaleString('en-US')} columns.
            </p>
          </fieldset>

          {state.phase !== 'idle' && (
            <ol className="upload-dialog__steps" aria-label="Upload progress">
              {steps.map(({ step, label }, index) => {
                const mark = stepMark(state, index);
                const running =
                  (state.phase === 'reading' && step === 'read') ||
                  (state.phase === 'sending' && step === 'send');
                return (
                  <li key={step} className="upload-dialog__step" data-tone={mark.tone}>
                    <span className="upload-dialog__step-label">{label}</span>
                    <StatusMark tone={mark.tone} label={mark.label} />
                    {running && (
                      <progress
                        className="upload-dialog__progress"
                        value={state.progress}
                        max={1}
                        aria-label={`${label} progress`}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <div role="status" className="upload-dialog__result">
            {state.phase === 'succeeded' && (
              <p>
                Checked {plural(state.upload.rowCount ?? 0, 'row')} and{' '}
                {plural(state.upload.columnCount ?? 0, 'column')}.{' '}
                {resultDataset !== null && (
                  <Link to={`/datasets/${resultDataset}`} onClick={onClose}>
                    Open the dataset
                  </Link>
                )}
              </p>
            )}
            {state.phase === 'checking' && state.slow && (
              <p>
                The check is taking longer than usual. Its result will appear on the dataset page.
              </p>
            )}
          </div>
          {state.phase === 'failed' && (
            <div role="alert" className="upload-dialog__error">
              <p className="upload-dialog__error-title">{state.title}</p>
              {state.hint !== undefined && <p>{state.hint}</p>}
            </div>
          )}

          <div className="upload-dialog__actions">
            <button type="button" className="button" onClick={onClose}>
              {busy ? 'Cancel upload' : 'Close'}
            </button>
            {state.phase !== 'succeeded' && (
              <button type="submit" className="button button--primary" disabled={!canStart}>
                {state.phase === 'failed' ? 'Upload again' : 'Upload file'}
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}
