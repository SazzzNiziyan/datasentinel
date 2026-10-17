import { validateSchedule } from '@datasentinel/contracts';
import { describe, expect, it } from 'vitest';
import {
  emptyScheduleForm,
  fromDefinition,
  toDefinition,
} from '../../src/schedules/scheduleForm.ts';

const base = emptyScheduleForm('Europe/Berlin');

describe('scheduleForm', () => {
  it('builds an interval definition', () => {
    expect(toDefinition({ ...base, every: '2', unit: 'hours' })).toEqual({
      version: 1,
      kind: 'interval',
      everyMinutes: 120,
    });
  });

  it('builds a calendar definition, omitting days when none or all are set', () => {
    const cal = { ...base, kind: 'calendar' as const, times: '06:00, 18:30' };
    const expected = {
      version: 1,
      kind: 'calendar',
      times: ['06:00', '18:30'],
      timezone: 'Europe/Berlin',
    };
    expect(toDefinition(cal)).toEqual(expected);
    expect(toDefinition({ ...cal, days: [1, 2, 3, 4, 5, 6, 7] })).toEqual(expected);
    expect(toDefinition({ ...cal, days: [5, 1] })).toEqual({ ...expected, days: [1, 5] });
  });

  it('reads an interval back in the largest even unit', () => {
    const r = validateSchedule({ version: 1, kind: 'interval', everyMinutes: 120 });
    if (!r.ok) throw new Error('invalid');
    expect(fromDefinition(r.definition)).toMatchObject({ every: '2', unit: 'hours' });
  });

  it('round-trips a calendar definition', () => {
    const input = {
      version: 1,
      kind: 'calendar',
      times: ['06:00', '18:30'],
      timezone: 'Europe/Berlin',
      days: [1, 3],
    };
    const r = validateSchedule(input);
    if (!r.ok) throw new Error('invalid');
    expect(toDefinition(fromDefinition(r.definition))).toEqual(input);
  });
});
