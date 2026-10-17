import type { CheckRunStatus } from '@datasentinel/contracts';
import type { Tone } from '../components/StatusMark.tsx';

/** How each check-run state reads on screen (D-67). */
export const runDisplay: Record<CheckRunStatus, { tone: Tone; label: string }> = {
  queued: { tone: 'info', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  passed: { tone: 'healthy', label: 'Passed' },
  failed: { tone: 'critical', label: 'Failed' },
  insufficient_data: { tone: 'neutral', label: 'Not enough data' },
  error: { tone: 'warning', label: 'Could not run' },
};
