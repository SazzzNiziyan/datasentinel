import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectorFailure,
  discoverTables,
  normalizePgType,
  profilePostgresTable,
  quoteIdent,
  resolveDestination,
  testPostgresConnection,
  withPostgres,
  type PostgresLocation,
} from '@datasentinel/connectors';

const at = (host: string, extra: Partial<PostgresLocation> = {}): PostgresLocation => ({
  host,
  port: 5432,
  database: 'db',
  sslMode: 'verify-full',
  ...extra,
});

const failsWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof ConnectorFailure && e.code === code);

describe('resolveDestination', () => {
  const dns =
    (...ips: string[]) =>
    () =>
      Promise.resolve(ips);

  it('returns a checked address for a public name', async () => {
    assert.deepEqual(
      await resolveDestination(at('db.example.com'), {
        policy: 'public-only',
        resolve: dns('203.0.113.7'),
      }),
      ['203.0.113.7'],
    );
  });

  it('refuses a name when any of its addresses is forbidden (DNS rebinding)', async () => {
    await failsWith(
      resolveDestination(at('db.example.com'), {
        policy: 'public-only',
        resolve: dns('203.0.113.7', '10.0.0.1'),
      }),
      'permission_denied',
    );
    await failsWith(
      resolveDestination(at('db.example.com'), {
        policy: 'allow-private',
        resolve: dns('169.254.169.254'),
      }),
      'permission_denied',
    );
  });

  it('refuses bad settings before any lookup', async () => {
    const never = () => Promise.reject(new Error('should not resolve'));
    await failsWith(
      resolveDestination(at('db.example.com', { port: 22 }), {
        policy: 'public-only',
        resolve: never,
      }),
      'invalid_config',
    );
    await failsWith(
      resolveDestination(at('db.example.com', { sslMode: 'disable' }), {
        policy: 'public-only',
        resolve: never,
      }),
      'invalid_config',
    );
  });

  it('reports a name that does not resolve as unreachable', async () => {
    await failsWith(
      resolveDestination(at('db.example.com'), {
        policy: 'public-only',
        resolve: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })),
      }),
      'unreachable',
    );
  });
});

// Uses the local application database as a stand-in source.
const url = URL.parse(process.env.DATABASE_URL ?? '');
const local =
  url === null
    ? undefined
    : {
        location: at(url.hostname, {
          port: Number(url.port || 5432),
          database: url.pathname.slice(1),
          sslMode: 'disable',
        }),
        login: {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
      };
const options = { policy: 'allow-private' as const, timeoutMs: 3000 };

async function skipReason(): Promise<string | false> {
  if (local === undefined) return 'DATABASE_URL is not set';
  try {
    await testPostgresConnection(local.location, local.login, options);
    return false;
  } catch {
    return 'local database is not running (pnpm services:up)';
  }
}

describe('PostgreSQL connections', { skip: await skipReason() }, () => {
  const l = local!;

  it('connects and reports the server version', async () => {
    const result = await testPostgresConnection(l.location, l.login, options);
    assert.match(result.serverVersion, /^\d+/);
    assert.ok(result.latencyMs >= 0);
  });

  it('classifies a wrong password, a missing database, and a closed port', async () => {
    await failsWith(
      testPostgresConnection(l.location, { ...l.login, password: 'wrong' }, options),
      'auth_failed',
    );
    await failsWith(
      testPostgresConnection({ ...l.location, database: 'no_such_db_x' }, l.login, options),
      'not_found',
    );
    await failsWith(
      testPostgresConnection({ ...l.location, port: 1 + 1024 }, l.login, options),
      'unreachable',
    );
  });

  it('stops a query that runs past the time limit, as a timeout', async () => {
    await failsWith(
      withPostgres(l.location, l.login, { ...options, timeoutMs: 500 }, (c) =>
        c.query('SELECT pg_sleep(3)'),
      ),
      'timeout',
    );
  });

  it('runs every session read-only', async () => {
    await failsWith(
      withPostgres(l.location, l.login, options, (c) =>
        c.query('CREATE TABLE ds_write_probe (x int)'),
      ),
      'permission_denied',
    );
    // Even an explicit write to an existing table is refused by the session.
    await failsWith(
      withPostgres(l.location, l.login, options, (c) =>
        c.query('UPDATE users SET display_name = display_name WHERE false'),
      ),
      'permission_denied',
    );
  });

  it('never puts driver text in the failure message', async () => {
    try {
      await testPostgresConnection(l.location, { ...l.login, password: 'wrong' }, options);
      assert.fail('expected a failure');
    } catch (error) {
      assert.ok(error instanceof ConnectorFailure);
      assert.doesNotMatch(JSON.stringify(error.toJSON()), /password authentication|for user/i);
    }
  });

  it('profiles a table: exact count, types, declared nullability, and null counts', async () => {
    const profile = await withPostgres(l.location, l.login, options, (c) =>
      profilePostgresTable(c, { schema: 'public', table: 'users' }),
    );
    assert.equal(profile.rowCountMethod, 'exact');
    assert.ok(profile.rowCount >= 0);
    const email = profile.columns.find((c) => c.name === 'email');
    assert.equal(email?.type, 'text');
    assert.equal(email?.nullable, false);
    assert.equal(email?.nullCount, 0);
  });

  it('reports a missing table as not_found, even with quotes in its name', async () => {
    await failsWith(
      withPostgres(l.location, l.login, options, (c) =>
        profilePostgresTable(c, { schema: 'public', table: 'no"such table' }),
      ),
      'not_found',
    );
  });

  it('discovers readable tables without system schemas', async () => {
    const found = await withPostgres(l.location, l.login, options, discoverTables);
    assert.ok(
      found.tables.some((t) => t.schema === 'public' && t.name === 'users' && t.kind === 'table'),
    );
    assert.equal(
      found.tables.some((t) => t.schema === 'pg_catalog' || t.schema === 'information_schema'),
      false,
    );
    assert.equal(found.truncated, false);
  });
});

describe('profile helpers', () => {
  it('quotes identifiers, doubling quotes', () => {
    assert.equal(quoteIdent('Orders "2026"'), '"Orders ""2026"""');
  });
  it('normalizes native types', () => {
    assert.equal(normalizePgType('bigint'), 'integer');
    assert.equal(normalizePgType('numeric(10,2)'), 'decimal');
    assert.equal(normalizePgType('timestamp with time zone'), 'timestamp');
    assert.equal(normalizePgType('character varying(80)'), 'text');
    assert.equal(normalizePgType('jsonb'), 'json');
    assert.equal(normalizePgType('inet'), 'inet');
  });
});
