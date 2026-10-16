import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Level } from 'pino';
import {
  SystemQueueService,
  WORKER_OPTIONS,
  type WorkerOptions,
} from './queue/system-queue.service.js';

export interface WorkerModuleOptions extends WorkerOptions {
  logLevel: Level | 'silent';
}

/** Background jobs only; no HTTP server. */
@Module({})
export class WorkerModule {
  static register({ logLevel, ...options }: WorkerModuleOptions): DynamicModule {
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { level: logLevel } })],
      providers: [{ provide: WORKER_OPTIONS, useValue: options }, SystemQueueService],
    };
  }
}
