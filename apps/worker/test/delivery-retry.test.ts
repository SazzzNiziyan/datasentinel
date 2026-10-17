import { destinationContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { DELIVERY_MAX_ATTEMPTS, deliveryBackoffMs } from '@datasentinel/contracts';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { deliverSlack } from '../src/delivery/deliver-slack.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const ring = keyRing({ key: randomBytes(32), version: 5 });
const slackUrl = 'https://hooks.slack.com/services/T0123/B0456/abcDEF123';
const HOUR = 3_600_000;

describe('delivery backoff', () => {
  it('waits 1 min, 5 min, 15 min, 1 h, then 6 h, and never more', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 99].map(deliveryBackoffMs),
      [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000],
    );
    assert.equal(deliveryBackoffMs(0), 60_000);
    assert.equal(DELIVERY_MAX_ATTEMPTS, 5);
  });
});

describe('delivery retries', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture() {
    const w = await prisma.workspace.create({ data: { name: 'R', slug: `r-${randomUUID()}` } });
    workspaces.push(w.id);
    const id = randomUUID();
    const sealed = sealSecret(ring, { webhookUrl: slackUrl }, destinationContext(w.id, id));
    const destination = await prisma.destination.create({
      data: {
        id,
        workspaceId: w.id,
        name: 'slack',
        type: 'slack',
        events: ['incident_opened'],
        ciphertext: new Uint8Array(sealed.ciphertext),
        keyVersion: sealed.keyVersion,
      },
    });
    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: w.id,
        incidentId: randomUUID(),
        incidentEventId: randomUUID(),
        destinationId: destination.id,
        kind: 'incident_opened',
        payload: { title: 'T', severity: 'critical', datasetName: 'd' },
      },
    });
    const reload = () =>
      prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    return { reload, workspaceId: w.id };
  }

  const deps = (statuses: number[], calls: { n: number }, workspaceId: string) => ({
    workspaceIds: [workspaceId],
    prisma,
    ring,
    webOrigin: 'https://app.example.com',
    post: () => {
      const status = statuses[Math.min(calls.n, statuses.length - 1)]!;
      calls.n += 1;
      return Promise.resolve({ status, text: '' });
    },
  });

  it('keeps a retryable failure pending, waits the backoff, then succeeds', async () => {
    const f = await fixture();
    const calls = { n: 0 };
    const d = deps([503, 200], calls, f.workspaceId);
    const t0 = Date.now() + 5_000;

    const first = await deliverSlack(d, new Date(t0));
    assert.deepEqual([first.retrying, first.failed, first.sent], [1, 0, 0]);
    let row = await f.reload();
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'slack_http_503');
    assert.equal(row.nextAttemptAt.getTime(), t0 + deliveryBackoffMs(1));

    await deliverSlack(d, new Date(t0 + 30_000));
    assert.equal(calls.n, 1, 'not due yet: no second attempt');

    const second = await deliverSlack(d, new Date(t0 + 61_000));
    assert.equal(second.sent, 1);
    row = await f.reload();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
    assert.equal(row.lastError, null);
  });

  it('gives up after the attempt budget and says why', async () => {
    const f = await fixture();
    const calls = { n: 0 };
    const d = deps([500], calls, f.workspaceId);
    let t = Date.now() + 5_000;
    const outcomes = [];
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS + 2; i += 1) {
      outcomes.push(await deliverSlack(d, new Date(t)));
      t += 7 * HOUR;
    }
    assert.equal(calls.n, DELIVERY_MAX_ATTEMPTS);
    assert.deepEqual(
      outcomes.slice(0, DELIVERY_MAX_ATTEMPTS).map((o) => [o.retrying, o.failed]),
      [
        [1, 0],
        [1, 0],
        [1, 0],
        [1, 0],
        [0, 1],
      ],
    );
    const row = await f.reload();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, DELIVERY_MAX_ATTEMPTS);
    assert.equal(row.lastError, 'slack_http_500');
  });

  it('stops at once on a failure that can never succeed', async () => {
    const f = await fixture();
    const calls = { n: 0 };
    const out = await deliverSlack(deps([404], calls, f.workspaceId), new Date(Date.now() + 5_000));
    assert.deepEqual([out.retrying, out.failed], [0, 1]);
    const row = await f.reload();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'slack_http_404');
  });
});
