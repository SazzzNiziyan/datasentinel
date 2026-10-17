import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

const skip = await databaseSkipReason();

describe('member roles and removal', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  /** A workspace with one member per given role; returns cookies and IDs. */
  async function team(...roles: Role[]) {
    const workspace = await prisma.workspace.create({
      data: { name: 'Team', slug: `team-${randomUUID()}` },
    });
    workspaces.push(workspace.id);
    const members = [];
    for (const role of roles) {
      const user = await createUser();
      users.push(user.id);
      const membership = await prisma.membership.create({
        data: { workspaceId: workspace.id, userId: user.id, role },
      });
      members.push({ membershipId: membership.id, cookie: await signInCookie(url, user.email) });
    }
    return { workspaceId: workspace.id, members };
  }

  const patch = (cookie: string, workspaceId: string, membershipId: string, body: unknown) =>
    fetch(`${url}/workspaces/${workspaceId}/members/${membershipId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: WEB, cookie },
      body: JSON.stringify(body),
    });

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lets an admin list members; a viewer may not', async () => {
    const { workspaceId, members } = await team('admin', 'viewer');
    const [admin, viewer] = members;
    const list = await fetch(`${url}/workspaces/${workspaceId}/members`, {
      headers: { cookie: admin!.cookie },
    });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as unknown[]).length, 2);
    const denied = await fetch(`${url}/workspaces/${workspaceId}/members`, {
      headers: { cookie: viewer!.cookie },
    });
    assert.equal(denied.status, 403);
  });

  it('lets an admin change a role, and the change applies at once', async () => {
    const { workspaceId, members } = await team('owner', 'admin', 'engineer');
    const [, admin, engineer] = members;
    const res = await patch(admin!.cookie, workspaceId, engineer!.membershipId, { role: 'viewer' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { role: string }).role, 'viewer');
    // The same session sees the new role on its next request.
    const detail = await fetch(`${url}/workspaces/${workspaceId}`, {
      headers: { cookie: engineer!.cookie },
    });
    assert.equal(((await detail.json()) as { role: string }).role, 'viewer');
  });

  it('removes a member, who loses access on their next request', async () => {
    const { workspaceId, members } = await team('owner', 'viewer');
    const [owner, viewer] = members;
    const res = await patch(owner!.cookie, workspaceId, viewer!.membershipId, {
      status: 'removed',
    });
    assert.equal(res.status, 200);
    const after = await fetch(`${url}/workspaces/${workspaceId}`, {
      headers: { cookie: viewer!.cookie },
    });
    assert.equal(after.status, 404);
  });

  it('stops an admin from granting a role above their own or touching an owner', async () => {
    const { workspaceId, members } = await team('owner', 'admin', 'viewer');
    const [owner, admin, viewer] = members;
    const promote = await patch(admin!.cookie, workspaceId, viewer!.membershipId, {
      role: 'owner',
    });
    assert.equal(promote.status, 403);
    const demoteOwner = await patch(admin!.cookie, workspaceId, owner!.membershipId, {
      role: 'viewer',
    });
    assert.equal(demoteOwner.status, 403);
  });

  it('keeps at least one owner', async () => {
    const { workspaceId, members } = await team('owner');
    const [owner] = members;
    const res = await patch(owner!.cookie, workspaceId, owner!.membershipId, { role: 'admin' });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'last_owner');
  });

  it('answers 404 for a membership in another workspace', async () => {
    const mine = await team('owner');
    const theirs = await team('viewer');
    const res = await patch(
      mine.members[0]!.cookie,
      mine.workspaceId,
      theirs.members[0]!.membershipId,
      {
        role: 'analyst',
      },
    );
    assert.equal(res.status, 404);
  });
});
