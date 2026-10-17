import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { claimInvestigation, processInvestigation, type InvestigationDeps } from './investigate.js';

export const INVESTIGATION_DEPS = Symbol('INVESTIGATION_DEPS');

export type InvestigationServiceDeps = InvestigationDeps & {
  /** Tests shorten it. */
  tickMs?: number;
};

/** Every 5 seconds: take pending investigation reports and write them
 * (D-108). Reports are done one at a time per worker, a few per pass, so a
 * slow provider never blocks checks, incidents, or notifications, which run
 * elsewhere. Safe to run in several processes. */
@Injectable()
export class InvestigationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InvestigationService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@Inject(INVESTIGATION_DEPS) private readonly deps: InvestigationServiceDeps) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 5_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One pass; a pass still running when the next is due is not doubled. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      for (let i = 0; i < 3; i += 1) {
        const claimed = await claimInvestigation(this.deps.prisma, now);
        if (claimed === null) break;
        await processInvestigation(this.deps, claimed);
        done += 1;
      }
    } catch (error) {
      this.logger.error(
        `investigation pass failed: ${error instanceof Error ? error.name : 'error'}`,
      );
    } finally {
      this.running = false;
    }
    return done;
  }
}
