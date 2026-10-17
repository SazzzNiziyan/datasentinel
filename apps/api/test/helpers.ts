import 'reflect-metadata';
import { createPrismaClient } from '@datasentinel/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { MemoryRateLimiter, RATE_LIMITER } from '../src/auth/rate-limit.js';
import { DEPENDENCY_CHECKS } from '../src/health/dependency-checks.js';
import { configureHttp } from '../src/http.js';

export const WEB = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';
export const databaseUrl = process.env.DATABASE_URL ?? '';

/** Test-side database access, for arranging and checking rows. */
export const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');

/** Integration tests skip when the local database is not running. */
export async function databaseSkipReason(): Promise<string | false> {
  if (databaseUrl === '') return 'DATABASE_URL is not set';
  try {
    await prisma.$queryRaw`SELECT 1`;
    return false;
  } catch {
    return 'local database is not running (pnpm services:up)';
  }
}

/** Starts the real API module against the local database. */
export async function startApi(): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        logLevel: 'silent',
        databaseUrl,
        redisUrl: 'redis://unused',
        webOrigin: WEB,
        secureCookies: false,
      }),
    ],
  })
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue([])
    .overrideProvider(RATE_LIMITER)
    .useValue(new MemoryRateLimiter())
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttp(app, WEB);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

/** Creates a user with PASSWORD; the caller deletes it afterwards. */
export async function createUser() {
  return prisma.user.create({
    data: {
      email: `test-${randomUUID()}@test.example`,
      displayName: 'Test User',
      passwordHash: await hashPassword(PASSWORD),
    },
  });
}

/** Signs in and returns the Cookie header value for later requests. */
export async function signInCookie(url: string, email: string): Promise<string> {
  const res = await fetch(`${url}/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const token = /ds_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (token === undefined) throw new Error(`sign-in failed with ${res.status}`);
  return `ds_session=${token}`;
}
