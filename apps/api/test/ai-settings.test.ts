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

type Ai = {
  available: boolean;
  enabled: boolean;
  provider: string | null;
  region: string | null;
  retention: string | null;
  code?: string;
};

describe('AI settings', { skip }, () => {
  let on: { app: INestApplication; url: string };
  let off: { app: INestApplication; url: string };
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'A', slug: `a-${randomUUID()}` } });
    workspaces.push(w.id);
    const member = async (role: 'viewer' | 'admin') => {
      const user = await createUser();
      users.push(user.id);
      await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
      const cookies = new Map<string, string>();
      return async (server: { url: string }) => {
        let cookie = cookies.get(server.url);
        if (cookie === undefined) {
          cookie = await signInCookie(server.url, user.email);
          cookies.set(server.url, cookie);
        }
        return cookie;
      };
    };
    const admin = await member('admin');
    const viewer = await member('viewer');
    const call = async (
      server: { url: string },
      who: (server: { url: string }) => Promise<string>,
      method: string,
      body?: unknown,
    ) => {
      const res = await fetch(`${server.url}/workspaces/${w.id}/ai-settings`, {
        method,
        headers: { cookie: await who(server), origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Ai };
    };
    return { workspaceId: w.id, admin, viewer, call };
  }

  before(async () => {
    on = await startApi({ sourceJobs: new RecordingSourceJobs() });
    off = await startApi({
      sourceJobs: new RecordingSourceJobs(),
      ai: { available: false, provider: null, region: null, retention: null },
    });
  });
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await on.app.close();
    await off.app.close();
  });

  it('is off for a new workspace and shows the provider, region, and retention', async () => {
    const t = await tenant();
    const view = await t.call(on, t.viewer, 'GET');
    assert.equal(view.status, 200);
    assert.deepEqual(view.body, {
      available: true,
      enabled: false,
      provider: 'Test Provider',
      region: 'eu-test-1',
      retention: 'No retention (test)',
    });
  });

  it('needs an acknowledgement to turn on, and audits both directions', async () => {
    const t = await tenant();
    for (const bad of [
      { enabled: true },
      { enabled: true, acknowledge: false },
      {},
      { enabled: 'yes' },
    ]) {
      assert.equal((await t.call(on, t.admin, 'PUT', bad)).status, 400, JSON.stringify(bad));
    }
    const enabled = await t.call(on, t.admin, 'PUT', { enabled: true, acknowledge: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);
    assert.equal((await t.call(on, t.viewer, 'GET')).body.enabled, true);
    const disabled = await t.call(on, t.admin, 'PUT', { enabled: false });
    assert.equal(disabled.body.enabled, false);
    for (const action of ['workspace.ai_enabled', 'workspace.ai_disabled']) {
      await prisma.auditEvent.findFirstOrThrow({ where: { action, workspaceId: t.workspaceId } });
    }
    // Setting the same value again changes and audits nothing more.
    await t.call(on, t.admin, 'PUT', { enabled: false });
    assert.equal(
      await prisma.auditEvent.count({
        where: { action: 'workspace.ai_disabled', workspaceId: t.workspaceId },
      }),
      1,
    );
  });

  it('is for admins only to change', async () => {
    const t = await tenant();
    assert.equal(
      (await t.call(on, t.viewer, 'PUT', { enabled: true, acknowledge: true })).status,
      403,
    );
    assert.equal(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: t.workspaceId } })).aiEnabled,
      false,
    );
  });

  it('cannot be turned on, and never reads as on, while the deployment has not allowed it', async () => {
    const t = await tenant();
    const refused = await t.call(off, t.admin, 'PUT', { enabled: true, acknowledge: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ai_unavailable');
    // Even a stored opt-in reads as off when the deployment turns AI off.
    await prisma.workspace.update({ where: { id: t.workspaceId }, data: { aiEnabled: true } });
    const view = await t.call(off, t.admin, 'GET');
    assert.deepEqual(view.body, {
      available: false,
      enabled: false,
      provider: null,
      region: null,
      retention: null,
    });
    assert.equal((await t.call(off, t.admin, 'PUT', { enabled: false })).status, 200);
  });
});
