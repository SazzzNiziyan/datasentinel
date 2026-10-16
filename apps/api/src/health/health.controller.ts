import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { DependencyName, DependencyState, ReadinessReport } from '@datasentinel/contracts';
import { CHECK_TIMEOUT_MS, DEPENDENCY_CHECKS, type DependencyCheck } from './dependency-checks.js';

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    work,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

/** Liveness and readiness (docs/08 §Operations). Responses name each
 * dependency and its state only: no URLs, errors, or topology. */
@Controller('health')
export class HealthController {
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
      dependencies[c.name] = results[i]?.status === 'fulfilled' ? 'up' : 'down';
    });
    const ready = Object.values(dependencies).every((state) => state === 'up');
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'not_ready', dependencies };
  }
}
