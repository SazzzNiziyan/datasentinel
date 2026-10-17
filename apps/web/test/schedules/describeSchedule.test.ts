import type { ScheduleDefinition } from '@datasentinel/contracts';
import { describe, expect, it } from 'vitest';
import { describeSchedule } from '../../src/schedules/describeSchedule.ts';

const every = (everyMinutes: number): ScheduleDefinition => ({
  version: 1,
  kind: 'interval',
  everyMinutes,
});
const at = (times: string[], days?: number[]): ScheduleDefinition => ({
  version: 1,
  kind: 'calendar',
  times,
  timezone: 'Europe/Berlin',
  ...(days === undefined ? {} : { days }),
});

describe('describeSchedule', () => {
  it('describes intervals', () => {
    expect(describeSchedule(every(60))).toBe('Every hour');
    expect(describeSchedule(every(1440))).toBe('Every day');
    expect(describeSchedule(every(10080))).toBe('Every week');
    expect(describeSchedule(every(15))).toBe('Every 15 minutes');
    expect(describeSchedule(every(120))).toBe('Every 2 hours');
    expect(describeSchedule(every(2880))).toBe('Every 2 days');
  });

  it('describes times of day', () => {
    expect(describeSchedule(at(['06:00']))).toBe('At 06:00 (Europe/Berlin), every day');
    expect(describeSchedule(at(['06:00', '18:30']))).toBe(
      'At 06:00 and 18:30 (Europe/Berlin), every day',
    );
    expect(describeSchedule(at(['06:00', '12:00', '18:30']))).toBe(
      'At 06:00, 12:00 and 18:30 (Europe/Berlin), every day',
    );
  });

  it('describes days', () => {
    expect(describeSchedule(at(['06:00'], [1, 2, 3, 4, 5]))).toContain(', Monday to Friday');
    expect(describeSchedule(at(['06:00'], [7, 6]))).toContain(', weekends');
    expect(describeSchedule(at(['06:00'], [1, 2, 3, 4, 5, 6, 7]))).toContain(', every day');
    expect(describeSchedule(at(['06:00'], [1, 3]))).toContain(', on Monday and Wednesday');
    expect(describeSchedule(at(['06:00'], [1, 3, 7]))).toContain(
      ', on Monday, Wednesday and Sunday',
    );
  });
});
