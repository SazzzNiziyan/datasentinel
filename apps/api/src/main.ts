import 'reflect-metadata';
import { ConfigError, loadApiEnv } from '@datasentinel/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureHttp } from './http.js';
import { scrubSecrets } from './logging/logging.js';

async function bootstrap() {
  // Fail fast with a safe message (names only, never values).
  const env = loadApiEnv();
  // Startup messages wait for the JSON logger instead of plain text.
  const app = await NestFactory.create(AppModule.register({ logLevel: env.LOG_LEVEL }), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureHttp(app, env.WEB_ORIGIN);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
}

bootstrap().catch((error: unknown) => {
  // Driver errors can quote connection URLs, so credentials are removed.
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error instanceof ConfigError ? error.message : scrubSecrets(text));
  process.exitCode = 1;
});
