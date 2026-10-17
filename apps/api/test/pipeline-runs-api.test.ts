import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createUser,
  databaseSkipReason,
  prisma,
  RecordingSourceJobs,
  signInCookie,
  startApi,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

describe('pipeline runs API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(role: 'admin' | 'engineer' = 'admin', type = 'pipeline_event' as const) {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'P', slug: `p-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'airflow', type },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const cookie = await signInCookie(url, user.email);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: { cookie, origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
      };
    };
    const tokens = `/sources/${source.id}/integration-tokens`;
    return { workspaceId: w.id, source, dataset, call, tokens };
  }

  /** Calls an integration route with a bearer token and no cookie. */
  async function job(token: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}/integrations/pipeline-runs${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function issued() {
    const t = await tenant();
    const res = await t.call('POST', t.tokens, { name: 'airflow prod' });
    assert.equal(res.status, 201);
    return { ...t, token: String(res.body.token), tokenId: String(res.body.id) };
  }

  const event = (over: Record<string, unknown> = {}) => ({
    externalRunId: 'orders_daily/2026-10-17',
    name: 'orders_daily',
    status: 'running',
    occurredAt: iso(),
    ...over,
  });

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('issues a token once, stores only its hash, and lists it without the secret', async () => {
    const t = await issued();
    assert.match(t.token, /^dsp_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    const row = await prisma.integrationToken.findUniqueOrThrow({ where: { id: t.tokenId } });
    assert.equal(Buffer.from(row.secretHash).length, 32);
    assert.ok(!JSON.stringify(row).includes(t.token.slice(-43)));
    const listed = await t.call('GET', t.tokens);
    assert.equal(JSON.stringify(listed.body).includes(t.token), false);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'integration_token.created', targetId: t.tokenId },
    });
  });

  it('issues tokens only to admins and only for pipeline-event sources', async () => {
    const engineer = await tenant('engineer');
    assert.equal((await engineer.call('POST', engineer.tokens, { name: 'x' })).status, 403);
    const csv = await tenant('admin', 'csv' as 'pipeline_event');
    const refused = await csv.call('POST', csv.tokens, { name: 'x' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'not_a_pipeline_source');
  });

  it('records a run once per external ID and moves it forward only', async () => {
    const t = await issued();
    const first = await job(t.token, 'POST', '', event({ datasetId: t.dataset.id }));
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'running');
    assert.ok(first.body.startedAt);
    const repeat = await job(t.token, 'POST', '', event());
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.id, first.body.id);

    const done = await job(
      t.token,
      'POST',
      '',
      event({ status: 'succeeded', occurredAt: iso(1000) }),
    );
    assert.equal(done.body.status, 'succeeded');
    assert.ok(done.body.endedAt);
    // A late or backward event changes nothing.
    const late = await job(t.token, 'PATCH', `/${String(first.body.id)}`, {
      status: 'failed',
      occurredAt: iso(2000),
    });
    assert.equal(late.status, 200);
    assert.equal(late.body.status, 'succeeded');
    assert.equal(await prisma.pipelineRun.count({ where: { sourceId: t.source.id } }), 1);
  });

  it('updates by run ID, redacting summaries', async () => {
    const t = await issued();
    const run = await job(t.token, 'POST', '', event({ status: 'queued', externalRunId: 'r2' }));
    const failed = await job(t.token, 'PATCH', `/${String(run.body.id)}`, {
      status: 'failed',
      occurredAt: iso(1000),
      summary: 'load failed: postgres://loader:hunter2@db/app password=hunter2',
    });
    assert.equal(failed.body.status, 'failed');
    assert.doesNotMatch(String(failed.body.summary), /hunter2/);
  });

  it('refuses bad tokens, revoked tokens, other sources, replays, and floods', async () => {
    const t = await issued();
    const other = await issued();
    assert.equal((await job('dsp_nope', 'POST', '', event())).status, 401);
    const forged = `${t.token.slice(0, -1)}${t.token.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await job(forged, 'POST', '', event())).status, 401);

    const old = await job(t.token, 'POST', '', event({ occurredAt: iso(-8 * 86_400_000) }));
    assert.equal(old.status, 400);
    assert.equal(old.body.code, 'invalid_event');
    const foreignDataset = await job(t.token, 'POST', '', event({ datasetId: other.dataset.id }));
    assert.equal(foreignDataset.status, 404);

    const mine = await job(t.token, 'POST', '', event({ externalRunId: 'r3' }));
    const crossed = await job(other.token, 'PATCH', `/${String(mine.body.id)}`, {
      status: 'failed',
      occurredAt: iso(),
    });
    assert.equal(crossed.status, 404);

    assert.equal((await t.call('DELETE', `${t.tokens}/${t.tokenId}`)).status, 204);
    assert.equal((await job(t.token, 'POST', '', event())).status, 401);

    let last = 0;
    for (let i = 0; i < 61 && last !== 429; i += 1) {
      last = (await job(other.token, 'POST', '', event({ externalRunId: `flood-${i}` }))).status;
    }
    assert.equal(last, 429);
  });
});
