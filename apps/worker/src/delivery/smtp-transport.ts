import { createTransport } from 'nodemailer';
import type { EmailMessage } from './email-template.js';
import type { EmailTransport, SendResult } from './deliver-email.js';

type Mailer = { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> };

/** Short reason code for a failed send, and whether trying again can help.
 * Never the server's own text, which can echo addresses or credentials. */
export function classifySmtpError(error: unknown): { retryable: boolean; reason: string } {
  const e = error as { code?: unknown; responseCode?: unknown };
  const response = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  if (e.code === 'EAUTH' || response === 535 || response === 534) {
    return { retryable: false, reason: 'email_auth_failed' };
  }
  if (response !== undefined && response >= 500) {
    return { retryable: false, reason: 'email_rejected' };
  }
  return { retryable: true, reason: 'email_unavailable' };
}

/** Sends through any SMTP server (for example Gmail with an app password, or
 * Brevo). `smtpUrl` is `smtps://user:password@host:465` or
 * `smtp://user:password@host:587`; it is a secret and is never logged. */
export function smtpTransport(
  smtpUrl: string,
  from: string,
  mailer: Mailer = createTransport({
    url: smtpUrl,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }),
): EmailTransport {
  return {
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        const sent = await mailer.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return sent.messageId === undefined
          ? { ok: true }
          : { ok: true, messageId: sent.messageId };
      } catch (error) {
        return { ok: false, ...classifySmtpError(error) };
      }
    },
  };
}
