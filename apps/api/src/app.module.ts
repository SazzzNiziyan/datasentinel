import { loadApiEnv } from '@datasentinel/config';
import { createPrismaClient } from '@datasentinel/db';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { MeController } from './auth/me.controller.js';
import { OriginGuard } from './auth/origin.guard.js';
import { RATE_LIMITER, RedisRateLimiter } from './auth/rate-limit.js';
import { SessionGuard } from './auth/session.guard.js';
import { PRISMA, PrismaLifecycle } from './db.js';
import { createDependencyChecks, DEPENDENCY_CHECKS } from './health/dependency-checks.js';
import { HealthController } from './health/health.controller.js';
import { loggerParams } from './logging/logging.js';
import { MembersController } from './workspaces/members.controller.js';
import { WorkspaceGuard } from './workspaces/workspace.guard.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { APP_OPTIONS, type AppOptions } from './options.js';
import { ProblemFilter } from './problem.js';
import { SourcesController } from './sources/sources.controller.js';

@Module({})
export class AppModule {
  /** main.ts passes values from the validated environment; tests pass
   * their own (and replace the dependency checks and rate limiter). */
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(loggerParams(options))],
      controllers: [
        HealthController,
        AuthController,
        MeController,
        WorkspacesController,
        MembersController,
        SourcesController,
      ],
      providers: [
        { provide: APP_OPTIONS, useValue: options },
        // Connects lazily, on the first query.
        { provide: PRISMA, useFactory: () => createPrismaClient(options.databaseUrl) },
        PrismaLifecycle,
        { provide: RATE_LIMITER, useFactory: () => new RedisRateLimiter(options.redisUrl) },
        AuthService,
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Order matters: refuse foreign origins, require a session, then
        // check workspace membership on routes with :workspaceId.
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: WorkspaceGuard },
        {
          provide: DEPENDENCY_CHECKS,
          // Reads the environment only when the real checks are built, so
          // tests can replace this provider without a full .env.
          useFactory: () => createDependencyChecks(loadApiEnv()),
        },
      ],
    };
  }
}
