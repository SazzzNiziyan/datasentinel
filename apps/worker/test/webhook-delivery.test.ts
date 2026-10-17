import { destinationContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import {
  BlockedAddress,
  deliverWebhooks,
  guardedLookup,
  postSigned,
  renderWebhookBody,
  resolveAllowed,
  signWebhook,
} from '../src/delivery/deliver-webhook.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const WEB = 'https://app.example.com';
const incidentId = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60';
const ring = keyRing({ key: randomBytes(32), version: 5 });
const secret = 'whsec_testsecret';

const answers =
  (...addresses: string[]) =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

describe('webhook signing', () => {
  it('signs timestamp and body so a receiver can verify and reject replays', () => {
    const body = '{"a":1}';
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex');
    assert.equal(signWebhook(secret, 1_700_000_000, body), `v1=${expected}`);
    assert.notEqual(
      signWebhook(secret, 1_700_000_001, body),
      signWebhook(secret, 1_700_000_000, body),
    );
    assert.notEqual(
      signWebhook(secret, 1_700_000_000, '{"a":2}'),
      signWebhook(secret, 1_700_000_000, body),
    );
    assert.notEqual(
      signWebhook('other', 1_700_000_000, body),
      signWebhook(secret, 1_700_000_000, body),
    );
  });

  it('sends ids and the safe payload only', () => {
    const body = JSON.parse(
      renderWebhookBody({
        deliveryId: 'd1',
        kind: 'incident_opened',
        createdAt: new Date('2026-10-17T10:00:00Z'),
        incidentId,
        webOrigin: `${WEB}/`,
        payload: {
          title: 'T',
          severity: 'critical',
          datasetName: 'orders',
          rowValue: 'secret-row',
        },
      }),
    ) as Record<string, unknown>;
    assert.deepEqual(body, {
      id: 'd1',
      type: 'incident_opened',
      createdAt: '2026-10-17T10:00:00.000Z',
      incident: {
        id: incidentId,
        title: 'T',
        severity: 'critical',
        datasetName: 'orders',
        url: `${WEB}/incidents/${incidentId}`,
      },
    });
  });
});

describe('webhook address guard', () => {
  it('refuses a name when any answer is private, local, or missing', async () => {
    await resolveAllowed(
      'ok.example',
      'public-only',
      answers('93.184.216.34', '2606:2800:220:1::1'),
    );
    for (const bad of [
      ['10.0.0.5'],
      ['127.0.0.1'],
      ['169.254.169.254'],
      ['::1'],
      ['93.184.216.34', '10.0.0.5'],
      [],
    ]) {
      await assert.rejects(
        resolveAllowed('x.example', 'public-only', answers(...bad)),
        BlockedAddress,
      );
    }
    await resolveAllowed('x.example', 'allow-private', answers('127.0.0.1'));
  });

  it('hands https only the checked addresses, in both lookup styles', async () => {
    const lookup = guardedLookup('public-only', answers('93.184.216.34'));
    const single = await new Promise<unknown[]>((resolve) =>
      lookup('a.example', {}, (...args: unknown[]) => resolve(args)),
    );
    assert.deepEqual(single, [null, '93.184.216.34', 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup('a.example', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
    const blocked = await new Promise<unknown[]>((resolve) =>
      guardedLookup('public-only', answers('10.0.0.1'))('a.example', {}, (...args: unknown[]) =>
        resolve(args),
      ),
    );
    assert.equal((blocked[0] as Error).name, 'BlockedAddress');
  });

  it('the real poster refuses local names and IP literals before connecting', async () => {
    const options = { timeoutMs: 500, policy: 'public-only' as const };
    for (const url of ['https://localhost:9/x', 'https://127.0.0.1:9/x', 'https://[::1]:9/x']) {
      await assert.rejects(postSigned(url, {}, '{}', options), { name: 'BlockedAddress' }, url);
    }
  });
});

describe('webhook delivery', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture(options: { url?: string; key?: ReturnType<typeof keyRing> } = {}) {
    const w = await prisma.workspace.create({ data: { name: 'W', slug: `w-${randomUUID()}` } });
    workspaces.push(w.id);
    const id = randomUUID();
    const sealed = sealSecret(
      options.key ?? ring,
      { signingSecret: secret },
      destinationContext(w.id, id),
    );
    const destination = await prisma.destination.create({
      data: {
        id,
        workspaceId: w.id,
        name: 'hook',
        type: 'webhook',
        events: ['incident_opened'],
        settings: { url: options.url ?? 'https://hooks.example.com/ds' },
        ciphertext: new Uint8Array(sealed.ciphertext),
        keyVersion: sealed.keyVersion,
      },
    });
    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: w.id,
        incidentId,
        incidentEventId: randomUUID(),
        destinationId: destination.id,
        kind: 'incident_opened',
        payload: { title: 'Orders are stale', severity: 'critical', datasetName: 'orders' },
      },
    });
    const reload = () =>
      prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    return { delivery, reload, workspaceId: w.id };
  }

  const clock = () => new Date(Date.now() + 5_000);
  const base = { prisma, ring, policy: 'public-only' as const, webOrigin: WEB };

  it('posts a verifiable signed request once and records it', async () => {
    const f = await fixture();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const deps = {
      ...base,
      workspaceIds: [f.workspaceId],
      post: (url: string, headers: Record<string, string>, body: string) => {
        calls.push({ url, headers, body });
        return Promise.resolve({ status: 204 });
      },
    };
    const now = clock();
    const out = await Promise.all([deliverWebhooks(deps, now), deliverWebhooks(deps, now)]);
    assert.equal(
      out.reduce((n, r) => n + r.sent, 0),
      1,
    );
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://hooks.example.com/ds');
    // What a receiver does: recompute from the timestamp header and raw body.
    const timestamp = Number(call.headers['x-datasentinel-timestamp']);
    assert.equal(timestamp, Math.floor(now.getTime() / 1000));
    assert.equal(
      call.headers['x-datasentinel-signature'],
      signWebhook(secret, timestamp, call.body),
    );
    assert.equal(call.headers['x-datasentinel-delivery'], f.delivery.id);
    assert.equal((JSON.parse(call.body) as { id: string }).id, f.delivery.id);
    assert.equal(call.body.includes(secret), false);
    const row = await f.reload();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1);
  });

  it('records each failure as a short reason code', async () => {
    const cases: [number | Error, string][] = [
      [410, 'webhook_http_410'],
      [503, 'webhook_http_503'],
      [429, 'webhook_http_429'],
      [new BlockedAddress(), 'address_blocked'],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'webhook_timeout'],
      [Object.assign(new Error('t'), { name: 'AbortError' }), 'webhook_timeout'],
      [new Error('connect ECONNREFUSED 10.0.0.9:443 whsec_testsecret'), 'webhook_unreachable'],
    ];
    for (const [result, expected] of cases) {
      const f = await fixture();
      await prisma.notificationDelivery.updateMany({
        where: { id: f.delivery.id },
        data: { attempts: 4 },
      });
      const out = await deliverWebhooks(
        {
          ...base,
          workspaceIds: [f.workspaceId],
          post: () =>
            typeof result === 'number'
              ? Promise.resolve({ status: result })
              : Promise.reject(result),
        },
        clock(),
      );
      assert.equal(out.failed, 1, expected);
      const row = await f.reload();
      assert.equal(row.status, 'failed');
      assert.equal(row.lastError, expected);
      assert.equal(JSON.stringify(row).includes(secret), false);
    }
  });

  it('never posts for an unopenable secret or a non-https stored address', async () => {
    const wrongKey = await fixture({ key: keyRing({ key: randomBytes(32), version: 5 }) });
    const plain = await fixture({ url: 'http://hooks.example.com/ds' });
    let posted = 0;
    const out = await deliverWebhooks(
      {
        ...base,
        workspaceIds: [wrongKey.workspaceId, plain.workspaceId],
        post: () => {
          posted += 1;
          return Promise.resolve({ status: 200 });
        },
      },
      clock(),
    );
    assert.equal(posted, 0);
    assert.equal(out.failed, 2);
    assert.equal((await wrongKey.reload()).lastError, 'secret_unavailable');
    assert.equal((await plain.reload()).lastError, 'invalid_destination');
  });
});
