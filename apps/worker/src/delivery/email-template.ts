import {
  DESTINATION_TEST_KIND,
  notificationKinds,
  type NotificationKind,
} from '@datasentinel/contracts';

export type EmailMessage = { to: string[]; subject: string; text: string; html: string };

/** `incident_notice` is what an approved recovery action sends (D-113); it is
 * not an event a destination subscribes to. */
export type DeliveryKind = NotificationKind | typeof DESTINATION_TEST_KIND | 'incident_notice';

export const HEADLINE: Record<DeliveryKind, string> = {
  destination_test: 'Test notification',
  incident_notice: 'Incident notice',
  incident_opened: 'Incident opened',
  incident_reopened: 'Incident reopened',
  incident_assigned: 'Incident assigned',
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Control characters (including line breaks) become spaces: a title can
 * never add a mail header or break the layout (D-89). */
const isControl = (code: number): boolean =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

const flatten = (value: string, max: number): string =>
  Array.from(value, (c) => (isControl(c.codePointAt(0) ?? 0) ? ' ' : c))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback;

export const isNotificationKind = (value: string): value is DeliveryKind =>
  value === DESTINATION_TEST_KIND ||
  value === 'incident_notice' ||
  (notificationKinds as readonly string[]).includes(value);

/** Where a notification links to: the incident, or Settings for a test. */
export const notificationLink = (webOrigin: string, kind: DeliveryKind, incidentId: string) =>
  `${webOrigin.replace(/\/+$/, '')}${
    kind === DESTINATION_TEST_KIND ? '/settings' : `/incidents/${encodeURIComponent(incidentId)}`
  }`;

/** The email for one incident notification (D-89). It carries only the safe
 * payload (title, severity, dataset name) and a link back; never rule
 * results, rows, or secrets. All values are escaped in HTML and flattened in
 * the subject, and there are no remote images or scripts. */
export function renderIncidentEmail(input: {
  kind: DeliveryKind;
  payload: unknown;
  incidentId: string;
  webOrigin: string;
  to: string[];
}): EmailMessage {
  const payload = (
    typeof input.payload === 'object' && input.payload !== null ? input.payload : {}
  ) as Record<string, unknown>;
  const title = flatten(text(payload.title, 'Untitled incident'), 200);
  const severity = flatten(text(payload.severity, 'unknown'), 20);
  const dataset = flatten(text(payload.datasetName, 'unknown dataset'), 200);
  const headline = HEADLINE[input.kind];
  const link = notificationLink(input.webOrigin, input.kind, input.incidentId);
  const subject = `[DataSentinel] ${headline}: ${title}`.slice(0, 200);
  const lines = [
    headline,
    '',
    `Title: ${title}`,
    `Severity: ${severity}`,
    `Dataset: ${dataset}`,
    '',
    `Open the incident: ${link}`,
  ];
  const html =
    `<p><strong>${escapeHtml(headline)}</strong></p>` +
    `<p>Title: ${escapeHtml(title)}<br>Severity: ${escapeHtml(severity)}<br>` +
    `Dataset: ${escapeHtml(dataset)}</p>` +
    `<p><a href="${escapeHtml(link)}">Open the incident</a></p>`;
  return { to: input.to, subject, text: lines.join('\n'), html };
}
