import type { PrismaClient } from '@datasentinel/db';
import { deliverDue, type SendResult } from './deliver.js';
import { renderIncidentEmail, type EmailMessage } from './email-template.js';

export type { SendResult } from './deliver.js';

/** Provider-neutral email sending (D-89). A real provider is one class that
 * implements this; the worker never sees provider details. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
}

/** Used until a provider is configured: every email delivery fails visibly
 * with a clear reason instead of silently vanishing. */
export const unconfiguredEmail: EmailTransport = {
  send: () => Promise.resolve({ ok: false, retryable: false, reason: 'email_not_configured' }),
};

export interface EmailDeliveryDeps {
  prisma: PrismaClient;
  email: EmailTransport;
  /** Public address of the web app, for the link in the message. */
  webOrigin: string;
  /** Tests only: limit to these workspaces. */
  workspaceIds?: string[];
}

/** Sends due email deliveries (D-89). */
export function deliverEmails(deps: EmailDeliveryDeps, now: Date, limit = 20) {
  return deliverDue(
    deps.prisma,
    'email',
    now,
    limit,
    ({ delivery, destination }, kind) => {
      const recipients = (destination.settings as { recipients?: string[] }).recipients ?? [];
      if (recipients.length === 0) {
        return Promise.resolve({ ok: false, retryable: false, reason: 'no_recipients' });
      }
      return deps.email.send(
        renderIncidentEmail({
          kind,
          payload: delivery.payload,
          incidentId: delivery.incidentId,
          webOrigin: deps.webOrigin,
          to: recipients,
        }),
      );
    },
    deps.workspaceIds,
  );
}
