import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createUser,
  databaseSkipReason,
  PASSWORD,
  prisma,
  signInCookie,
  startApi,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();

describe('audit events', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: WEB, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const eventsFor = (where: { actorId?: string; workspaceId?: string }) =>
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'asc' } });

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.auditEvent.deleteMany({
      where: { OR: [{ actorId: { in: users } }, { workspaceId: { in: workspaces } }] },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('records failed and successful sign-ins and sign-out, without the password', async () => {
    const user = await createUser();
    users.push(user.id);
    await send('POST', '/auth/sessions', '', { email: user.email, password: 'wrong' });
    const cookie = await signInCookie(url, user.email);
    await send('DELETE', '/auth/sessions/current', cookie);

    const events = await eventsFor({ actorId: user.id });
    assert.deepEqual(
      events.map((e) => e.action),
      ['auth.sign_in.failed', 'auth.sign_in.succeeded', 'auth.sign_out'],
    );
    assert.ok(events.every((e) => e.requestId !== null));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(PASSWORD));
  });

  it('records workspace creation, settings changes, and role changes', async () => {
    const owner = await createUser();
    const other = await createUser();
    users.push(owner.id, other.id);
    const cookie = await signInCookie(url, owner.email);
    const created = (await (
      await send('POST', '/workspaces', cookie, { name: 'Audited' })
    ).json()) as {
      id: string;
    };
    workspaces.push(created.id);
    const membership = await prisma.membership.create({
      data: { workspaceId: created.id, userId: other.id, role: 'viewer' },
    });

    const patch = await send('PATCH', `/workspaces/${created.id}`, cookie, {
      name: 'Audited Renamed',
    });
    assert.equal(patch.status, 200);
    await send('PATCH', `/workspaces/${created.id}/members/${membership.id}`, cookie, {
      role: 'analyst',
    });

    const events = await eventsFor({ workspaceId: created.id });
    assert.deepEqual(
      events.map((e) => e.action),
      ['workspace.created', 'workspace.updated', 'member.role_changed'],
    );
    assert.deepEqual(events[1]?.summary, {
      before: { name: 'Audited' },
      after: { name: 'Audited Renamed' },
    });
    assert.deepEqual(events[2]?.summary, {
      before: { role: 'viewer' },
      after: { role: 'analyst' },
    });
  });

  it('refuses to change an audit row', async () => {
    const row = await prisma.auditEvent.create({
      data: { actorType: 'system', action: 'test.event', targetId: randomUUID() },
    });
    await assert.rejects(
      prisma.auditEvent.update({ where: { id: row.id }, data: { action: 'tampered' } }),
    );
    await prisma.auditEvent.delete({ where: { id: row.id } });
  });
});
