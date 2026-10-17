import {
  validateSchedule,
  type ScheduleDefinition,
  type ScheduleDetail,
} from '@datasentinel/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import '../pages/RegisterTableDialog.css';
import '../rules/RuleBuilderDialog.css';
import { describeSchedule } from './describeSchedule.ts';
import {
  emptyScheduleForm,
  fromDefinition,
  toDefinition,
  type ScheduleForm,
} from './scheduleForm.ts';

const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Adds a schedule to a dataset, or changes one (FR-06): the same checks the
 * API runs, with a plain-words preview, before anything is sent. */
export function ScheduleDialog({
  workspaceId,
  datasetId,
  rules,
  existing,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  datasetId: string;
  rules: readonly { id: string; name: string }[];
  existing?: ScheduleDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [ruleId, setRuleId] = useState('');
  const [form, setForm] = useState<ScheduleForm>(() =>
    existing === undefined
      ? emptyScheduleForm(Intl.DateTimeFormat().resolvedOptions().timeZone)
      : fromDefinition(existing.definition),
  );
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const text = (key: 'every' | 'times' | 'timezone') => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleDay = (day: number) =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day],
    }));

  const result = validateSchedule(toDefinition(form));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPressed(true);
    if (saving || !result.ok) return;
    setSaving(true);
    setError(null);
    const base = `/workspaces/${workspaceId}`;
    const definition: ScheduleDefinition = result.definition;
    try {
      if (existing === undefined) {
        await apiFetch<ScheduleDetail>(`${base}/datasets/${datasetId}/schedules`, {
          method: 'POST',
          body: JSON.stringify({ definition, ...(ruleId !== '' ? { ruleId } : {}) }),
        });
      } else {
        await apiFetch<ScheduleDetail>(`${base}/schedules/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ definition }),
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError ? (e.detail ?? e.message) : 'The schedule could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

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
        {existing === undefined ? 'Add schedule' : 'Change schedule'}
      </h2>
      <form className="register-dialog__form" onSubmit={(e) => void submit(e)}>
        {existing === undefined && (
          <label className="register-dialog__field">
            What runs
            <select
              className="text-input"
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
            >
              <option value="">Whole dataset: profile, then every turned-on rule</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  Rule: {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="register-dialog__tables">
          <legend>Repeat</legend>
          <label className="register-dialog__table">
            <input
              type="radio"
              name="schedule-kind"
              checked={form.kind === 'interval'}
              onChange={() => setForm((f) => ({ ...f, kind: 'interval' }))}
            />
            Every set time
          </label>
          <label className="register-dialog__table">
            <input
              type="radio"
              name="schedule-kind"
              checked={form.kind === 'calendar'}
              onChange={() => setForm((f) => ({ ...f, kind: 'calendar' }))}
            />
            At set times of day
          </label>
        </fieldset>

        {form.kind === 'interval' ? (
          <div className="rule-builder__pair">
            <label className="register-dialog__field">
              Every
              <input
                className="text-input"
                type="number"
                inputMode="numeric"
                min={1}
                value={form.every}
                onChange={text('every')}
              />
            </label>
            <label className="register-dialog__field">
              Unit
              <select
                className="text-input"
                value={form.unit}
                onChange={(e) =>
                  setForm((f) => ({ ...f, unit: e.target.value as ScheduleForm['unit'] }))
                }
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </label>
          </div>
        ) : (
          <>
            <label className="register-dialog__field">
              Times (24-hour, comma-separated)
              <input
                className="text-input"
                placeholder="06:00, 18:30"
                value={form.times}
                onChange={text('times')}
              />
            </label>
            <label className="register-dialog__field">
              Time zone
              <input
                className="text-input"
                placeholder="Europe/Berlin"
                value={form.timezone}
                onChange={text('timezone')}
              />
            </label>
            <fieldset className="register-dialog__tables">
              <legend>Days (none means every day)</legend>
              {dayNames.map((name, i) => (
                <label key={name} className="register-dialog__table">
                  <input
                    type="checkbox"
                    value={i + 1}
                    checked={form.days.includes(i + 1)}
                    onChange={() => toggleDay(i + 1)}
                  />
                  {name}
                </label>
              ))}
            </fieldset>
          </>
        )}

        {result.ok && <p>Runs: {describeSchedule(result.definition)}</p>}
        {!result.ok && pressed && (
          <ul role="alert" className="register-dialog__error">
            {result.problems.map((p) => (
              <li key={`${p.path}:${p.message}`}>{p.message}</li>
            ))}
          </ul>
        )}

        {error !== null && (
          <p role="alert" className="register-dialog__error">
            {error}
          </p>
        )}
        <div className="register-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving}>
            Save schedule
          </button>
        </div>
      </form>
    </dialog>
  );
}
