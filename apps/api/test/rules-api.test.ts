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

const freshness = { version: 1, type: 'freshness', maxAgeMinutes: 60 };

describe('rules API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const queue = new RecordingSourceJobs();
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(role: 'engineer' | 'viewer' = 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'R', slug: `r-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'd', name: 'd' },
    });
    const cookie = await signInCookie(url, user.email);
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: { cookie, origin: WEB, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { workspaceId: w.id, dataset, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: queue })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('creates a rule with revision 1, refusing invalid definitions by field', async () => {
    const t = await tenant();
    const bad = await t.call('POST', `/datasets/${t.dataset.id}/rules`, {
      name: 'Fresh',
      severity: 'critical',
      definition: { ...freshness, maxAgeMinutes: 0 },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_rule');
    assert.match(String(bad.body.detail), /^maxAgeMinutes: /);

    const res = await t.call('POST', `/datasets/${t.dataset.id}/rules`, {
      name: 'Fresh',
      severity: 'critical',
      definition: freshness,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.version, 1);
    assert.equal(res.body.type, 'freshness');
    assert.deepEqual(res.body.definition, freshness);
    const listed = await t.call('GET', `/datasets/${t.dataset.id}/rules`);
    assert.equal((listed.body as unknown as unknown[]).length, 1);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'rule.created', targetId: String(res.body.id) },
    });
    assert.equal(audit.workspaceId, t.workspaceId);
  });

  it('writes a revision only when the definition or severity changes', async () => {
    const t = await tenant();
    const created = await t.call('POST', `/datasets/${t.dataset.id}/rules`, {
      name: 'Fresh',
      severity: 'warning',
      definition: freshness,
    });
    const id = String(created.body.id);
    const rename = await t.call('PATCH', `/rules/${id}`, { expectedVersion: 1, name: 'Renamed' });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.version, 1);

    const same = await t.call('PATCH', `/rules/${id}`, {
      expectedVersion: 1,
      definition: freshness,
    });
    assert.equal(same.body.version, 1);

    const severe = await t.call('PATCH', `/rules/${id}`, {
      expectedVersion: 1,
      severity: 'critical',
    });
    assert.equal(severe.body.version, 2);
    const longer = await t.call('PATCH', `/rules/${id}`, {
      expectedVersion: 2,
      definition: { ...freshness, maxAgeMinutes: 120 },
    });
    assert.equal(longer.body.version, 3);
    assert.deepEqual(
      (
        await prisma.ruleRevision.findMany({ where: { ruleId: id }, orderBy: { version: 'asc' } })
      ).map((r) => [
        r.version,
        r.severity,
        (r.definition as { maxAgeMinutes: number }).maxAgeMinutes,
      ]),
      [
        [1, 'warning', 60],
        [2, 'critical', 60],
        [3, 'critical', 120],
      ],
    );

    const stale = await t.call('PATCH', `/rules/${id}`, { expectedVersion: 2, enabled: false });
    assert.equal(stale.status, 409);
    const otherType = await t.call('PATCH', `/rules/${id}`, {
      expectedVersion: 3,
      definition: { version: 1, type: 'row_count', minRows: 1 },
    });
    assert.equal(otherType.status, 400);
  });

  it('queues a manual run once per idempotency key, and only for enabled rules', async () => {
    const t = await tenant();
    const created = await t.call('POST', `/datasets/${t.dataset.id}/rules`, {
      name: 'Fresh',
      severity: 'info',
      definition: freshness,
    });
    const id = String(created.body.id);
    const key = { 'idempotency-key': `try-${randomUUID()}` };
    const first = await t.call('POST', `/rules/${id}/runs`, undefined, key);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'queued');
    assert.equal(first.body.ruleVersion, 1);
    const again = await t.call('POST', `/rules/${id}/runs`, undefined, key);
    assert.equal(again.body.id, first.body.id);
    assert.equal(
      await prisma.checkRun.count({ where: { ruleId: id } }),
      1,
      'a repeated request must not create a second run',
    );
    assert.ok(queue.checks.some((c) => c.checkRunId === first.body.id));
    const detail = await t.call('GET', `/rules/${id}`);
    assert.equal((detail.body.recentRuns as unknown[]).length, 1);

    await t.call('PATCH', `/rules/${id}`, { expectedVersion: 1, enabled: false });
    assert.equal((await t.call('POST', `/rules/${id}/runs`)).status, 409);
  });

  it('keeps rules inside their workspace and edits to engineers', async () => {
    const owner = await tenant();
    const created = await owner.call('POST', `/datasets/${owner.dataset.id}/rules`, {
      name: 'Fresh',
      severity: 'info',
      definition: freshness,
    });
    const id = String(created.body.id);
    const stranger = await tenant();
    assert.equal((await stranger.call('GET', `/rules/${id}`)).status, 404);
    assert.equal(
      (await stranger.call('PATCH', `/rules/${id}`, { expectedVersion: 1, enabled: false })).status,
      404,
    );
    const viewer = await tenant('viewer');
    assert.equal((await viewer.call('GET', `/datasets/${viewer.dataset.id}/rules`)).status, 200);
    assert.equal(
      (
        await viewer.call('POST', `/datasets/${viewer.dataset.id}/rules`, {
          name: 'x',
          severity: 'info',
          definition: freshness,
        })
      ).status,
      403,
    );
  });
});
