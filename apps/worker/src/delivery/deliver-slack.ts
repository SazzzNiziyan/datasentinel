import { destinationContext, openSecret, type KeyRing } from '@datasentinel/connectors';
import { SlackWebhookUrl } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { deliverDue } from './deliver.js';
import { HEADLINE, notificationLink, type DeliveryKind } from './email-template.js';

/** One HTTP POST, so tests (and later the retry logic) can replace it. */
export type PostJson = (
  url: string,
  body: unknown,
  timeoutMs: number,
  headers?: Record<string, string>,
) => Promise<{ status: number; text: string }>;

/** Real POST: JSON body, a hard timeout, redirects never followed (a
 * redirect would be a way to reach somewhere the URL check did not), and
 * the response body capped. */
export const postJson: PostJson = async (url, body, timeoutMs, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: (await response.text()).slice(0, 200) };
};

export interface SlackDeliveryDeps {
  prisma: PrismaClient;
  ring: KeyRing;
  post: PostJson;
  webOrigin: string;
  timeoutMs?: number;
  /** Tests only: limit to these workspaces. */
  workspaceIds?: string[];
}

/** Slack treats &, <, and > as markup: escape them so a title cannot add a
 * mention or link (D-90). */
const escapeSlack = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const field = (payload: unknown, name: string, fallback: string): string => {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[name]
      : undefined;
  const text = typeof value === 'string' && value.trim() !== '' ? value : fallback;
  return escapeSlack(text.replace(/\s+/g, ' ').trim().slice(0, 200));
};

/** The Slack message for one incident notification: the safe payload and a
 * link back, nothing else (D-90). */
export function renderSlackMessage(input: {
  kind: DeliveryKind;
  payload: unknown;
  incidentId: string;
  webOrigin: string;
}): { text: string } {
  const link = notificationLink(input.webOrigin, input.kind, input.incidentId);
  return {
    text:
      `*${HEADLINE[input.kind]}*: ${field(input.payload, 'title', 'Untitled incident')}\n` +
      `Severity: ${field(input.payload, 'severity', 'unknown')} · ` +
      `Dataset: ${field(input.payload, 'datasetName', 'unknown dataset')}\n` +
      `<${link}|Open the incident>`,
  };
}

/** Sends due Slack deliveries (D-90). The webhook URL is opened from the
 * sealed secret only here, and checked against the Slack-only pattern again
 * before every send. */
export function deliverSlack(deps: SlackDeliveryDeps, now: Date, limit = 20) {
  return deliverDue(
    deps.prisma,
    'slack',
    now,
    limit,
    async ({ delivery, destination }, kind) => {
      let webhookUrl: string | undefined;
      try {
        webhookUrl = openSecret(
          deps.ring,
          {
            ciphertext: Buffer.from(destination.ciphertext ?? []),
            keyVersion: destination.keyVersion ?? 0,
          },
          destinationContext(destination.workspaceId, destination.id),
        ).webhookUrl;
      } catch {
        return { ok: false, retryable: false, reason: 'secret_unavailable' };
      }
      if (!SlackWebhookUrl.safeParse(webhookUrl).success) {
        return { ok: false, retryable: false, reason: 'invalid_destination' };
      }
      let response;
      try {
        response = await deps.post(
          webhookUrl!,
          renderSlackMessage({
            kind,
            payload: delivery.payload,
            incidentId: delivery.incidentId,
            webOrigin: deps.webOrigin,
          }),
          deps.timeoutMs ?? 5000,
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return {
          ok: false,
          retryable: true,
          reason: timedOut ? 'slack_timeout' : 'slack_unreachable',
        };
      }
      if (response.status === 200) return { ok: true };
      if (response.status === 429)
        return { ok: false, retryable: true, reason: 'slack_rate_limited' };
      return {
        ok: false,
        retryable: response.status >= 500,
        reason: `slack_http_${response.status}`,
      };
    },
    deps.workspaceIds,
  );
}
