/** One entry per top-level destination (docs/06-design-system.md §6). */
export interface NavItem {
  readonly path: string;
  readonly label: string;
  /** One sentence shown on the page until the screen is built. */
  readonly purpose: string;
}

/** Daily operational work. */
export const primaryNav: readonly NavItem[] = [
  {
    path: '/',
    label: 'Overview',
    purpose: 'Workspace health, active incidents, and dataset freshness at a glance.',
  },
  {
    path: '/incidents',
    label: 'Incidents',
    purpose: 'Failed checks grouped into incidents, with evidence, owner, and status.',
  },
  {
    path: '/sources',
    label: 'Data sources',
    purpose: 'CSV uploads, PostgreSQL connections, and API checks, with their health.',
  },
  {
    path: '/datasets',
    label: 'Datasets',
    purpose: 'Profiles, rules, schema history, and check results for each dataset.',
  },
  {
    path: '/runs',
    label: 'Pipeline runs',
    purpose: 'A timeline of pipeline runs and the checks that ran near them.',
  },
];

/** Administration, shown after a divider. */
export const secondaryNav: readonly NavItem[] = [
  {
    path: '/integrations',
    label: 'Integrations',
    purpose: 'Email, Slack, webhook, GitHub, and n8n connections and their deliveries.',
  },
  {
    path: '/settings',
    label: 'Workspace settings',
    purpose: 'Members, roles, security, and retention for this workspace.',
  },
];
