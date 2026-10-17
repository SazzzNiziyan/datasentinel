import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

const skip = await databaseSkipReason();

describe('pause, resume, and archive', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  /** A member of `role` in a fresh workspace with one source and dataset. */
  async function tenant(role: Role) {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'L', slug: `l-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'files', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'd', name: 'D' },
    });
    const cookie = await signInCookie(url, user.email);
    const call = async (method: string, path: string) => {
      const res = await fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: { cookie, origin: WEB },
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text === '' ? null : JSON.parse(text)) as Record<string, unknown>,
      };
    };
    const actions = () =>
      prisma.auditEvent
        .findMany({
          where: { workspaceId: w.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { action: true },
        })
        .then((rows) => rows.map((r) => r.action).filter((a) => !a.startsWith('auth.')));
    return { workspaceId: w.id, source, dataset, call, actions };
  }

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('pauses and resumes a source, harmlessly when repeated, and audits changes only', async () => {
    const t = await tenant('engineer');
    const paused = await t.call('POST', `/sources/${t.source.id}/pause`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
    assert.equal((await t.call('POST', `/sources/${t.source.id}/pause`)).body.status, 'paused');
    const resumed = await t.call('POST', `/sources/${t.source.id}/resume`);
    assert.equal(resumed.body.status, 'active');
    assert.deepEqual(await t.actions(), ['source.paused', 'source.resumed']);
  });

  it('pauses and resumes a dataset', async () => {
    const t = await tenant('engineer');
    assert.equal((await t.call('POST', `/datasets/${t.dataset.id}/pause`)).body.status, 'paused');
    assert.equal((await t.call('POST', `/datasets/${t.dataset.id}/resume`)).body.status, 'active');
    assert.deepEqual(await t.actions(), ['dataset.paused', 'dataset.resumed']);
  });

  it('lets only administrators and owners archive', async () => {
    const t = await tenant('engineer');
    assert.equal((await t.call('DELETE', `/sources/${t.source.id}`)).status, 403);
    assert.equal((await t.call('DELETE', `/datasets/${t.dataset.id}`)).status, 403);
    const analyst = await tenant('analyst');
    assert.equal((await analyst.call('POST', `/sources/${analyst.source.id}/pause`)).status, 403);
  });

  it('archives a source with its datasets, keeps them readable, and refuses to resume', async () => {
    const t = await tenant('admin');
    const archived = await t.call('DELETE', `/sources/${t.source.id}`);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, 'archived');
    assert.equal(typeof archived.body.archivedAt, 'string');

    const dataset = await t.call('GET', `/datasets/${t.dataset.id}`);
    assert.equal(dataset.status, 200);
    assert.equal(dataset.body.status, 'archived');
    assert.equal(typeof dataset.body.archivedAt, 'string');
    assert.equal(((await t.call('GET', '/datasets')).body as unknown as unknown[]).length, 0);

    const resume = await t.call('POST', `/sources/${t.source.id}/resume`);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.code, 'source_archived');
    assert.equal((await t.call('POST', `/datasets/${t.dataset.id}/resume`)).status, 409);
    // Archiving again changes nothing and is not audited twice.
    assert.equal((await t.call('DELETE', `/sources/${t.source.id}`)).status, 200);
    assert.deepEqual(await t.actions(), ['source.archived']);
  });

  it('archives a single dataset', async () => {
    const t = await tenant('owner');
    const archived = await t.call('DELETE', `/datasets/${t.dataset.id}`);
    assert.equal(archived.body.status, 'archived');
    assert.equal((await t.call('GET', `/sources/${t.source.id}`)).body.status, 'active');
    assert.equal((await t.call('POST', `/datasets/${t.dataset.id}/pause`)).status, 409);
  });

  it('does not resume a dataset whose source is paused', async () => {
    const t = await tenant('engineer');
    await t.call('POST', `/datasets/${t.dataset.id}/pause`);
    await t.call('POST', `/sources/${t.source.id}/pause`);
    const res = await t.call('POST', `/datasets/${t.dataset.id}/resume`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'source_not_active');
  });

  it('hides other workspaces’ sources and datasets', async () => {
    const a = await tenant('owner');
    const b = await tenant('owner');
    assert.equal((await a.call('POST', `/sources/${b.source.id}/pause`)).status, 404);
    assert.equal((await a.call('DELETE', `/datasets/${b.dataset.id}`)).status, 404);
    assert.equal((await a.call('POST', '/sources/not-a-uuid/pause')).status, 404);
  });
});
