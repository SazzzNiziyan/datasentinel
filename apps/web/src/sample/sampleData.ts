/**
 * SAMPLE DATA. Stands in for API responses until the backend exists
 * (roadmap Phases D to J). Every screen that uses it says so on the page.
 * Remove before any screen is presented as connected to live services.
 */
import type { Severity } from '../components/SeverityBadge.tsx';
import type { Tone } from '../components/StatusMark.tsx';

export interface Status {
  tone: Tone;
  label: string;
}

export type IncidentStatus = 'Open' | 'Acknowledged' | 'Resolved';

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  dataset: string;
  /** ISO time; drives "oldest first" ordering. */
  openedAt: string;
  owner: string;
  status: IncidentStatus;
}

export const incidents: readonly Incident[] = [
  {
    id: 'INC-1042',
    title: 'Row count far below expected',
    severity: 'critical',
    dataset: 'orders_daily',
    openedAt: '2026-10-17T06:12:00Z',
    owner: 'Ana Kovac',
    status: 'Open',
  },
  {
    id: 'INC-1041',
    title: 'Data not updated for 9 hours',
    severity: 'warning',
    dataset: 'invoices_eu',
    openedAt: '2026-10-17T03:05:00Z',
    owner: 'Ravi Menon',
    status: 'Acknowledged',
  },
  {
    id: 'INC-1040',
    title: 'Column "discount_code" removed',
    severity: 'warning',
    dataset: 'orders_daily',
    openedAt: '2026-10-16T22:40:00Z',
    owner: 'Unassigned',
    status: 'Open',
  },
  {
    id: 'INC-1039',
    title: 'Null rate in "email" above 2%',
    severity: 'critical',
    dataset: 'customers',
    openedAt: '2026-10-16T18:30:00Z',
    owner: 'Ana Kovac',
    status: 'Open',
  },
  {
    id: 'INC-1037',
    title: 'Duplicate order IDs found',
    severity: 'info',
    dataset: 'orders_daily',
    openedAt: '2026-10-15T09:00:00Z',
    owner: 'Ravi Menon',
    status: 'Resolved',
  },
];

export interface Source {
  id: string;
  name: string;
  type: 'PostgreSQL' | 'CSV upload' | 'API check';
  status: Status;
  lastCheck: string;
  owner: string;
  schedule: string;
}

export const sources: readonly Source[] = [
  {
    id: 's1',
    name: 'warehouse_prod',
    type: 'PostgreSQL',
    status: { tone: 'healthy', label: 'Connected' },
    lastCheck: 'Today 08:40 UTC',
    owner: 'Ana Kovac',
    schedule: 'Every hour',
  },
  {
    id: 's2',
    name: 'billing_eu',
    type: 'PostgreSQL',
    status: { tone: 'warning', label: 'Slow responses' },
    lastCheck: 'Today 08:15 UTC',
    owner: 'Ravi Menon',
    schedule: 'Every 6 hours',
  },
  {
    id: 's3',
    name: 'marketing_leads.csv',
    type: 'CSV upload',
    status: { tone: 'healthy', label: 'Uploaded' },
    lastCheck: 'Yesterday 17:02 UTC',
    owner: 'Lena Fischer',
    schedule: 'On upload',
  },
  {
    id: 's4',
    name: 'legacy_orders_db',
    type: 'PostgreSQL',
    status: { tone: 'neutral', label: 'Paused' },
    lastCheck: '3 Oct 11:20 UTC',
    owner: 'Ravi Menon',
    schedule: 'Paused',
  },
];

export interface Dataset {
  id: string;
  name: string;
  source: string;
  health: Status;
  rows: number;
  freshness: string;
  lastProfile: string;
  nextCheck: string;
}

export const datasets: readonly Dataset[] = [
  {
    id: 'd1',
    name: 'orders_daily',
    source: 'warehouse_prod',
    health: { tone: 'critical', label: 'Failing' },
    rows: 2_140,
    freshness: 'Updated 2 h ago',
    lastProfile: 'Today 06:10 UTC',
    nextCheck: 'Today 09:40 UTC',
  },
  {
    id: 'd2',
    name: 'customers',
    source: 'warehouse_prod',
    health: { tone: 'critical', label: 'Failing' },
    rows: 98_412,
    freshness: 'Updated 1 h ago',
    lastProfile: 'Today 07:00 UTC',
    nextCheck: 'Today 09:40 UTC',
  },
  {
    id: 'd3',
    name: 'invoices_eu',
    source: 'billing_eu',
    health: { tone: 'warning', label: 'Stale' },
    rows: 7_310,
    freshness: 'Updated 9 h ago',
    lastProfile: 'Yesterday 23:00 UTC',
    nextCheck: 'Today 12:15 UTC',
  },
  {
    id: 'd4',
    name: 'marketing_leads',
    source: 'marketing_leads.csv',
    health: { tone: 'healthy', label: 'Healthy' },
    rows: 1_205,
    freshness: 'Uploaded yesterday',
    lastProfile: 'Yesterday 17:03 UTC',
    nextCheck: 'On next upload',
  },
];

export interface ActivityEvent {
  id: string;
  time: string;
  actor: string;
  text: string;
}

/** Newest first. */
export const activity: readonly ActivityEvent[] = [
  {
    id: 'a1',
    time: '08:40 UTC',
    actor: 'Scheduler',
    text: 'Checks ran on warehouse_prod: 14 passed, 2 failed',
  },
  { id: 'a2', time: '08:15 UTC', actor: 'Scheduler', text: 'billing_eu responded slowly (12 s)' },
  { id: 'a3', time: '07:58 UTC', actor: 'Ravi Menon', text: 'Acknowledged INC-1041' },
  { id: 'a4', time: '06:12 UTC', actor: 'Scheduler', text: 'Opened INC-1042 on orders_daily' },
];

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

export const members: readonly Member[] = [
  { id: 'm1', name: 'Lena Fischer', email: 'lena@northwind.example', role: 'Owner' },
  { id: 'm2', name: 'Ana Kovac', email: 'ana@northwind.example', role: 'Data engineer' },
  { id: 'm3', name: 'Ravi Menon', email: 'ravi@northwind.example', role: 'Data engineer' },
  { id: 'm4', name: 'Sam Ortiz', email: 'sam@northwind.example', role: 'Analyst' },
  { id: 'm5', name: 'Mei Tanaka', email: 'mei@northwind.example', role: 'Viewer' },
];
