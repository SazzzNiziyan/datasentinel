import type { PrismaClient } from '@datasentinel/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { PRISMA } from '../db.js';
import {
  CurrentWorkspace,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { operatorJobs, QUEUE_OPS, type QueueOps } from './queue-ops.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Operational counts of this workspace, for admins (Phase N). Numbers only:
 * no names, payloads, or errors, so it is safe to chart or alert on. */
export interface WorkspaceMetrics {
  generatedAt: string;
  incidents: { open: number };
  checks: { failedLast24h: number; erroredLast24h: number };
  notifications: { pending: number; failed: number };
  actions: { awaitingApproval: number; failedLast24h: number };
  ai: { investigationsFailedLast24h: number };
  queue: { failed: number; stalled: number };
}

@Controller('workspaces/:workspaceId/metrics')
@RequireRole('admin')
export class MetricsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_OPS) private readonly ops: QueueOps,
  ) {}

  @Get()
  async get(@CurrentWorkspace() { workspaceId }: WorkspaceAccess): Promise<WorkspaceMetrics> {
    const now = new Date();
    const since = new Date(now.getTime() - DAY_MS);
    const db = this.prisma;
    const [open, failed, errored, pending, notFailed, awaiting, actFailed, aiFailed, jobs] =
      await Promise.all([
        db.incident.count({ where: { workspaceId, status: { not: 'resolved' } } }),
        db.checkRun.count({ where: { workspaceId, status: 'failed', createdAt: { gte: since } } }),
        db.checkRun.count({ where: { workspaceId, status: 'error', createdAt: { gte: since } } }),
        db.notificationDelivery.count({ where: { workspaceId, status: 'pending' } }),
        db.notificationDelivery.count({ where: { workspaceId, status: 'failed' } }),
        db.actionProposal.count({ where: { workspaceId, status: 'proposed' } }),
        db.actionProposal.count({
          where: { workspaceId, status: 'failed', createdAt: { gte: since } },
        }),
        db.investigationReport.count({
          where: { workspaceId, status: 'failed', createdAt: { gte: since } },
        }),
        this.ops.list(),
      ]);
    const count = (state: 'failed' | 'stalled') => {
      const list = operatorJobs(jobs, workspaceId, now, state);
      return list.jobs.length + list.omitted;
    };
    return {
      generatedAt: now.toISOString(),
      incidents: { open },
      checks: { failedLast24h: failed, erroredLast24h: errored },
      notifications: { pending, failed: notFailed },
      actions: { awaitingApproval: awaiting, failedLast24h: actFailed },
      ai: { investigationsFailedLast24h: aiFailed },
      queue: { failed: count('failed'), stalled: count('stalled') },
    };
  }
}
