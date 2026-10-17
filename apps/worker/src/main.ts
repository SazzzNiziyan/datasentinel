import 'reflect-metadata';
import { ConfigError, loadWorkerEnv } from '@datasentinel/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // Fail fast with a safe message (names only, never values).
  const env = loadWorkerEnv();
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({ logLevel: env.LOG_LEVEL, redisUrl: env.REDIS_URL, scheduler: true }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  // SIGINT/SIGTERM close the queue worker cleanly.
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'worker failed to start');
  process.exitCode = 1;
});
