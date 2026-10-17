import { destinationContext, openSecret, type KeyRing } from '@datasentinel/connectors';
import { GitHubToken } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import { deliverDue } from './deliver.js';
import type { PostJson } from './deliver-slack.js';
import { HEADLINE, notificationLink, type DeliveryKind } from './email-template.js';

export interface GitHubDeliveryDeps {
  prisma: PrismaClient;
  ring: KeyRing;
  post: PostJson;
  webOrigin: string;
  timeoutMs?: number;
  /** Tests only: limit to these workspaces. */
  workspaceIds?: string[];
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Markdown from untrusted text: control characters become spaces, markup
 * characters are escaped, and an @ gets a zero-width space so a title can
 * never mention a person or team (D-96). */
const escapeMarkdown = (value: string): string =>
  Array.from(value, (c) => (c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&')
    .replaceAll('@', '@​');

const field = (payload: unknown, name: string, fallback: string): string => {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[name]
      : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
};

/** The issue for one notification: the safe payload and a link back, plus a
 * hidden marker with the delivery id (D-96). */
export function renderGitHubIssue(input: {
  kind: DeliveryKind;
  payload: unknown;
  incidentId: string;
  deliveryId: string;
  webOrigin: string;
  labels: string[];
}): { title: string; body: string; labels: string[] } {
  const title = escapeMarkdown(field(input.payload, 'title', 'Untitled incident'));
  const plainTitle = Array.from(field(input.payload, 'title', 'Untitled incident'), (c) =>
    c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f ? ' ' : c,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    // The issue title is plain text in GitHub, so it needs no escaping.
    title: `[DataSentinel] ${HEADLINE[input.kind]}: ${plainTitle}`.slice(0, 250),
    body:
      `**${HEADLINE[input.kind]}**: ${title}\n\n` +
      `Severity: ${escapeMarkdown(field(input.payload, 'severity', 'unknown'))} · ` +
      `Dataset: ${escapeMarkdown(field(input.payload, 'datasetName', 'unknown dataset'))}\n\n` +
      `[Open the incident in DataSentinel](${notificationLink(input.webOrigin, input.kind, input.incidentId)})\n\n` +
      `<!-- datasentinel-delivery:${input.deliveryId} -->`,
    labels: input.labels,
  };
}

/** Opens a GitHub issue for each due delivery (D-96). Only api.github.com
 * is ever contacted; owner and repository are re-validated before every
 * send. Not idempotent on GitHub's side: a retry after a lost response can
 * open a second issue, which the hidden delivery marker makes traceable. */
export function deliverGitHub(deps: GitHubDeliveryDeps, now: Date, limit = 20) {
  return deliverDue(
    deps.prisma,
    'github',
    now,
    limit,
    async ({ delivery, destination }, kind) => {
      const settings = destination.settings as { owner?: string; repo?: string; labels?: string[] };
      if (
        typeof settings.owner !== 'string' ||
        typeof settings.repo !== 'string' ||
        !NAME.test(settings.owner) ||
        !NAME.test(settings.repo) ||
        settings.owner === '..' ||
        settings.repo === '..'
      ) {
        return { ok: false, retryable: false, reason: 'invalid_destination' };
      }
      let token: string | undefined;
      try {
        token = openSecret(
          deps.ring,
          {
            ciphertext: Buffer.from(destination.ciphertext ?? []),
            keyVersion: destination.keyVersion ?? 0,
          },
          destinationContext(destination.workspaceId, destination.id),
        ).token;
      } catch {
        return { ok: false, retryable: false, reason: 'secret_unavailable' };
      }
      if (token === undefined || !GitHubToken.safeParse(token).success) {
        return { ok: false, retryable: false, reason: 'secret_unavailable' };
      }
      let response;
      try {
        response = await deps.post(
          `https://api.github.com/repos/${settings.owner}/${settings.repo}/issues`,
          renderGitHubIssue({
            kind,
            payload: delivery.payload,
            incidentId: delivery.incidentId,
            deliveryId: delivery.id,
            webOrigin: deps.webOrigin,
            labels: Array.isArray(settings.labels) ? settings.labels.slice(0, 5) : [],
          }),
          deps.timeoutMs ?? 8000,
          {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'DataSentinel-Issues/1',
          },
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return {
          ok: false,
          retryable: true,
          reason: timedOut ? 'github_timeout' : 'github_unreachable',
        };
      }
      if (response.status === 201) return { ok: true };
      if (response.status === 401)
        return { ok: false, retryable: false, reason: 'github_unauthorized' };
      if (response.status === 403)
        return { ok: false, retryable: false, reason: 'github_forbidden' };
      if (response.status === 404)
        return { ok: false, retryable: false, reason: 'github_repo_not_found' };
      if (response.status === 422)
        return { ok: false, retryable: false, reason: 'github_rejected' };
      if (response.status === 429)
        return { ok: false, retryable: true, reason: 'github_rate_limited' };
      return {
        ok: false,
        retryable: response.status >= 500,
        reason: `github_http_${response.status}`,
      };
    },
    deps.workspaceIds,
  );
}
