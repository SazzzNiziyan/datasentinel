import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConfigError, decodeKey, loadApiEnv, loadWorkerEnv } from '@datasentinel/config';

const KEY = randomBytes(32).toString('base64');
const SESSION_KEY = randomBytes(32).toString('base64');

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: 'true',
  S3_BUCKET_UPLOADS: 'uploads',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'super-secret-access-key',
  SECRETS_ENCRYPTION_KEY: KEY,
  SECRETS_ENCRYPTION_KEY_VERSION: '1',
  WEB_ORIGIN: 'http://localhost:5173',
  SESSION_SECRET: SESSION_KEY,
  OAUTH_CALLBACK_BASE_URL: 'http://localhost:3000',
};

function problems(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected a ConfigError');
}

describe('decodeKey', () => {
  it('accepts base64 for exactly 32 bytes', () => {
    assert.equal(decodeKey(KEY)?.length, 32);
  });
  it('rejects the wrong length', () => {
    assert.equal(decodeKey(randomBytes(16).toString('base64')), undefined);
    assert.equal(decodeKey(randomBytes(33).toString('base64')), undefined);
  });
  it('rejects text that is not base64', () => {
    assert.equal(decodeKey('not a key'), undefined);
    // 44 characters like a real key, but with characters outside base64.
    assert.equal(decodeKey(`${KEY.slice(0, 40)}!!!=`), undefined);
    // Lenient decoders skip unknown characters; a key must not be "repaired".
    assert.equal(decodeKey(`${KEY.slice(0, 20)}*${KEY.slice(20)}`), undefined);
  });
});

describe('loadApiEnv', () => {
  it('parses a valid environment into typed values', () => {
    const env = loadApiEnv(valid);
    assert.equal(env.API_PORT, 3000);
    assert.equal(env.S3_FORCE_PATH_STYLE, true);
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(env.SECRETS_ENCRYPTION_KEY.length, 32);
  });

  it('reports every problem at once, by name', () => {
    const found = problems(() =>
      loadApiEnv({ ...valid, DATABASE_URL: undefined, API_PORT: '99999', NODE_ENV: 'prod' }),
    );
    assert.deepEqual(found.map((p) => p.split(' ')[0]).sort(), [
      'API_PORT',
      'DATABASE_URL',
      'NODE_ENV',
    ]);
    assert.ok(found.includes('DATABASE_URL is required'));
  });

  it('never includes a value in the error message', () => {
    const secret = 'postgresql-but-not-a-url-hunter2';
    try {
      loadApiEnv({
        ...valid,
        DATABASE_URL: secret,
        SESSION_SECRET: 'hunter2',
        S3_ENDPOINT: 'ftp://hunter2',
      });
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes('hunter2'), error.message);
    }
  });

  it('treats empty secrets from .env.example as missing', () => {
    const found = problems(() =>
      loadApiEnv({ ...valid, SESSION_SECRET: '', SECRETS_ENCRYPTION_KEY: '  ' }),
    );
    assert.deepEqual(found.map((p) => p.split(' ')[0]).sort(), [
      'SECRETS_ENCRYPTION_KEY',
      'SESSION_SECRET',
    ]);
  });

  it('requires both halves of a sign-in provider', () => {
    assert.deepEqual(
      problems(() => loadApiEnv({ ...valid, GITHUB_CLIENT_ID: 'abc' })),
      ['GITHUB_CLIENT_SECRET is required when the other GITHUB value is set'],
    );
    assert.doesNotThrow(() =>
      loadApiEnv({ ...valid, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
    );
  });

  it('requires https origins in production', () => {
    const found = problems(() => loadApiEnv({ ...valid, NODE_ENV: 'production' }));
    assert.deepEqual([...found].sort(), [
      'OAUTH_CALLBACK_BASE_URL must use https in production',
      'WEB_ORIGIN must use https in production',
    ]);
  });

  it('rejects the same key for sessions and stored-secret encryption', () => {
    assert.deepEqual(
      problems(() => loadApiEnv({ ...valid, SESSION_SECRET: KEY })),
      ['SESSION_SECRET must be different from SECRETS_ENCRYPTION_KEY'],
    );
  });

  it('reports invalid keys and URLs in production without crashing', () => {
    const found = problems(() =>
      loadApiEnv({
        ...valid,
        NODE_ENV: 'production',
        SESSION_SECRET: 'x',
        SECRETS_ENCRYPTION_KEY: 'y',
        WEB_ORIGIN: 'not a url',
        OAUTH_CALLBACK_BASE_URL: '',
      }),
    );
    assert.ok(found.length >= 4);
  });

  it('requires WEB_ORIGIN to be a bare origin', () => {
    for (const bad of ['http://localhost:5173/', 'https://x.com/app', 'https://u:p@x.com']) {
      const found = problems(() => loadApiEnv({ ...valid, WEB_ORIGIN: bad }));
      assert.ok(found.length > 0 && found.every((p) => p.startsWith('WEB_ORIGIN ')), bad);
    }
  });

  it('accepts only digits for numbers', () => {
    for (const bad of ['0x10', '1e3', '1.0', 'abc', '-1', '0', '70000']) {
      const [problem] = problems(() => loadApiEnv({ ...valid, API_PORT: bad }));
      assert.match(problem ?? '', /^API_PORT must be/, bad);
    }
    assert.equal(loadApiEnv({ ...valid, API_PORT: ' 8080 ' }).API_PORT, 8080);
  });

  it('requires a host in service URLs', () => {
    assert.deepEqual(
      problems(() => loadApiEnv({ ...valid, DATABASE_URL: 'postgresql:', REDIS_URL: 'redis:' })),
      [
        'DATABASE_URL must be a postgresql:// URL with a host',
        'REDIS_URL must be a redis:// or rediss:// URL with a host',
      ],
    );
  });

  it('treats the URL scheme case-insensitively in production', () => {
    assert.doesNotThrow(() =>
      loadApiEnv({
        ...valid,
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://app.example.com',
        OAUTH_CALLBACK_BASE_URL: 'HTTPS://api.example.com',
      }),
    );
  });
});

describe('loadWorkerEnv', () => {
  it('does not require API-only settings', () => {
    const { WEB_ORIGIN, SESSION_SECRET, OAUTH_CALLBACK_BASE_URL, ...workerOnly } = valid;
    assert.equal(loadWorkerEnv(workerOnly).SECRETS_ENCRYPTION_KEY_VERSION, 1);
  });
});
