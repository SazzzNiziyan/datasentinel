/** Shared display formats: times in UTC, counts with separators (D-68). */
const when = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "17 Oct 2026, 09:00 UTC", or "Never". */
export const formatTime = (iso: string | null) =>
  iso === null ? 'Never' : `${when.format(new Date(iso))} UTC`;

/** "17 Oct". */
export const formatDay = (iso: string) => day.format(new Date(iso));

export const formatCount = (n: number) => n.toLocaleString('en-US');

/** "120 ms", "1.5 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
