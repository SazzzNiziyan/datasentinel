import { nextOccurrence, validateSchedule } from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const iso = (d: Date) => d.toISOString();
const calendar = (times: string[], timezone: string, days?: number[]) => ({
  version: 1 as const,
  kind: 'calendar' as const,
  times,
  timezone,
  ...(days === undefined ? {} : { days }),
});
const anchor = new Date('2026-01-01T00:00:00.000Z');

describe('schedule definitions', () => {
  it('accepts intervals from 15 minutes to a week, and calendar times', () => {
    assert.equal(validateSchedule({ version: 1, kind: 'interval', everyMinutes: 15 }).ok, true);
    assert.equal(validateSchedule({ version: 1, kind: 'interval', everyMinutes: 10_080 }).ok, true);
    assert.equal(
      validateSchedule(calendar(['06:00', '18:30'], 'Europe/Berlin', [1, 2, 3, 4, 5])).ok,
      true,
    );
    assert.equal(validateSchedule(calendar(['00:00'], 'UTC')).ok, true);
  });

  it('refuses short intervals, crowded times, unknown zones, and cron text', () => {
    const refused = [
      { version: 1, kind: 'interval', everyMinutes: 10 },
      { version: 1, kind: 'interval', everyMinutes: 10_081 },
      calendar(['06:00', '06:10'], 'UTC'),
      calendar(['23:55', '00:05'], 'UTC'),
      calendar(['24:00'], 'UTC'),
      calendar(['06:00'], 'Mars/Base'),
      calendar(['06:00'], '+05:00'),
      calendar(['06:00'], 'UTC', [0]),
      calendar(['06:00'], 'UTC', [1, 1]),
      { version: 1, kind: 'cron', expression: '* * * * *' },
      { version: 2, kind: 'interval', everyMinutes: 60 },
    ];
    for (const input of refused) {
      assert.equal(validateSchedule(input).ok, false, JSON.stringify(input));
    }
    const crowded = validateSchedule(calendar(['06:00', '06:10'], 'UTC'));
    assert.deepEqual(crowded.ok ? null : crowded.problems, [
      { path: 'times', message: 'Times must be at least 15 minutes apart.' },
    ]);
  });
});

describe('next occurrence', () => {
  it('steps intervals from the anchor, strictly after the given time', () => {
    const every15 = { version: 1 as const, kind: 'interval' as const, everyMinutes: 15 };
    assert.equal(
      iso(nextOccurrence(every15, new Date('2026-01-01T00:07:00Z'), anchor)),
      '2026-01-01T00:15:00.000Z',
    );
    assert.equal(
      iso(nextOccurrence(every15, new Date('2026-01-01T00:15:00Z'), anchor)),
      '2026-01-01T00:30:00.000Z',
    );
    assert.equal(
      iso(nextOccurrence(every15, new Date('2025-12-31T00:00:00Z'), anchor)),
      iso(anchor),
    );
  });

  it('keeps calendar times on the local wall clock across seasons', () => {
    const berlin = calendar(['06:00'], 'Europe/Berlin');
    assert.equal(
      iso(nextOccurrence(berlin, new Date('2026-01-15T12:00:00Z'), anchor)),
      '2026-01-16T05:00:00.000Z',
    );
    assert.equal(
      iso(nextOccurrence(berlin, new Date('2026-07-15T12:00:00Z'), anchor)),
      '2026-07-16T04:00:00.000Z',
    );
  });

  it('skips days that are not chosen', () => {
    // 2026-10-16 is a Friday; weekdays only, so the next run is Monday.
    const weekdays = calendar(['06:00'], 'UTC', [1, 2, 3, 4, 5]);
    assert.equal(
      iso(nextOccurrence(weekdays, new Date('2026-10-16T07:00:00Z'), anchor)),
      '2026-10-19T06:00:00.000Z',
    );
  });

  it('runs a time skipped by spring-forward one hour later on the wall clock', () => {
    // Berlin clocks jump from 02:00 to 03:00 on 2026-03-29.
    const skipped = calendar(['02:30'], 'Europe/Berlin');
    assert.equal(
      iso(nextOccurrence(skipped, new Date('2026-03-28T12:00:00Z'), anchor)),
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('runs a time repeated by fall-back once, at its first occurrence', () => {
    // Berlin clocks go from 03:00 back to 02:00 on 2026-10-25: 02:30 happens twice.
    const repeated = calendar(['02:30'], 'Europe/Berlin');
    const first = nextOccurrence(repeated, new Date('2026-10-24T12:00:00Z'), anchor);
    assert.equal(iso(first), '2026-10-25T00:30:00.000Z');
    assert.equal(iso(nextOccurrence(repeated, first, anchor)), '2026-10-26T01:30:00.000Z');
  });

  it('uses the zone of the schedule, not of the server', () => {
    const tokyo = calendar(['09:00'], 'Asia/Tokyo');
    assert.equal(
      iso(nextOccurrence(tokyo, new Date('2026-10-17T00:30:00Z'), anchor)),
      '2026-10-18T00:00:00.000Z',
    );
  });
});
