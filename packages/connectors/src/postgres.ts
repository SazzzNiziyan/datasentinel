/**
 * PostgreSQL connections (Phase G). Every connection resolves the host,
 * checks each address against the destination policy (D-48), and connects
 * to a checked address, so DNS cannot redirect it afterwards. TLS still
 * verifies the original host name. Every failure becomes a fixed
 * ConnectorFailure; driver text stays in `cause` for server logs only.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import pg from 'pg';
import { ConnectorFailure, type FailureCode } from './failure.ts';
import { checkAddress, checkHostSyntax, checkPort, type NetworkPolicy } from './network.ts';

export interface PostgresLocation {
  host: string;
  port: number;
  database: string;
  sslMode: 'verify-full' | 'require' | 'disable';
}

export interface PostgresLogin {
  username: string;
  password: string;
}

export interface PostgresCallOptions {
  policy: NetworkPolicy;
  signal?: AbortSignal;
  /** Connect plus query; defaults to 10 s for tests, 30 s for checks (D-08). */
  timeoutMs?: number;
  /** Replaces DNS in tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, order: 'ipv4first' })).map((a) => a.address);

/** The addresses to try, in order. Every resolved address must pass the
 * policy, so one bad record refuses the host. */
export async function resolveDestination(
  location: PostgresLocation,
  { policy, resolve = defaultResolve }: Pick<PostgresCallOptions, 'policy' | 'resolve'>,
): Promise<string[]> {
  if (checkHostSyntax(location.host) !== undefined || checkPort(location.port) !== undefined) {
    throw new ConnectorFailure('invalid_config');
  }
  if (location.sslMode === 'disable' && policy === 'public-only') {
    throw new ConnectorFailure('invalid_config');
  }
  let addresses: string[];
  try {
    addresses = isIP(location.host) !== 0 ? [location.host] : await resolve(location.host);
  } catch (cause) {
    throw new ConnectorFailure('unreachable', { cause });
  }
  if (addresses.length === 0 || addresses.some((a) => checkAddress(a, policy) !== undefined)) {
    throw new ConnectorFailure('permission_denied');
  }
  return addresses;
}

/** SQLSTATE and Node error codes to safe failure codes. */
function classify(error: unknown, timedOut: boolean): FailureCode {
  if (timedOut) return 'timeout';
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case '28P01':
    case '28000':
      return 'auth_failed';
    case '3D000':
      return 'not_found';
    // 25006 read_only_sql_transaction: something tried to write.
    case '42501':
    case '25006':
      return 'permission_denied';
    case '57014':
      return 'timeout';
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'unreachable';
    case 'ETIMEDOUT':
      return 'timeout';
    default: {
      const message = error instanceof Error ? error.message : '';
      // TLS and certificate problems are settings the user must fix.
      if (/certificate|self.signed|SSL|TLS/i.test(message)) return 'invalid_config';
      if (/timeout/i.test(message)) return 'timeout';
      return 'internal';
    }
  }
}

/** Runs `work` on one short-lived, read-only session, then closes it. */
export async function withPostgres<T>(
  location: PostgresLocation,
  login: PostgresLogin,
  options: PostgresCallOptions,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const addresses = await resolveDestination(location, options);
  const connect = (address: string) => {
    const client = new pg.Client({
      host: address,
      port: location.port,
      database: location.database,
      user: login.username,
      password: login.password,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      application_name: 'datasentinel',
      // Every statement in this session is read-only unless it says otherwise.
      options: '-c default_transaction_read_only=on',
      // "require" encrypts without verifying, as libpq's sslmode=require does;
      // the form recommends verify-full.
      ssl:
        location.sslMode === 'disable'
          ? false
          : location.sslMode === 'require'
            ? { rejectUnauthorized: false }
            : {
                rejectUnauthorized: true,
                servername: isIP(location.host) ? undefined : location.host,
              },
    });
    // Errors after connect (e.g. the server closing) must not crash the process.
    client.on('error', () => {});
    return client;
  };

  let client: pg.Client | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void client?.end().catch(() => {});
  }, timeoutMs + 1000);
  const abort = () => void client?.end().catch(() => {});
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const [i, address] of addresses.entries()) {
      client = connect(address);
      try {
        await client.connect();
        break;
      } catch (error) {
        // Like libpq: a refused or unroutable address moves on to the next.
        const code = (error as { code?: unknown }).code;
        const next = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(String(code));
        await client.end().catch(() => {});
        if (!next || i === addresses.length - 1) throw error;
      }
    }
    if (client === undefined) throw new ConnectorFailure('unreachable');
    return await work(client);
  } catch (cause) {
    if (cause instanceof ConnectorFailure) throw cause;
    throw new ConnectorFailure(classify(cause, timedOut || options.signal?.aborted === true), {
      cause,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await client?.end().catch(() => {});
  }
}

export interface ConnectionTestResult {
  /** e.g. "16.4"; the full version string can name the build host. */
  serverVersion: string;
  latencyMs: number;
}

/** Connects, runs `SHOW server_version`, and reports how long it took. */
export async function testPostgresConnection(
  location: PostgresLocation,
  login: PostgresLogin,
  options: PostgresCallOptions,
): Promise<ConnectionTestResult> {
  const started = performance.now();
  return withPostgres(location, login, options, async (client) => {
    const result = await client.query<{ server_version: string }>('SHOW server_version');
    const version = /^\d+(\.\d+)?/.exec(result.rows[0]?.server_version ?? '')?.[0] ?? 'unknown';
    return { serverVersion: version, latencyMs: Math.round(performance.now() - started) };
  });
}

export interface DiscoveredTable {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table';
  /** Planner estimate; null when the table was never analyzed. */
  estimatedRows: number | null;
}

export interface TableDiscovery {
  tables: DiscoveredTable[];
  /** More readable tables exist than were listed. */
  truncated: boolean;
}

export const DISCOVERY_LIMIT = 1000;

const kinds: Record<string, DiscoveredTable['kind']> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'materialized_view',
  f: 'foreign_table',
};

/** Tables and views the login can read (D-50). One fixed catalog query with
 * no user input in it; system schemas are skipped; at most 1,000 rows. */
export async function discoverTables(client: pg.Client): Promise<TableDiscovery> {
  const result = await client.query<{
    schema: string;
    name: string;
    kind: string;
    estimate: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
            c.reltuples::bigint::text AS estimate
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT c.relispartition
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      ORDER BY 1, 2
      LIMIT $1`,
    [DISCOVERY_LIMIT + 1],
  );
  const tables = result.rows.slice(0, DISCOVERY_LIMIT).map((row) => {
    const estimate = Number(row.estimate);
    return {
      schema: row.schema,
      name: row.name,
      kind: kinds[row.kind] ?? 'table',
      estimatedRows: Number.isFinite(estimate) && estimate >= 0 ? estimate : null,
    };
  });
  return { tables, truncated: result.rows.length > DISCOVERY_LIMIT };
}

/** A PostgreSQL identifier, quoted: "Orders ""2026""". */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Native types to the normalized names CSV profiles use (D-43, D-52). */
export function normalizePgType(native: string): string {
  const t = native.toLowerCase();
  if (/^(smallint|integer|bigint)$/.test(t)) return 'integer';
  if (/^(numeric|decimal|real|double precision)/.test(t)) return 'decimal';
  if (t === 'boolean') return 'boolean';
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp')) return 'timestamp';
  if (/^(text|character|character varying|citext|name|uuid)/.test(t)) return 'text';
  if (/^jsonb?$/.test(t)) return 'json';
  return t;
}

export interface PostgresColumnProfile {
  name: string;
  /** Normalized, e.g. "integer"; `nativeType` keeps PostgreSQL's name. */
  type: string;
  nativeType: string;
  /** Declared nullable (no NOT NULL constraint). */
  nullable: boolean;
  /** Null when the row count was estimated. */
  nullCount: number | null;
}

export interface PostgresProfile {
  rowCount: number;
  rowCountMethod: 'exact' | 'approximate';
  columns: PostgresColumnProfile[];
}

/** Above this planner estimate, counts are not run (D-52). */
export const EXACT_COUNT_LIMIT = 1_000_000;

/** Profiles one table or view (D-52): columns from the catalog, then either
 * one exact count with per-column null counts, or the planner's estimate
 * for big tables. Names travel as parameters or quoted identifiers, never
 * as SQL; a relation that is gone (or unreadable) is not_found. */
export async function profilePostgresTable(
  client: pg.Client,
  { schema, table }: { schema: string; table: string },
): Promise<PostgresProfile> {
  const relation = await client.query<{ oid: string | null; estimate: string | null }>(
    `SELECT c.oid::text AS oid, c.reltuples::bigint::text AS estimate
       FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', $1::text, $2::text))
        AND pg_catalog.has_table_privilege(c.oid, 'SELECT')`,
    [schema, table],
  );
  const found = relation.rows[0];
  if (found?.oid == null) throw new ConnectorFailure('not_found');
  const columns = await client.query<{ name: string; native: string; nullable: boolean }>(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS native,
            NOT a.attnotnull AS nullable
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [found.oid],
  );
  const estimate = Number(found.estimate);
  const known = Number.isFinite(estimate) && estimate >= 0;
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  if (known && estimate > EXACT_COUNT_LIMIT) {
    return {
      rowCount: estimate,
      rowCountMethod: 'approximate',
      columns: columns.rows.map((c) => ({
        name: c.name,
        type: normalizePgType(c.native),
        nativeType: c.native,
        nullable: c.nullable,
        nullCount: null,
      })),
    };
  }
  // count(col) skips nulls, so total minus it is the null count.
  const counts = columns.rows.map((c, i) => `count(${quoteIdent(c.name)}) AS c${i}`);
  const row = (
    await client.query<Record<string, string>>(
      `SELECT count(*) AS total${counts.length > 0 ? `, ${counts.join(', ')}` : ''} FROM ${target}`,
    )
  ).rows[0];
  const total = Number(row?.total ?? 0);
  return {
    rowCount: total,
    rowCountMethod: 'exact',
    columns: columns.rows.map((c, i) => ({
      name: c.name,
      type: normalizePgType(c.native),
      nativeType: c.native,
      nullable: c.nullable,
      nullCount: total - Number(row?.[`c${i}`] ?? 0),
    })),
  };
}
