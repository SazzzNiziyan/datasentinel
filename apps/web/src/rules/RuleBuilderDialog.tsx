import {
  ruleSeverities,
  validateRuleDefinition,
  type RuleDetail,
  type RuleSeverity,
  type RuleType,
} from '@datasentinel/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import '../pages/RegisterTableDialog.css';
import { describeRule } from './describeRule.ts';
import './RuleBuilderDialog.css';
import {
  buildDefinition,
  emptyRuleForm,
  problemText,
  ruleTypeLabels,
  type RuleForm,
} from './ruleForm.ts';

type ProfiledColumn = { name: string; type: string };

const severityLabels: Record<RuleSeverity, string> = {
  critical: 'Critical: opens an incident',
  warning: 'Warning: shows on the dashboard',
  info: 'Info: shows on the dashboard',
};

const isTime = (type: string) => type === 'date' || type === 'timestamp';
const isRangeable = (type: string) => isTime(type) || type === 'integer' || type === 'decimal';
const MAX_KEY_COLUMNS = 5;

/** Builds a rule for one dataset (FR-05, D-67): fields per rule type, a
 * live plain-language preview, and the same validation the API runs, so a
 * rule that cannot be saved says why before anything is sent. */
export function RuleBuilderDialog({
  workspaceId,
  datasetId,
  datasetName,
  csv,
  columns,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  datasetId: string;
  datasetName: string;
  /** CSV freshness is the upload time; databases need a time column. */
  csv: boolean;
  /** From the latest successful profile; empty before the first one. */
  columns: readonly ProfiledColumn[];
  onClose: () => void;
  onCreated: (rule: RuleDetail) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState<RuleSeverity>('warning');
  const [form, setForm] = useState<RuleForm>(emptyRuleForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const set =
    <K extends keyof RuleForm>(key: K) =>
    (value: RuleForm[K]) =>
      setForm((f) => ({ ...f, [key]: value }));
  const text =
    (key: { [K in keyof RuleForm]: RuleForm[K] extends string ? K : never }[keyof RuleForm]) =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggle = (column: string) =>
    setForm((f) => ({
      ...f,
      columns: f.columns.includes(column)
        ? f.columns.filter((c) => c !== column)
        : [...f.columns, column],
    }));

  const result = validateRuleDefinition(buildDefinition(form, columns));
  const problems = result.ok ? [] : result.problems.map(problemText);
  if (form.type === 'freshness' && !csv && form.timestampColumn === '') {
    problems.push('Timestamp column: Choose a date or time column.');
  }
  const valid = result.ok && problems.length === 0 && name.trim() !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !result.ok || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const rule = await apiFetch<RuleDetail>(
        `/workspaces/${workspaceId}/datasets/${datasetId}/rules`,
        {
          method: 'POST',
          body: JSON.stringify({ name, severity, definition: result.definition }),
        },
      );
      onCreated(rule);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? [e.message, e.detail].filter(Boolean).join(' ')
          : 'The rule could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  const columnSelect = (
    label: string,
    value: string,
    onChange: (e: { target: { value: string } }) => void,
    choices: readonly ProfiledColumn[],
  ) => (
    <label className="register-dialog__field">
      {label}
      <select className="text-input" value={value} onChange={onChange}>
        <option value="">{choices.length === 0 ? 'No suitable columns' : 'Choose a column'}</option>
        {choices.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({c.type})
          </option>
        ))}
      </select>
    </label>
  );

  const columnChecks = (legend: string, limit?: number) => (
    <fieldset className="register-dialog__tables">
      <legend>{legend}</legend>
      {columns.map((c) => (
        <label key={c.name} className="register-dialog__table">
          <input
            type="checkbox"
            checked={form.columns.includes(c.name)}
            disabled={
              limit !== undefined && !form.columns.includes(c.name) && form.columns.length >= limit
            }
            onChange={() => toggle(c.name)}
          />
          {c.name} ({c.type})
        </label>
      ))}
    </fieldset>
  );

  const numberField = (
    label: string,
    key:
      | 'maxNullPercent'
      | 'maxDuplicateRows'
      | 'minRows'
      | 'maxRows'
      | 'maxIncreasePercent'
      | 'maxDropPercent'
      | 'minimumHistoryPoints',
    help?: string,
  ) => (
    <label className="register-dialog__field">
      {label}
      <input
        className="text-input"
        type="number"
        inputMode="decimal"
        value={form[key]}
        onChange={text(key)}
      />
      {help !== undefined && <span className="register-dialog__help">{help}</span>}
    </label>
  );

  const rangeColumn = columns.find((c) => c.name === form.column);
  const dateBounds = rangeColumn !== undefined && isTime(rangeColumn.type);

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
        Add a rule to {datasetName}
      </h2>
      <form className="register-dialog__form" onSubmit={(e) => void submit(e)}>
        <label className="register-dialog__field">
          Name
          <input
            className="text-input"
            required
            maxLength={120}
            placeholder="Orders arrive every day"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="register-dialog__field">
          What to check
          <select
            className="text-input"
            value={form.type}
            onChange={(e) => setForm({ ...emptyRuleForm(), type: e.target.value as RuleType })}
          >
            {Object.entries(ruleTypeLabels).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {columns.length === 0 && form.type !== 'row_count' && form.type !== 'freshness' && (
          <p className="register-dialog__help">
            Columns appear here after the dataset's first successful profile.
          </p>
        )}

        {form.type === 'freshness' && (
          <>
            {csv ? (
              <p className="register-dialog__help">Measured from the time of the latest upload.</p>
            ) : (
              columnSelect(
                'Timestamp column',
                form.timestampColumn,
                text('timestampColumn'),
                columns.filter((c) => isTime(c.type)),
              )
            )}
            <div className="rule-builder__pair">
              <label className="register-dialog__field">
                Maximum age
                <input
                  className="text-input"
                  type="number"
                  inputMode="numeric"
                  value={form.maxAge}
                  onChange={text('maxAge')}
                />
              </label>
              <label className="register-dialog__field">
                Unit
                <select
                  className="text-input"
                  value={form.ageUnit}
                  onChange={(e) => set('ageUnit')(e.target.value as RuleForm['ageUnit'])}
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </label>
            </div>
          </>
        )}

        {form.type === 'not_null' && (
          <>
            {columnSelect('Column', form.column, text('column'), columns)}
            {numberField('Allowed empty values (%)', 'maxNullPercent', '0 means none at all.')}
          </>
        )}

        {form.type === 'uniqueness' && (
          <>
            {columnChecks(
              `Columns that identify a row (up to ${MAX_KEY_COLUMNS})`,
              MAX_KEY_COLUMNS,
            )}
            {numberField(
              'Allowed repeated rows',
              'maxDuplicateRows',
              'Rows with an empty key value are not counted.',
            )}
          </>
        )}

        {form.type === 'row_count' && (
          <div className="rule-builder__pair">
            {numberField('Fewest rows', 'minRows')}
            {numberField('Most rows', 'maxRows')}
          </div>
        )}

        {form.type === 'range' && (
          <>
            {columnSelect(
              'Column',
              form.column,
              text('column'),
              columns.filter((c) => isRangeable(c.type)),
            )}
            <div className="rule-builder__pair">
              {(['min', 'max'] as const).map((key) => (
                <label key={key} className="register-dialog__field">
                  {key === 'min' ? 'Lowest value' : 'Highest value'}
                  <input
                    className="text-input"
                    type={dateBounds ? 'text' : 'number'}
                    inputMode={dateBounds ? 'text' : 'decimal'}
                    placeholder={dateBounds ? '2026-01-31' : undefined}
                    value={form[key]}
                    onChange={text(key)}
                  />
                </label>
              ))}
            </div>
          </>
        )}

        {form.type === 'schema' && (
          <>
            {columnChecks('Columns that must exist')}
            <label className="rule-builder__check">
              <input
                type="checkbox"
                checked={form.withTypes}
                onChange={(e) => set('withTypes')(e.target.checked)}
              />
              Also require each column's current type
            </label>
          </>
        )}

        {form.type === 'metric_change' && (
          <>
            <label className="register-dialog__field">
              Measure
              <select
                className="text-input"
                value={form.metric}
                onChange={(e) => set('metric')(e.target.value as RuleForm['metric'])}
              >
                <option value="row_count">Row count</option>
                <option value="null_count">Empty values in a column</option>
              </select>
            </label>
            {form.metric === 'null_count' &&
              columnSelect('Column', form.column, text('column'), columns)}
            <label className="register-dialog__field">
              Compare with
              <select
                className="text-input"
                value={form.comparisonWindowDays}
                onChange={(e) =>
                  set('comparisonWindowDays')(e.target.value as RuleForm['comparisonWindowDays'])
                }
              >
                <option value="7">The previous 7 days</option>
                <option value="30">The previous 30 days</option>
              </select>
            </label>
            <div className="rule-builder__pair">
              {numberField('Allowed rise (%)', 'maxIncreasePercent', 'Blank: rises are fine.')}
              {numberField('Allowed drop (%)', 'maxDropPercent', 'Blank: drops are fine.')}
            </div>
            {numberField(
              'Earlier profiles needed',
              'minimumHistoryPoints',
              'With fewer, the check reports not enough data instead of passing.',
            )}
          </>
        )}

        <label className="register-dialog__field">
          Severity
          <select
            className="text-input"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as RuleSeverity)}
          >
            {ruleSeverities.map((s) => (
              <option key={s} value={s}>
                {severityLabels[s]}
              </option>
            ))}
          </select>
        </label>

        <div
          className="rule-builder__preview"
          role="status"
          data-valid={result.ok && problems.length === 0}
        >
          {result.ok && problems.length === 0 ? (
            <p>{describeRule(result.definition)}</p>
          ) : (
            <ul className="rule-builder__problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="register-dialog__error">
            {error}
          </p>
        )}
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving || !valid}>
            Save rule
          </button>
        </div>
      </form>
    </dialog>
  );
}
