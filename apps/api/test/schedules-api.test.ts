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

const hourly = { version: 1, kind: 'interval', everyMinutes: 60 };
const mornings = { version: 1, kind: 'calendar', times: ['06:00'], timezone: 'Europe/Berlin' };

describe('schedules API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(role: 'engineer' | 'viewer' = 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'S', slug: `s-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'd', name: 'd' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'r',
        type: 'freshness',
        severity: 'warning',
        currentVersion: 1,
      },
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
    return { workspaceId: w.id, dataset, rule, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('creates a dataset schedule due one interval from now, refusing bad ones by field', async () => {
    const t = await tenant();
    const bad = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      definition: { ...hourly, everyMinutes: 5 },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_schedule');
    assert.match(String(bad.body.detail), /^everyMinutes: /);

    const before = Date.now();
    const res = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, { definition: hourly });
    assert.equal(res.status, 201);
    assert.equal(res.body.target, 'dataset');
    assert.equal(res.body.ruleId, null);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.definition, hourly);
    const next = Date.parse(String(res.body.nextRunAt)) - before;
    assert.ok(next > 59 * 60_000 && next <= 61 * 60_000, String(next));
    assert.deepEqual(res.body.recentOccurrences, []);
    const listed = await t.call('GET', `/datasets/${t.dataset.id}/schedules`);
    assert.equal((listed.body as unknown as unknown[]).length, 1);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'schedule.created', targetId: String(res.body.id) },
    });
  });

  it('targets one rule of the same dataset only', async () => {
    const t = await tenant();
    const other = await tenant();
    const res = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      ruleId: t.rule.id,
      definition: mornings,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.target, 'rule');
    assert.equal(res.body.ruleId, t.rule.id);
    const foreign = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      ruleId: other.rule.id,
      definition: mornings,
    });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 'rule_not_found');
  });

  it('pauses, resumes without catching up, and restarts on a new definition', async () => {
    const t = await tenant();
    const created = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      definition: hourly,
    });
    const id = String(created.body.id);
    const paused = await t.call('PATCH', `/schedules/${id}`, { enabled: false });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.enabled, false);
    assert.equal(paused.body.nextRunAt, null);

    // Pretend it was paused for days: resuming must not schedule the past.
    await prisma.schedule.update({
      where: { id },
      data: { anchorAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const resumed = await t.call('PATCH', `/schedules/${id}`, { enabled: true });
    assert.equal(resumed.body.enabled, true);
    assert.ok(Date.parse(String(resumed.body.nextRunAt)) > Date.now());

    const changed = await t.call('PATCH', `/schedules/${id}`, { definition: mornings });
    assert.deepEqual(changed.body.definition, mornings);
    assert.match(String(changed.body.nextRunAt), /T0[45]:00:00\.000Z$/);

    const bad = await t.call('PATCH', `/schedules/${id}`, {});
    assert.equal(bad.status, 400);
    const crowded = await t.call('PATCH', `/schedules/${id}`, {
      definition: { ...mornings, times: ['06:00', '06:05'] },
    });
    assert.equal(crowded.status, 400);
    assert.equal(crowded.body.code, 'invalid_schedule');
  });

  it('deletes a schedule; other workspaces and viewers cannot touch it', async () => {
    const t = await tenant();
    const outsider = await tenant();
    const created = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      definition: hourly,
    });
    const id = String(created.body.id);
    assert.equal(
      (await outsider.call('PATCH', `/schedules/${id}`, { enabled: false })).status,
      404,
    );
    assert.equal((await outsider.call('DELETE', `/schedules/${id}`)).status, 404);

    const viewer = await tenant('viewer');
    const denied = await viewer.call('POST', `/datasets/${viewer.dataset.id}/schedules`, {
      definition: hourly,
    });
    assert.equal(denied.status, 403);

    assert.equal((await t.call('DELETE', `/schedules/${id}`)).status, 204);
    assert.equal((await t.call('DELETE', `/schedules/${id}`)).status, 404);
    assert.equal(await prisma.schedule.count({ where: { id } }), 0);
  });

  it('caps schedules per dataset', async () => {
    const t = await tenant();
    for (let i = 0; i < 10; i += 1) {
      const res = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
        definition: hourly,
        enabled: false,
      });
      assert.equal(res.status, 201);
    }
    const over = await t.call('POST', `/datasets/${t.dataset.id}/schedules`, {
      definition: hourly,
    });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'schedule_limit');
  });
});
