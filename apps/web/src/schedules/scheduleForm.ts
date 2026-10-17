import type { ScheduleDefinition } from '@datasentinel/contracts';

export type ScheduleForm = {
  kind: 'interval' | 'calendar';
  every: string;
  unit: 'minutes' | 'hours' | 'days';
  times: string;
  timezone: string;
  days: number[];
};

const unitMinutes = { minutes: 1, hours: 60, days: 1440 } as const;

export function emptyScheduleForm(timezone: string): ScheduleForm {
  return { kind: 'interval', every: '1', unit: 'hours', times: '06:00', timezone, days: [] };
}

/** Unchecked input for validateSchedule. */
export function toDefinition(f: ScheduleForm): unknown {
  if (f.kind === 'interval') {
    return { version: 1, kind: 'interval', everyMinutes: Number(f.every) * unitMinutes[f.unit] };
  }
  return {
    version: 1,
    kind: 'calendar',
    times: f.times
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    timezone: f.timezone.trim(),
    ...(f.days.length === 0 || f.days.length === 7
      ? {}
      : { days: [...f.days].sort((a, b) => a - b) }),
  };
}

export function fromDefinition(d: ScheduleDefinition): ScheduleForm {
  const base = emptyScheduleForm('UTC');
  if (d.kind === 'interval') {
    const unit =
      d.everyMinutes % 1440 === 0 ? 'days' : d.everyMinutes % 60 === 0 ? 'hours' : 'minutes';
    return { ...base, kind: 'interval', unit, every: String(d.everyMinutes / unitMinutes[unit]) };
  }
  return {
    ...base,
    kind: 'calendar',
    times: d.times.join(', '),
    timezone: d.timezone,
    days: d.days === undefined ? [] : [...d.days],
  };
}
