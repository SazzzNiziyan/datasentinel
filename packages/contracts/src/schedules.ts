/** Schedule definitions and next-run times (D-69). Two approved kinds and
 * no free-form cron: a fixed interval, or set times of day in an IANA time
 * zone. Shared by the API (validation) and the scheduler (next run). */
import { z } from 'zod';

/** The shortest gap between two scheduled runs of one target. */
export const MIN_SCHEDULE_MINUTES = 15;
/** The longest interval: one week. */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const DAY_MINUTES = 24 * 60;
const HOUR_MS = 3_600_000;

/** An IANA zone name such as "Europe/Berlin" or "UTC"; not a raw offset. */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z]+(?:[/_-][A-Za-z0-9+_-]+)*$/.test(name) || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Sorted times are at least MIN_SCHEDULE_MINUTES apart, including from the
 * last time of one day to the first of the next. */
function spaced(times: readonly string[]): boolean {
  const sorted = [...times].map(minutesOf).sort((a, b) => a - b);
  return sorted.every((m, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + DAY_MINUTES;
    return sorted.length === 1 || next - m >= MIN_SCHEDULE_MINUTES;
  });
}

const IntervalSchedule = z.strictObject({
  version: z.literal(1),
  kind: z.literal('interval'),
  everyMinutes: z.number().int().min(MIN_SCHEDULE_MINUTES).max(MAX_INTERVAL_MINUTES),
});

const CalendarSchedule = z.strictObject({
  version: z.literal(1),
  kind: z.literal('calendar'),
  timezone: z.string().refine(isTimeZone, { message: 'Choose a time zone such as Europe/Berlin.' }),
  /** Local wall-clock times, 24-hour "HH:MM". */
  times: z
    .array(
      z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { message: 'Use 24-hour times like 06:30.' }),
    )
    .min(1)
    .max(24)
    .refine((t) => new Set(t).size === t.length, { message: 'Each time can be listed once.' })
    .refine(spaced, { message: `Times must be at least ${MIN_SCHEDULE_MINUTES} minutes apart.` }),
  /** ISO weekdays, 1 = Monday to 7 = Sunday; every day when omitted. */
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((d) => new Set(d).size === d.length, { message: 'Each day can be listed once.' })
    .optional(),
});

export const ScheduleDefinition = z.discriminatedUnion(
  'kind',
  [IntervalSchedule, CalendarSchedule],
  {
    error: 'Choose an interval or set times of day.',
  },
);
export type ScheduleDefinition = z.infer<typeof ScheduleDefinition>;

export type ScheduleValidation =
  | { ok: true; definition: ScheduleDefinition }
  | { ok: false; problems: { path: string; message: string }[] };

export function validateSchedule(input: unknown): ScheduleValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ path: '', message: 'A schedule must be an object.' }] };
  }
  if ((input as { version?: unknown }).version !== 1) {
    return {
      ok: false,
      problems: [{ path: 'version', message: 'This schedule version is not supported.' }],
    };
  }
  const parsed = ScheduleDefinition.safeParse(input);
  if (parsed.success) return { ok: true, definition: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    })),
  };
}

/** The wall clock of `zone` at instant `ms`, as if that wall time were UTC. */
function wallClock(zone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

/** The instant a local wall time happens in `zone`. A time that occurs
 * twice (clocks going back) gives its first occurrence; a time that does
 * not occur (clocks going forward) gives the instant it would have had
 * under the earlier offset, which reads one hour later on the new clock. */
function instantOf(zone: string, wall: number): number {
  const offsetAt = (ms: number) => wallClock(zone, ms) - Math.floor(ms / 1000) * 1000;
  const before = offsetAt(wall - 6 * HOUR_MS);
  const after = offsetAt(wall + 6 * HOUR_MS);
  const matches = [wall - before, wall - after]
    .filter((ms) => wallClock(zone, ms) === wall)
    .sort((a, b) => a - b);
  return matches[0] ?? wall - before;
}

/** The first run strictly after `after` (D-69). Intervals step from
 * `anchor`, the schedule's start, so they do not drift; calendar times
 * follow the schedule's own zone, never the server's. */
export function nextOccurrence(definition: ScheduleDefinition, after: Date, anchor: Date): Date {
  if (definition.kind === 'interval') {
    const every = definition.everyMinutes * 60_000;
    const steps = Math.max(0, Math.floor((after.getTime() - anchor.getTime()) / every) + 1);
    return new Date(anchor.getTime() + steps * every);
  }
  const times = [...definition.times].map(minutesOf).sort((a, b) => a - b);
  const today = new Date(wallClock(definition.timezone, after.getTime()));
  // Eight days covers a weekly schedule from any starting point.
  for (let day = 0; day <= 8; day++) {
    const date = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day);
    const weekday = new Date(date).getUTCDay() || 7;
    if (definition.days !== undefined && !definition.days.includes(weekday)) continue;
    for (const minutes of times) {
      const at = instantOf(definition.timezone, date + minutes * 60_000);
      if (at > after.getTime()) return new Date(at);
    }
  }
  throw new Error('no occurrence within eight days');
}
