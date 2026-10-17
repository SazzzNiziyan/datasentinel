import type { IncidentStatus } from '@datasentinel/contracts';
import type { Tone } from '../components/StatusMark.tsx';

export const incidentStatusLabel: Record<IncidentStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

const tones: Record<IncidentStatus, Tone> = {
  open: 'critical',
  reopened: 'critical',
  acknowledged: 'warning',
  investigating: 'warning',
  resolved: 'healthy',
};

export const incidentStatusTone = (status: IncidentStatus): Tone => tones[status];
