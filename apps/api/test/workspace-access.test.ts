import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hasRole } from '../src/workspaces/workspace.guard.js';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi } from './helpers.js';

describe('role ceiling', () => {
  it('ranks owner > admin > engineer > analyst > viewer', () => {
    assert.equal(hasRole('owner', 'admin'), true);
    assert.equal(hasRole('engineer', 'engineer'), true);
    assert.equal(hasRole('analyst', 'engineer'), false);
    assert.equal(hasRole('viewer', 'analyst'), false);
  });
});

const skip = await databaseSkipReason();

describe('workspace access', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function workspaceWith(role: 'owner' | 'viewer') {
    const user = await createUser();
    users.push(user.id);
    const workspace = await prisma.workspace.create({
      data: { name: 'Tenant', slug: `tenant-${randomUUID()}` },
    });
    workspaces.push(workspace.id);
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
    return { cookie: await signInCookie(url, user.email), workspace, user };
  }

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('shows a workspace to its members', async () => {
    const { cookie, workspace } = await workspaceWith('viewer');
    const res = await fetch(`${url}/workspaces/${workspace.id}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; role: string };
    assert.equal(body.id, workspace.id);
    assert.equal(body.role, 'viewer');
  });

  it('answers 404 for another tenant, never revealing that it exists', async () => {
    const mine = await workspaceWith('owner');
    const theirs = await workspaceWith('owner');
    const res = await fetch(`${url}/workspaces/${theirs.workspace.id}`, {
      headers: { cookie: mine.cookie },
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'workspace_not_found');
    const missing = await fetch(`${url}/workspaces/${randomUUID()}`, {
      headers: { cookie: mine.cookie },
    });
    assert.deepEqual(
      { status: missing.status, code: ((await missing.json()) as { code: string }).code },
      { status: 404, code: 'workspace_not_found' },
    );
  });

  it('answers 404 for a malformed workspace ID', async () => {
    const { cookie } = await workspaceWith('viewer');
    assert.equal(
      (await fetch(`${url}/workspaces/not-a-uuid`, { headers: { cookie } })).status,
      404,
    );
  });

  it('denies a removed member', async () => {
    const { cookie, workspace, user } = await workspaceWith('viewer');
    await prisma.membership.update({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      data: { status: 'removed' },
    });
    assert.equal(
      (await fetch(`${url}/workspaces/${workspace.id}`, { headers: { cookie } })).status,
      404,
    );
  });
});
