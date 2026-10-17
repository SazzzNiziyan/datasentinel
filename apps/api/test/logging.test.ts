import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { AppModule } from '../src/app.module.js';
import { DEPENDENCY_CHECKS } from '../src/health/dependency-checks.js';
import { scrubSecrets } from '../src/logging/logging.js';

const lines: string[] = [];
const stream = { write: (line: string) => void lines.push(line) };

/** Waits for the request log line, which pino writes when the response ends. */
async function logFor(requestId: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const line = lines.find((l) => l.includes(requestId));
    if (line !== undefined) return line;
    await sleep(10);
  }
  throw new Error(`no log line for ${requestId}`);
}

describe('request IDs and request logs', () => {
  let app: INestApplication;
  let url: string;
  before(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          logLevel: 'info',
          logStream: stream,
          databaseUrl: 'postgresql://unused@127.0.0.1:1/unused',
          redisUrl: 'redis://unused',
          webOrigin: 'http://localhost:5173',
          secureCookies: false,
        }),
      ],
    })
      .overrideProvider(DEPENDENCY_CHECKS)
      .useValue([])
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  after(() => app.close());

  it('gives every response a request ID', async () => {
    const res = await fetch(`${url}/health/live`);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  it('keeps a safe incoming request ID and logs it as JSON', async () => {
    const res = await fetch(`${url}/health/live`, { headers: { 'x-request-id': 'trace-42.a' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-42.a');
    const entry = JSON.parse(await logFor('trace-42.a')) as { req: { id: string } };
    assert.equal(entry.req.id, 'trace-42.a');
  });

  it('replaces an unsafe incoming request ID', async () => {
    const res = await fetch(`${url}/health/live`, {
      headers: { 'x-request-id': 'x'.repeat(200) },
    });
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  it('never logs headers or query strings, which can carry secrets', async () => {
    const res = await fetch(`${url}/health/live?code=oauth-code-123`, {
      headers: { authorization: 'Bearer token-abc', cookie: 'sid=cookie-xyz' },
    });
    const line = await logFor(res.headers.get('x-request-id') ?? 'missing');
    assert.match(line, /"\/health\/live"/);
    assert.doesNotMatch(line, /oauth-code-123|token-abc|cookie-xyz/);
  });
});

describe('scrubSecrets', () => {
  it('removes credentials from connection URLs in text', () => {
    assert.equal(
      scrubSecrets('connect failed: postgresql://app:hunter2@db:5432/main and redis://:pw@cache'),
      'connect failed: postgresql://[redacted]@db:5432/main and redis://[redacted]@cache',
    );
  });
});
