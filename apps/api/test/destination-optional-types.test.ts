import { destinationContext, openSecret } from '@datasentinel/connectors';
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
  testKeyRing,
  WEB,
} from './helpers.js';

const skip = await databaseSkipReason();

type Dest = {
  id: string;
  type: string;
  events: string[];
  repository: string | null;
  url: string | null;
  signingSecret?: string;
  types?: string[];
  code?: string;
};

const token = `github_pat_${'B'.repeat(30)}`;
const newToken = `github_pat_${'C'.repeat(30)}`;

describe('optional destination types', { skip }, () => {
  let on: { app: INestApplication; url: string };
  let off: { app: INestApplication; url: string };
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'O', slug: `o-${randomUUID()}` } });
    workspaces.push(w.id);
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role: 'admin' } });
    const cookies = new Map<string, string>();
    const call = async (server: { url: string }, method: string, path: string, body?: unknown) => {
      let cookie = cookies.get(server.url);
      if (cookie === undefined) {
        cookie = await signInCookie(server.url, user.email);
        cookies.set(server.url, cookie);
      }
      const res = await fetch(`${server.url}/workspaces/${w.id}/destinations${path}`, {
        method,
        headers: { cookie, origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Dest };
    };
    return { workspaceId: w.id, call };
  }

  before(async () => {
    on = await startApi({ sourceJobs: new RecordingSourceJobs() });
    off = await startApi({
      sourceJobs: new RecordingSourceJobs(),
      features: { github: false, n8n: false },
    });
  });
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await on.app.close();
    await off.app.close();
  });

  it('creates a GitHub destination: sealed token, one event, repository shown', async () => {
    const t = await tenant();
    const res = await t.call(on, 'POST', '', {
      type: 'github',
      name: 'Issues',
      owner: 'acme',
      repo: 'data-alerts',
      token,
      labels: ['data-quality'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.repository, 'acme/data-alerts');
    assert.deepEqual(res.body.events, ['incident_opened']);
    assert.equal(res.text.includes(token), false);
    const row = await prisma.destination.findUniqueOrThrow({ where: { id: res.body.id } });
    assert.deepEqual(
      openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(row.ciphertext ?? []), keyVersion: row.keyVersion ?? 0 },
        destinationContext(t.workspaceId, row.id),
      ),
      { token },
    );
    assert.deepEqual(row.settings, {
      owner: 'acme',
      repo: 'data-alerts',
      labels: ['data-quality'],
    });
    const audits = await prisma.auditEvent.findMany({ where: { workspaceId: t.workspaceId } });
    assert.equal(JSON.stringify(audits).includes(token), false);

    // Events cannot be widened (API check and database check), the token rotates.
    assert.equal(
      (await t.call(on, 'PATCH', `/${row.id}`, { events: ['incident_reopened'] })).status,
      400,
    );
    await assert.rejects(
      prisma.destination.update({ where: { id: row.id }, data: { events: ['incident_assigned'] } }),
      /destinations_github_events_check/,
    );
    assert.equal((await t.call(on, 'POST', `/${row.id}/rotate-secret`, {})).status, 400);
    assert.equal(
      (await t.call(on, 'POST', `/${row.id}/rotate-secret`, { token: newToken })).status,
      201,
    );
    const rotated = await prisma.destination.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual(
      openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(rotated.ciphertext ?? []), keyVersion: rotated.keyVersion ?? 0 },
        destinationContext(t.workspaceId, row.id),
      ),
      { token: newToken },
    );
  });

  it('creates an n8n destination like a webhook: checked address, signing secret once', async () => {
    const t = await tenant();
    const res = await t.call(on, 'POST', '', {
      type: 'n8n',
      name: 'Flow',
      url: 'https://n8n.example.com/webhook/abc',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.signingSecret ?? '', /^whsec_/);
    assert.equal(res.body.url, 'https://n8n.example.com/webhook/abc');
    for (const url of ['https://localhost/x', 'https://10.0.0.5/x']) {
      assert.equal(
        (await t.call(on, 'POST', '', { type: 'n8n', name: `bad-${url}`, url })).status,
        400,
        url,
      );
    }
    const rotated = await t.call(on, 'POST', `/${res.body.id}/rotate-secret`, {});
    assert.match(rotated.body.signingSecret ?? '', /^whsec_/);
    assert.notEqual(rotated.body.signingSecret, res.body.signingSecret);
  });

  it('refuses both types, and shows only enabled ones, while their flags are off', async () => {
    const t = await tenant();
    const github = await t.call(off, 'POST', '', {
      type: 'github',
      name: 'Issues',
      owner: 'acme',
      repo: 'r',
      token,
    });
    assert.equal(github.status, 409);
    assert.equal(github.body.code, 'feature_disabled');
    const n8n = await t.call(off, 'POST', '', {
      type: 'n8n',
      name: 'Flow',
      url: 'https://n8n.example.com/x',
    });
    assert.equal(n8n.status, 409);
    assert.equal(await prisma.destination.count({ where: { workspaceId: t.workspaceId } }), 0);
    assert.equal(
      (await t.call(off, 'POST', '', { type: 'email', name: 'Mail', recipients: ['a@x.io'] }))
        .status,
      201,
    );
    assert.deepEqual((await t.call(off, 'GET', '/options')).body.types, [
      'email',
      'slack',
      'webhook',
    ]);
    assert.deepEqual((await t.call(on, 'GET', '/options')).body.types, [
      'email',
      'slack',
      'webhook',
      'github',
      'n8n',
    ]);
  });
});
