import type { PipelineRunStatus } from '@datasentinel/contracts';
import type { Tone } from '../components/StatusMark.tsx';

/** How each pipeline-run state reads on screen. */
export const pipelineRunDisplay: Record<PipelineRunStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'healthy' },
  failed: { label: 'Failed', tone: 'critical' },
  timed_out: { label: 'Timed out', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};
