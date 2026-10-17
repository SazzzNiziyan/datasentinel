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
  name: string;
  type: string;
  status: string;
  events: string[];
  recipients: string[];
  url: string | null;
  hasSecret: boolean;
  signingSecret?: string;
  code?: string;
};

const slack = 'https://hooks.slack.com/services/T0123/B0456/abcDEF123';

describe('alert destinations', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'engineer' | 'admin') {
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId, userId: user.id, role } });
    let cached: string | undefined;
    return { user, cookie: async () => (cached ??= await signInCookie(url, user.email)) };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'D', slug: `d-${randomUUID()}` } });
    workspaces.push(w.id);
    const admin = await member(w.id, 'admin');
    const engineer = await member(w.id, 'engineer');
    const call = async (
      who: { cookie: () => Promise<string> },
      method: string,
      path: string,
      body?: unknown,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/destinations${path}`, {
        method,
        headers: { cookie: await who.cookie(), origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Dest };
    };
    return { workspaceId: w.id, admin, engineer, call };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('creates email, slack, and webhook destinations and never shows a stored secret', async () => {
    const t = await tenant();
    const email = await t.call(t.admin, 'POST', '', {
      type: 'email',
      name: 'On call',
      recipients: ['Ops@Example.com'],
    });
    assert.equal(email.status, 201);
    assert.deepEqual(email.body.recipients, ['ops@example.com']);
    assert.equal(email.body.hasSecret, false);

    const hook = await t.call(t.admin, 'POST', '', {
      type: 'slack',
      name: 'Slack',
      webhookUrl: slack,
    });
    assert.equal(hook.status, 201);
    assert.equal(hook.body.hasSecret, true);
    assert.equal(hook.text.includes('abcDEF123'), false);

    const web = await t.call(t.admin, 'POST', '', {
      type: 'webhook',
      name: 'Receiver',
      url: 'https://hooks.example.com/ds',
      events: ['incident_opened'],
    });
    assert.equal(web.status, 201);
    const signing = web.body.signingSecret;
    assert.match(signing ?? '', /^whsec_[A-Za-z0-9_-]{43}$/);

    // The list never repeats a secret, and the sealed copy opens to the same value.
    const list = await t.call(t.admin, 'GET', '');
    assert.equal(list.text.includes(signing ?? 'x'), false);
    assert.equal(list.text.includes('abcDEF123'), false);
    assert.equal(list.text.includes('ciphertext'), false);
    const row = await prisma.destination.findUniqueOrThrow({ where: { id: web.body.id } });
    assert.deepEqual(
      openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(row.ciphertext ?? []), keyVersion: row.keyVersion ?? 0 },
        destinationContext(t.workspaceId, web.body.id),
      ),
      { signingSecret: signing },
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'destination.created', targetId: web.body.id },
    });
    const audits = await prisma.auditEvent.findMany({ where: { workspaceId: t.workspaceId } });
    assert.equal(JSON.stringify(audits).includes('abcDEF123'), false);
    assert.equal(JSON.stringify(audits).includes(signing ?? 'x'), false);
  });

  it('is for admins only', async () => {
    const t = await tenant();
    assert.equal((await t.call(t.engineer, 'GET', '')).status, 403);
    assert.equal(
      (await t.call(t.engineer, 'POST', '', { type: 'email', name: 'x', recipients: ['a@x.io'] }))
        .status,
      403,
    );
    assert.equal(await prisma.destination.count({ where: { workspaceId: t.workspaceId } }), 0);
  });

  it('refuses bad input, local webhook addresses, and duplicate names', async () => {
    const t = await tenant();
    for (const bad of [
      { type: 'slack', name: 'x', webhookUrl: 'https://evil.example/x' },
      { type: 'webhook', name: 'x', url: 'http://hooks.example.com/x' },
      { type: 'webhook', name: 'x', url: 'https://localhost/x' },
      { type: 'webhook', name: 'x', url: 'https://127.0.0.1/x' },
      { type: 'webhook', name: 'x', url: 'https://169.254.169.254/latest' },
      { type: 'webhook', name: 'x', url: 'https://[::1]/x' },
      { type: 'webhook', name: 'x', url: 'https://db.internal/x' },
    ]) {
      assert.equal((await t.call(t.admin, 'POST', '', bad)).status, 400, JSON.stringify(bad));
    }
    const ok = { type: 'email', name: 'Same', recipients: ['a@x.io'] };
    assert.equal((await t.call(t.admin, 'POST', '', ok)).status, 201);
    const again = await t.call(t.admin, 'POST', '', ok);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'destination_name_taken');
  });

  it('updates, pauses, and archives with an audit trail; other workspaces see 404', async () => {
    const t = await tenant();
    const other = await tenant();
    const email = await t.call(t.admin, 'POST', '', {
      type: 'email',
      name: 'A',
      recipients: ['a@x.io'],
    });
    const id = email.body.id;
    const patched = await t.call(t.admin, 'PATCH', `/${id}`, {
      name: 'B',
      recipients: ['b@x.io', 'c@x.io'],
      events: ['incident_assigned'],
      status: 'paused',
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(
      [patched.body.name, patched.body.status, patched.body.events, patched.body.recipients],
      ['B', 'paused', ['incident_assigned'], ['b@x.io', 'c@x.io']],
    );
    assert.equal((await t.call(t.admin, 'PATCH', `/${id}`, { url: 'https://x.io/a' })).status, 400);
    assert.equal((await t.call(t.admin, 'PATCH', `/${id}`, { type: 'slack' })).status, 400);
    assert.equal(
      (await other.call(other.admin, 'PATCH', `/${id}`, { name: 'Z' }, other.workspaceId)).status,
      404,
    );
    assert.equal((await t.call(t.admin, 'DELETE', `/${id}`)).status, 204);
    assert.equal((await t.call(t.admin, 'DELETE', `/${id}`)).status, 404);
    assert.equal((await t.call(t.admin, 'PATCH', `/${id}`, { name: 'C' })).status, 409);
    const listed = await t.call(t.admin, 'GET', '');
    assert.equal((JSON.parse(listed.text) as Dest[])[0]?.status, 'archived');
    for (const action of ['destination.created', 'destination.updated', 'destination.archived']) {
      await prisma.auditEvent.findFirstOrThrow({ where: { action, targetId: id } });
    }
  });

  it('keeps a secret all-or-nothing at the database', async () => {
    const t = await tenant();
    await assert.rejects(
      prisma.destination.create({
        data: {
          workspaceId: t.workspaceId,
          name: 'bad',
          type: 'slack',
          events: ['incident_opened'],
        },
      }),
      /destinations_secret_required_check/,
    );
    await assert.rejects(
      prisma.destination.create({
        data: { workspaceId: t.workspaceId, name: 'bad2', type: 'email', events: ['nonsense'] },
      }),
      /destinations_events_check/,
    );
  });
});
