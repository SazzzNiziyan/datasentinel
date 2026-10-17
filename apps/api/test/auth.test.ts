import 'reflect-metadata';
import { createPrismaClient } from '@datasentinel/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { MemoryRateLimiter, RATE_LIMITER } from '../src/auth/rate-limit.js';
import { DEPENDENCY_CHECKS } from '../src/health/dependency-checks.js';
import { configureHttp } from '../src/http.js';

const WEB = 'http://localhost:5173';
const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');

async function databaseAvailable(): Promise<boolean> {
  if (databaseUrl === '') return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// Integration test: needs the local database (pnpm services:up + migrate).
const skip = !(await databaseAvailable()) && 'local database is not running';

const PASSWORD = 'correct horse battery staple';
const email = () => `auth-${randomUUID()}@test.example`;

describe('sign-in and sign-out', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const created: string[] = [];

  async function createUser(address = email()) {
    const user = await prisma.user.create({
      data: {
        email: address,
        displayName: 'Test User',
        passwordHash: await hashPassword(PASSWORD),
      },
    });
    created.push(user.id);
    return user;
  }

  const signIn = (body: unknown, origin = WEB) =>
    fetch(`${url}/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    });

  /** The ds_session token from a Set-Cookie header. */
  const tokenFrom = (res: Response) =>
    /ds_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

  before(async () => {
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
    app = moduleRef.createNestApplication({ logger: false });
    configureHttp(app, WEB);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('signs in and sets an HttpOnly session cookie; only its hash is stored', async () => {
    const user = await createUser();
    const res = await signIn({ email: user.email.toUpperCase(), password: PASSWORD });
    assert.equal(res.status, 204);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const token = tokenFrom(res) ?? '';
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(session.tokenHash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(session.tokenHash, token);
  });

  it('answers a wrong password exactly like an unknown email', async () => {
    const user = await createUser();
    const wrong = await signIn({ email: user.email, password: 'not the password' });
    const unknown = await signIn({ email: email(), password: PASSWORD });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const a = (await wrong.json()) as Record<string, unknown>;
    const b = (await unknown.json()) as Record<string, unknown>;
    assert.equal(a.code, 'invalid_credentials');
    assert.deepEqual({ ...a, instance: '' }, { ...b, instance: '' });
  });

  it('rejects malformed input as a problem response', async () => {
    const res = await signIn({ email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/problem\+json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'invalid_request');
    assert.equal(body.instance, res.headers.get('x-request-id'));
  });

  it('answers a malformed JSON body with a 400 problem, not a 500', async () => {
    const res = await fetch(`${url}/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: '{bad',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Record<string, unknown>).code, 'http_400');
  });

  it('refuses state-changing requests from another origin', async () => {
    const user = await createUser();
    const res = await signIn({ email: user.email, password: PASSWORD }, 'https://evil.example');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as Record<string, unknown>).code, 'origin_not_allowed');
  });

  it('limits repeated attempts for one email', async () => {
    const user = await createUser();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await signIn({ email: user.email, password: 'wrong' })).status);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  });

  it('signs out: revokes the session and clears the cookie', async () => {
    const user = await createUser();
    const token = tokenFrom(await signIn({ email: user.email, password: PASSWORD })) ?? '';
    const res = await fetch(`${url}/auth/sessions/current`, {
      method: 'DELETE',
      headers: { cookie: `ds_session=${token}`, origin: WEB },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('set-cookie') ?? '', /ds_session=;/);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    assert.notEqual(session.revokedAt, null);
  });
});
