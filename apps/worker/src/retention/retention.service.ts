import { type PrismaClient } from '@datasentinel/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sweepExpiredUploads, type RemoveObject } from './sweep-uploads.js';

export const RETENTION_DEPS = Symbol('RETENTION_DEPS');

export interface RetentionServiceDeps {
  prisma: PrismaClient;
  remove: RemoveObject;
  /** Tests shorten it. */
  tickMs?: number;
}

/** Every 15 minutes: remove raw uploads past their retention date. */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(@Inject(RETENTION_DEPS) private readonly deps: RetentionServiceDeps) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 15 * 60_000);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const { removed, failed } = await sweepExpiredUploads(
        this.deps.prisma,
        this.deps.remove,
        now,
      );
      if (removed + failed > 0) {
        this.logger.log(`retention: removed ${removed} raw files, ${failed} failed`);
      }
      return removed;
    } catch (error) {
      this.logger.error(`retention pass failed: ${error instanceof Error ? error.name : 'error'}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
