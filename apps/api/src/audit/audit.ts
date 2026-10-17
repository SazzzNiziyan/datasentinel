import type { Prisma, PrismaClient } from '@datasentinel/db';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Where a request came from, for audit records. */
export interface RequestMeta {
  requestId: string;
  ip: string;
}

/** The request ID (D-23) and client IP of the current request. */
export const CurrentRequest = createParamDecorator(
  (_: unknown, context: ExecutionContext): RequestMeta => {
    const req = context.switchToHttp().getRequest<Request & { id?: unknown }>();
    return { requestId: typeof req.id === 'string' ? req.id : '', ip: req.ip ?? '' };
  },
);

export type Actor = { type: 'user'; id: string } | { type: 'anonymous' } | { type: 'system' };

export interface AuditEntry {
  action: string;
  actor: Actor;
  request?: RequestMeta;
  workspaceId?: string;
  target?: { type: string; id: string };
  /** Redacted before/after values. Never passwords, tokens, or secrets. */
  summary?: Prisma.InputJsonObject;
}

/** Appends one audit event (D-33). Pass the transaction client when the
 * change it describes is in a transaction, so both commit or neither. */
export async function recordAudit(
  db: PrismaClient | Prisma.TransactionClient,
  entry: AuditEntry,
): Promise<void> {
  await db.auditEvent.create({
    data: {
      action: entry.action,
      actorType: entry.actor.type,
      actorId: entry.actor.type === 'user' ? entry.actor.id : null,
      workspaceId: entry.workspaceId ?? null,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      requestId: entry.request?.requestId || null,
      ip: entry.request?.ip || null,
      summary: entry.summary ?? {},
    },
  });
}
