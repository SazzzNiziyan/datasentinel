import { Controller, Get, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { DependencyName, DependencyState, ReadinessReport } from '@datasentinel/contracts';
import { Public } from '../auth/session.guard.js';
import { CHECK_TIMEOUT_MS, DEPENDENCY_CHECKS, type DependencyCheck } from './dependency-checks.js';

/** The kind of failure, safe to log: error class, error code, and HTTP status
 * only. Never the message, which can quote hosts, users, or keys. */
function failureKind(reason: unknown): string {
  const e = reason as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const parts = [e.name, e.code, e.$metadata?.httpStatusCode].filter(
    (v): v is string | number => typeof v === 'string' || typeof v === 'number',
  );
  return parts.length === 0 ? 'unknown' : parts.join(' ');
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    work,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

/** Liveness and readiness (docs/08 §Operations). Responses name each
 * dependency and its state only: no URLs, errors, or topology. */
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DEPENDENCY_CHECKS) private readonly checks: readonly DependencyCheck[]) {}

  /** The process is running. Never touches dependencies. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Every dependency answered within the timeout; 503 otherwise. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const results = await Promise.allSettled(
      this.checks.map((c) => withTimeout(c.check(), CHECK_TIMEOUT_MS)),
    );
    const dependencies: Partial<Record<DependencyName, DependencyState>> = {};
    this.checks.forEach((c, i) => {
      const result = results[i];
      dependencies[c.name] = result?.status === 'fulfilled' ? 'up' : 'down';
      if (result?.status === 'rejected') {
        this.logger.warn(`readiness: ${c.name} down (${failureKind(result.reason)})`);
      }
    });
    const ready = Object.values(dependencies).every((state) => state === 'up');
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'not_ready', dependencies };
  }
}
