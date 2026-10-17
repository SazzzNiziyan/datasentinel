import type { Role } from '@datasentinel/contracts';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashSessionToken } from '../src/auth/session-token.js';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

const skip = await databaseSkipReason();

describe('invitations', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function memberWith(role: Role) {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({
      data: { name: 'Team', slug: `inv-${randomUUID()}` },
    });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    return { workspaceId: w.id, cookie: await signInCookie(url, user.email), user };
  }

  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB, cookie },
      body: JSON.stringify(body),
    });

  const invite = async (
    admin: { workspaceId: string; cookie: string },
    email: string,
    role: Role,
  ) => post(`/workspaces/${admin.workspaceId}/invitations`, { email, role }, admin.cookie);

  const tokenOf = (acceptUrl: string) => /#token=(.+)$/.exec(acceptUrl)?.[1] ?? '';
  const newEmail = () => `invitee-${randomUUID()}@test.example`;

  before(async () => ({ app, url } = await startApi()));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await prisma.user.deleteMany({
      where: {
        OR: [
          { id: { in: users } },
          { email: { endsWith: '@test.example', startsWith: 'invitee-' } },
        ],
      },
    });
    await app.close();
  });

  it('gives the admin a one-time link; only its hash is stored', async () => {
    const admin = await memberWith('admin');
    const res = await invite(admin, newEmail(), 'analyst');
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; acceptUrl: string };
    assert.match(body.acceptUrl, new RegExp(`^${WEB}/invite#token=`));
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: body.id } });
    assert.equal(row.tokenHash, hashSessionToken(tokenOf(body.acceptUrl)));
    const pending = await fetch(`${url}/workspaces/${admin.workspaceId}/invitations`, {
      headers: { cookie: admin.cookie },
    });
    const text = await pending.text();
    assert.match(text, /analyst/);
    assert.doesNotMatch(text, new RegExp(tokenOf(body.acceptUrl)));
  });

  it('enforces who may invite whom', async () => {
    const viewer = await memberWith('viewer');
    assert.equal((await invite(viewer, newEmail(), 'viewer')).status, 403);
    const admin = await memberWith('admin');
    assert.equal((await invite(admin, newEmail(), 'owner')).status, 403);
    assert.equal((await invite(admin, admin.user.email, 'viewer')).status, 409);
  });

  it('lets a new person create an account and join in one step', async () => {
    const admin = await memberWith('owner');
    const email = newEmail();
    const { acceptUrl } = (await (await invite(admin, email, 'engineer')).json()) as {
      acceptUrl: string;
    };
    const token = tokenOf(acceptUrl);

    const preview = (await (await post('/invitations/preview', { token })).json()) as Record<
      string,
      unknown
    >;
    assert.deepEqual(preview, {
      workspaceName: 'Team',
      email,
      role: 'engineer',
      hasAccount: false,
    });

    const short = await post('/invitations/accept', {
      token,
      displayName: 'New',
      password: 'short',
    });
    assert.equal(short.status, 400);

    const res = await post('/invitations/accept', {
      token,
      displayName: 'New Person',
      password: 'a long enough password',
    });
    assert.equal(res.status, 200);
    const cookie = /ds_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
    const detail = await fetch(`${url}/workspaces/${admin.workspaceId}`, { headers: { cookie } });
    assert.equal(((await detail.json()) as { role: string }).role, 'engineer');

    // The link works once.
    assert.equal((await post('/invitations/preview', { token })).status, 404);
  });

  it('asks an existing account to sign in, and refuses a different account', async () => {
    const admin = await memberWith('owner');
    const invitee = await createUser();
    users.push(invitee.id);
    const { acceptUrl } = (await (await invite(admin, invitee.email, 'viewer')).json()) as {
      acceptUrl: string;
    };
    const token = tokenOf(acceptUrl);
    assert.equal((await post('/invitations/accept', { token })).status, 401);

    const stranger = await memberWith('viewer');
    const wrong = await post('/invitations/accept', { token }, stranger.cookie);
    assert.equal(wrong.status, 403);

    const right = await post(
      '/invitations/accept',
      { token },
      await signInCookie(url, invitee.email),
    );
    assert.equal(right.status, 200);
  });

  it('replaces the old link when re-inviting, and honours revocation', async () => {
    const admin = await memberWith('admin');
    const email = newEmail();
    const first = (await (await invite(admin, email, 'viewer')).json()) as { acceptUrl: string };
    const second = (await (await invite(admin, email, 'viewer')).json()) as {
      id: string;
      acceptUrl: string;
    };
    assert.equal(
      (await post('/invitations/preview', { token: tokenOf(first.acceptUrl) })).status,
      404,
    );

    const revoke = await fetch(`${url}/workspaces/${admin.workspaceId}/invitations/${second.id}`, {
      method: 'DELETE',
      headers: { origin: WEB, cookie: admin.cookie },
    });
    assert.equal(revoke.status, 204);
    assert.equal(
      (await post('/invitations/preview', { token: tokenOf(second.acceptUrl) })).status,
      404,
    );
  });

  it('records invited and joined in the audit trail', async () => {
    const admin = await memberWith('owner');
    const { acceptUrl } = (await (await invite(admin, newEmail(), 'viewer')).json()) as {
      acceptUrl: string;
    };
    await post('/invitations/accept', {
      token: tokenOf(acceptUrl),
      displayName: 'Audited',
      password: 'a long enough password',
    });
    const actions = (
      await prisma.auditEvent.findMany({
        where: { workspaceId: admin.workspaceId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.action);
    assert.deepEqual(actions, ['member.invited', 'member.joined']);
  });
});
