import type { QueueJobList } from '@datasentinel/contracts';
import { Controller, Get, HttpStatus, Inject, Query } from '@nestjs/common';
import { ProblemException } from '../problem.js';
import {
  CurrentWorkspace,
  RequireRole,
  type WorkspaceAccess,
} from '../workspaces/workspace.guard.js';
import { operatorJobs, QUEUE_OPS, type QueueOps } from './queue-ops.js';

/** Failed and stalled background jobs of the workspace, for admins (D-78).
 * Read-only: it shows what needs attention and never job data. */
@Controller('workspaces/:workspaceId/queue-jobs')
@RequireRole('admin')
export class QueueJobsController {
  constructor(@Inject(QUEUE_OPS) private readonly ops: QueueOps) {}

  @Get()
  async list(
    @CurrentWorkspace() { workspaceId }: WorkspaceAccess,
    @Query('state') state?: string,
  ): Promise<QueueJobList> {
    if (state !== undefined && state !== 'failed' && state !== 'stalled') {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'The state filter is failed or stalled.',
      );
    }
    return operatorJobs(await this.ops.list(), workspaceId, new Date(), state);
  }
}
