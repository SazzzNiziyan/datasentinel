import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { claimAction, processAction, type ActionDeps } from './execute.js';

export const ACTION_DEPS = Symbol('ACTION_DEPS');

export type ActionServiceDeps = ActionDeps & {
  /** Tests shorten it. */
  tickMs?: number;
};

/** Every 5 seconds: run approved recovery actions that are due (D-118). */
@Injectable()
export class ActionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ActionService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@Inject(ACTION_DEPS) private readonly deps: ActionServiceDeps) {}

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
      for (let i = 0; i < 5; i += 1) {
        const claimed = await claimAction(this.deps.prisma, now);
        if (claimed === null) break;
        await processAction(this.deps, claimed, now);
        done += 1;
      }
    } catch (error) {
      this.logger.error(`action pass failed: ${error instanceof Error ? error.name : 'error'}`);
    } finally {
      this.running = false;
    }
    return done;
  }
}
