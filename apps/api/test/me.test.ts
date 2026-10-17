import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashSessionToken } from '../src/auth/session-token.js';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi } from './helpers.js';

const skip = await databaseSkipReason();

describe('current user and workspace list', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function memberOf(role: 'owner' | 'viewer') {
    const user = await createUser();
    users.push(user.id);
    const workspace = await prisma.workspace.create({
      data: { name: 'Test workspace', slug: `test-${randomUUID()}` },
    });
    workspaces.push(workspace.id);
    await prisma.membership.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
    return { user, workspace };
  }

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('returns the signed-in user and their memberships', async () => {
    const { user, workspace } = await memberOf('viewer');
    const cookie = await signInCookie(url, user.email);
    const res = await fetch(`${url}/auth/me`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      user: { id: user.id, email: user.email, displayName: 'Test User' },
      memberships: [
        {
          workspaceId: workspace.id,
          workspaceName: 'Test workspace',
          slug: workspace.slug,
          role: 'viewer',
        },
      ],
    });
  });

  it("lists only the caller's workspaces, with their role", async () => {
    const { user, workspace } = await memberOf('owner');
    await memberOf('viewer'); // someone else's workspace
    const cookie = await signInCookie(url, user.email);
    const res = await fetch(`${url}/workspaces`, { headers: { cookie } });
    assert.deepEqual(await res.json(), [
      {
        id: workspace.id,
        name: 'Test workspace',
        slug: workspace.slug,
        timezone: 'UTC',
        role: 'owner',
      },
    ]);
  });

  it('refuses requests without a session', async () => {
    const res = await fetch(`${url}/auth/me`);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'not_signed_in');
  });

  it('refuses a signed-out session', async () => {
    const { user } = await memberOf('viewer');
    const cookie = await signInCookie(url, user.email);
    await fetch(`${url}/auth/sessions/current`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await fetch(`${url}/auth/me`, { headers: { cookie } })).status, 401);
  });

  it('refuses an expired session', async () => {
    const { user } = await memberOf('viewer');
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken('expired-token'),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await fetch(`${url}/auth/me`, { headers: { cookie: 'ds_session=expired-token' } });
    assert.equal(res.status, 401);
  });

  it('refuses the session of a disabled user', async () => {
    const { user } = await memberOf('viewer');
    const cookie = await signInCookie(url, user.email);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });
    assert.equal((await fetch(`${url}/auth/me`, { headers: { cookie } })).status, 401);
  });
});
