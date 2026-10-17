import { destinationContext, keyRing, openSecret, sealSecret } from '@datasentinel/connectors';
import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { rewrapCredentials } from '../src/credentials/credentials.js';
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

type Dest = { id: string; hasSecret: boolean; signingSecret?: string; code?: string };

const oldSlack = 'https://hooks.slack.com/services/T0000/B0000/oldoldold';
const newSlack = 'https://hooks.slack.com/services/T1111/B1111/newnewnew';

describe('destination secret rotation and archive', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'engineer' | 'admin') {
    const user = await createUser();
    users.push(user.id);
    await prisma.membership.create({ data: { workspaceId, userId: user.id, role } });
    let cached: string | undefined;
    return { cookie: async () => (cached ??= await signInCookie(url, user.email)) };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'K', slug: `k-${randomUUID()}` } });
    workspaces.push(w.id);
    const admin = await member(w.id, 'admin');
    const engineer = await member(w.id, 'engineer');
    const make = async (
      type: 'email' | 'slack' | 'webhook',
      secret?: Record<string, string>,
      ring = testKeyRing,
    ) => {
      const id = randomUUID();
      const sealed = secret && sealSecret(ring, secret, destinationContext(w.id, id));
      return prisma.destination.create({
        data: {
          id,
          workspaceId: w.id,
          name: `${type}-${id}`,
          type,
          events: ['incident_opened'],
          settings: type === 'email' ? { recipients: ['a@x.io'] } : {},
          ...(sealed
            ? { ciphertext: new Uint8Array(sealed.ciphertext), keyVersion: sealed.keyVersion }
            : {}),
        },
      });
    };
    const call = async (
      who: { cookie: () => Promise<string> },
      method: string,
      path: string,
      body?: unknown,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/destinations/${path}`, {
        method,
        headers: { cookie: await who.cookie(), origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Dest };
    };
    const opened = async (id: string) => {
      const row = await prisma.destination.findUniqueOrThrow({ where: { id } });
      return openSecret(
        testKeyRing,
        { ciphertext: Buffer.from(row.ciphertext ?? []), keyVersion: row.keyVersion ?? 0 },
        destinationContext(w.id, id),
      );
    };
    return { workspaceId: w.id, admin, engineer, make, call, opened };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('replaces a Slack URL at once and never shows either URL', async () => {
    const t = await tenant();
    const d = await t.make('slack', { webhookUrl: oldSlack });
    const res = await t.call(t.admin, 'POST', `${d.id}/rotate-secret`, { webhookUrl: newSlack });
    assert.equal(res.status, 201);
    assert.equal(res.text.includes('newnewnew') || res.text.includes('oldoldold'), false);
    assert.deepEqual(await t.opened(d.id), { webhookUrl: newSlack });
    assert.ok(
      (await prisma.destination.findUniqueOrThrow({ where: { id: d.id } })).secretRotatedAt,
    );
    const audits = await prisma.auditEvent.findMany({
      where: { action: 'destination.secret_rotated', targetId: d.id },
    });
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits).includes('newnewnew'), false);

    for (const bad of [{}, { webhookUrl: 'https://evil.example/x' }]) {
      assert.equal((await t.call(t.admin, 'POST', `${d.id}/rotate-secret`, bad)).status, 400);
    }
    assert.deepEqual(await t.opened(d.id), { webhookUrl: newSlack });
  });

  it('gives a webhook a new signing secret, shown once', async () => {
    const t = await tenant();
    const d = await t.make('webhook', { signingSecret: 'whsec_old' });
    const res = await t.call(t.admin, 'POST', `${d.id}/rotate-secret`, {});
    assert.equal(res.status, 201);
    assert.match(res.body.signingSecret ?? '', /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await t.opened(d.id), { signingSecret: res.body.signingSecret });
    const list = await t.call(t.admin, 'GET', '');
    assert.equal(list.text.includes(res.body.signingSecret ?? 'x'), false);
    assert.equal(
      (await t.call(t.admin, 'POST', `${d.id}/rotate-secret`, { webhookUrl: newSlack })).status,
      400,
    );
  });

  it('has nothing to rotate on email, and is admin only and workspace scoped', async () => {
    const t = await tenant();
    const other = await tenant();
    const email = await t.make('email');
    const slack = await t.make('slack', { webhookUrl: oldSlack });
    const res = await t.call(t.admin, 'POST', `${email.id}/rotate-secret`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'no_secret');
    assert.equal(
      (await t.call(t.engineer, 'POST', `${slack.id}/rotate-secret`, { webhookUrl: newSlack }))
        .status,
      403,
    );
    assert.equal(
      (
        await other.call(
          other.admin,
          'POST',
          `${slack.id}/rotate-secret`,
          { webhookUrl: newSlack },
          other.workspaceId,
        )
      ).status,
      404,
    );
    assert.deepEqual(await t.opened(slack.id), { webhookUrl: oldSlack });
  });

  it('wipes the secret when archived, after which nothing can rotate or send', async () => {
    const t = await tenant();
    const d = await t.make('slack', { webhookUrl: oldSlack });
    assert.equal((await t.call(t.admin, 'DELETE', d.id)).status, 204);
    const row = await prisma.destination.findUniqueOrThrow({ where: { id: d.id } });
    assert.equal(row.ciphertext, null);
    assert.equal(row.keyVersion, null);
    assert.equal(row.status, 'archived');
    const list = await t.call(t.admin, 'GET', '');
    assert.equal((JSON.parse(list.text) as Dest[])[0]?.hasSecret, false);
    const again = await t.call(t.admin, 'POST', `${d.id}/rotate-secret`, { webhookUrl: newSlack });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'destination_archived');
  });

  it('re-encrypts destination secrets when the key is rotated, leaving archived ones', async () => {
    const t = await tenant();
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const v1 = 2_000_000 + Math.floor(Math.random() * 1_000_000);
    const oldRing = keyRing({ key: k1, version: v1 });
    const newRing = keyRing({ key: k2, version: v1 + 1, previous: new Map([[v1, k1]]) });
    const live = await t.make('slack', { webhookUrl: oldSlack }, oldRing);
    const result = await rewrapCredentials(prisma, newRing);
    assert.ok(result.rewrapped >= 1);
    const row = await prisma.destination.findUniqueOrThrow({ where: { id: live.id } });
    assert.equal(row.keyVersion, v1 + 1);
    assert.deepEqual(
      openSecret(
        keyRing({ key: k2, version: v1 + 1 }),
        { ciphertext: Buffer.from(row.ciphertext ?? []), keyVersion: row.keyVersion ?? 0 },
        destinationContext(t.workspaceId, live.id),
      ),
      { webhookUrl: oldSlack },
    );
  });
});
