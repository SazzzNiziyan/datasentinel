import type { PrismaClient } from '@datasentinel/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { claimDueOccurrences, strandedOccurrences, type ClaimedOccurrence } from './claim.js';

/** A claimed occurrence still pending after this long was never queued. */
const STRANDED_AFTER_MS = 5 * 60_000;

export const SCHEDULER_DEPS = Symbol('SCHEDULER_DEPS');

export interface SchedulerDeps {
  prisma: PrismaClient;
  /** Queues the jobs of one claimed occurrence (D-71). */
  dispatch: (occurrence: ClaimedOccurrence) => Promise<void>;
  /** Tests shorten it. */
  tickMs?: number;
}

/** Wakes every 30 seconds, claims due schedule occurrences, and retries
 * stranded ones (D-70). Any number of worker processes may run it: claims
 * never overlap and dispatch is safe to repeat. */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@Inject(SCHEDULER_DEPS) private readonly deps: SchedulerDeps) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 30_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One pass; a pass still running when the next is due is not doubled. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await claimDueOccurrences(this.deps.prisma, now);
      const fresh = new Set(claimed.map((o) => o.id));
      const stranded = (
        await strandedOccurrences(this.deps.prisma, new Date(now.getTime() - STRANDED_AFTER_MS))
      ).filter((o) => !fresh.has(o.id));
      for (const occurrence of [...claimed, ...stranded]) {
        await this.deps.dispatch(occurrence).catch((error: unknown) => {
          this.logger.error(
            `occurrence ${occurrence.id} could not be queued: ${error instanceof Error ? error.name : 'error'}`,
          );
        });
      }
      return claimed.length + stranded.length;
    } catch (error) {
      this.logger.error(`scheduler pass failed: ${error instanceof Error ? error.name : 'error'}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
