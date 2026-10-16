import { loadApiEnv } from '@datasentinel/config';
import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createDependencyChecks, DEPENDENCY_CHECKS } from './health/dependency-checks.js';
import { HealthController } from './health/health.controller.js';
import { loggerParams, type LoggingOptions } from './logging/logging.js';

@Module({})
export class AppModule {
  /** Logging options come from the caller: main.ts reads LOG_LEVEL from
   * the environment, tests pass a silent or collecting logger. */
  static register(logging: LoggingOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(loggerParams(logging))],
      controllers: [HealthController],
      providers: [
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
