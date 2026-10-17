import type { ScheduleDefinition } from '@datasentinel/contracts';
import { formatMinutes } from '../rules/describeRule.ts';

const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeDays(days: readonly number[] | undefined): string {
  if (days === undefined || days.length === 0 || days.length === 7) return 'every day';
  const sorted = [...days].sort((a, b) => a - b);
  const is = (want: number[]) =>
    sorted.length === want.length && sorted.every((d, i) => d === want[i]);
  if (is([1, 2, 3, 4, 5])) return 'Monday to Friday';
  if (is([6, 7])) return 'weekends';
  return `on ${andList(sorted.map((d) => dayNames[d - 1] ?? String(d)))}`;
}

/** A schedule in plain words. */
export function describeSchedule(d: ScheduleDefinition): string {
  if (d.kind === 'interval') {
    if (d.everyMinutes === 60) return 'Every hour';
    if (d.everyMinutes === 1440) return 'Every day';
    if (d.everyMinutes === 10080) return 'Every week';
    return `Every ${formatMinutes(d.everyMinutes)}`;
  }
  return `At ${andList(d.times)} (${d.timezone}), ${describeDays(d.days)}`;
}
