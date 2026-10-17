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

type Comment = { id: string; authorName: string | null; text: string; code?: string };
type Detail = { comments: Comment[] };

describe('incident comments', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'viewer' | 'analyst') {
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId, userId: user.id, role } });
    let cached: string | undefined;
    return { user, cookie: async () => (cached ??= await signInCookie(url, user.email)) };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'C', slug: `c-${randomUUID()}` } });
    workspaces.push(w.id);
    const analyst = await member(w.id, 'analyst');
    const viewer = await member(w.id, 'viewer');
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'r',
        type: 'freshness',
        severity: 'critical',
        currentVersion: 1,
      },
    });
    const incident = await prisma.incident.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        ruleId: rule.id,
        dedupeKey: `rule:${rule.id}`,
        title: 'Orders are fresh failed on orders',
        severity: 'critical',
        lastFailureAt: new Date(),
      },
    });
    const call = async (
      who: { cookie: () => Promise<string> },
      method: string,
      path: string,
      body?: unknown,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/incidents/${path}`, {
        method,
        headers: {
          cookie: await who.cookie(),
          origin: WEB,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Comment & Detail };
    };
    return { workspaceId: w.id, analyst, viewer, incident, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lets an analyst comment, shows comments oldest first on the incident, and audits it', async () => {
    const t = await tenant();
    const first = await t.call(t.analyst, 'POST', `${t.incident.id}/comments`, {
      text: '  Checking the nightly export.  ',
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.text, 'Checking the nightly export.');
    assert.equal(first.body.authorName, t.analyst.user.displayName);
    await t.call(t.analyst, 'POST', `${t.incident.id}/comments`, {
      text: '<b>Fixed</b> upstream.',
    });
    const detail = await t.call(t.viewer, 'GET', t.incident.id);
    assert.deepEqual(
      detail.body.comments.map((c) => c.text),
      ['Checking the nightly export.', '<b>Fixed</b> upstream.'],
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'incident.commented', targetId: t.incident.id },
    });
  });

  it('refuses viewers, empty or long text, extra fields, and foreign incidents', async () => {
    const t = await tenant();
    const other = await tenant();
    const path = `${t.incident.id}/comments`;
    assert.equal((await t.call(t.viewer, 'POST', path, { text: 'hi' })).status, 403);
    for (const bad of [{ text: '   ' }, { text: 'x'.repeat(2001) }, { text: 'ok', extra: 1 }, {}]) {
      assert.equal(
        (await t.call(t.analyst, 'POST', path, bad)).status,
        400,
        JSON.stringify(bad).slice(0, 40),
      );
    }
    assert.equal(
      (await t.call(t.analyst, 'POST', `${randomUUID()}/comments`, { text: 'x' })).status,
      404,
    );
    assert.equal(
      (await other.call(other.analyst, 'POST', path, { text: 'x' }, other.workspaceId)).status,
      404,
    );
    assert.equal(await prisma.incidentComment.count({ where: { incidentId: t.incident.id } }), 0);
  });

  it('keeps comments as written: no edits at the database', async () => {
    const t = await tenant();
    const made = await t.call(t.analyst, 'POST', `${t.incident.id}/comments`, { text: 'original' });
    await assert.rejects(
      prisma.incidentComment.update({ where: { id: made.body.id }, data: { text: 'changed' } }),
      /append-only/,
    );
    assert.equal(
      (await prisma.incidentComment.findUniqueOrThrow({ where: { id: made.body.id } })).text,
      'original',
    );
  });
});
