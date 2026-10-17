import type { DestinationSummary, DestinationType } from '@datasentinel/contracts';

export const typeLabel: Record<DestinationType, string> = {
  email: 'Email',
  slack: 'Slack',
  webhook: 'Webhook',
  github: 'GitHub issue',
  n8n: 'n8n',
};

export const kindLabel: Record<string, string> = {
  incident_opened: 'Opened',
  incident_reopened: 'Reopened',
  incident_assigned: 'Assigned',
  destination_test: 'Test message',
};

export const kindText = (kind: string) => kindLabel[kind] ?? kind;

/** Where a destination sends: never a secret (the Slack URL is not shown). */
export function whereText(d: DestinationSummary): string {
  if (d.type === 'email') return d.recipients.join(', ');
  if (d.type === 'webhook' || d.type === 'n8n') return d.url ?? '';
  if (d.type === 'github') return d.repository ?? '';
  return 'Slack incoming webhook';
}

const reasons: Record<string, string> = {
  email_not_configured: 'No email provider is set up yet',
  no_recipients: 'No recipients',
  secret_unavailable: 'The stored secret could not be opened',
  invalid_destination: 'The saved address is not valid',
  address_blocked: 'The address is not allowed (private or local network)',
  slack_rate_limited: 'Slack asked us to slow down',
  slack_timeout: 'The receiver took too long to answer',
  n8n_timeout: 'The receiver took too long to answer',
  webhook_timeout: 'The receiver took too long to answer',
  slack_unreachable: 'The receiver could not be reached',
  n8n_unreachable: 'The receiver could not be reached',
  webhook_unreachable: 'The receiver could not be reached',
  transport_error: 'Sending failed',
  send_failed: 'Sending failed',
  github_unauthorized: 'GitHub rejected the access token',
  github_forbidden: 'The token is not allowed to open issues in this repository',
  github_repo_not_found: 'The repository was not found (or the token cannot see it)',
  github_rejected: 'GitHub rejected the issue (check the labels)',
  github_rate_limited: 'GitHub asked us to slow down',
  github_timeout: 'GitHub took too long to answer',
  github_unreachable: 'GitHub could not be reached',
  feature_disabled: 'This destination type is turned off in this deployment',
  destination_inactive: 'The destination was paused or archived',
};

/** A reason code from the worker as a plain sentence. */
export function reasonText(code: string | null): string {
  if (code === null) return '—';
  const known = reasons[code];
  if (known !== undefined) return known;
  const gh = /^github_http_(\d{3})$/.exec(code);
  if (gh !== null) return `GitHub answered with an error (${gh[1]})`;
  const http = /^(?:slack|webhook|n8n)_http_(\d{3})$/.exec(code);
  if (http !== null) return `The receiver answered with an error (${http[1]})`;
  return 'Sending failed';
}
