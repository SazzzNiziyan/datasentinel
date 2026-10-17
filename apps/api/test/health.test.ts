import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AppModule } from '../src/app.module.js';
import { configureHttp } from '../src/http.js';
import { DEPENDENCY_CHECKS, type DependencyCheck } from '../src/health/dependency-checks.js';

// Boots the real module graph, so a broken injection (for example an
// `import type` on an injected class) fails here, not in production.
async function startApp(
  checks: DependencyCheck[],
): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        logLevel: 'silent',
        databaseUrl: 'postgresql://unused@127.0.0.1:1/unused',
        redisUrl: 'redis://unused',
        webOrigin: 'http://localhost:5173',
        secureCookies: false,
      }),
    ],
  })
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue(checks)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttp(app, 'http://localhost:5173');
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

const up = (name: DependencyCheck['name']): DependencyCheck => ({ name, check: async () => {} });
const down = (name: DependencyCheck['name']): DependencyCheck => ({
  name,
  check: () => Promise.reject(new Error('connect ECONNREFUSED postgresql://user:secret@db')),
});

describe('health endpoints, all dependencies up', () => {
  let app: INestApplication;
  let url: string;
  before(async () => ({ app, url } = await startApp([up('database'), up('redis'), up('storage')])));
  after(() => app.close());

  it('reports liveness without checking dependencies', async () => {
    const res = await fetch(`${url}/health/live`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('lets only the web origin read responses from a browser', async () => {
    const allowed = await fetch(`${url}/health/live`, {
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    // A single allowed origin is always echoed; the browser then blocks
    // every other site because the header does not match its origin.
    const other = await fetch(`${url}/health/live`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.notEqual(other.headers.get('access-control-allow-origin'), 'https://evil.example');
  });

  it('reports ready with each dependency named', async () => {
    const res = await fetch(`${url}/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'ready',
      dependencies: { database: 'up', redis: 'up', storage: 'up' },
    });
  });
});

describe('health endpoints, one dependency down', () => {
  let app: INestApplication;
  let url: string;
  before(
    async () => ({ app, url } = await startApp([down('database'), up('redis'), up('storage')])),
  );
  after(() => app.close());

  it('returns 503 and names the failing dependency without internals', async () => {
    const res = await fetch(`${url}/health/ready`);
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), {
      status: 'not_ready',
      dependencies: { database: 'down', redis: 'up', storage: 'up' },
    });
    assert.doesNotMatch(body, /secret|ECONNREFUSED|postgresql:/);
  });
});
