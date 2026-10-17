import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import {
  deliverEmails,
  unconfiguredEmail,
  type EmailTransport,
  type SendResult,
} from '../src/delivery/deliver-email.js';
import { renderIncidentEmail, type EmailMessage } from '../src/delivery/email-template.js';
import { fanOutOutbox } from '../src/delivery/fan-out.js';
import { openIncidentForCheck } from '../src/incidents/open-incident.js';

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

describe('incident email template', () => {
  it('escapes values, flattens the subject, and links back', () => {
    const message = renderIncidentEmail({
      kind: 'incident_opened',
      incidentId,
      webOrigin: `${WEB}/`,
      to: ['a@example.com'],
      payload: {
        title: '<script>alert(1)</script>\r\nBcc: evil@example.com',
        severity: 'critical',
        datasetName: 'orders & "refunds"',
        rowValue: 'secret-row',
      },
    });
    assert.equal(/[\r\n]/.test(message.subject), false);
    assert.match(message.subject, /^\[DataSentinel\] Incident opened: <script>/);
    assert.equal(message.html.includes('<script>'), false);
    assert.match(message.html, /&lt;script&gt;/);
    assert.match(message.html, /orders &amp; &quot;refunds&quot;/);
    assert.match(message.text, new RegExp(`${WEB}/incidents/${incidentId}`));
    assert.equal((message.text + message.html).includes('secret-row'), false);
    assert.equal(/<img|src=|<script/i.test(message.html), false);
  });

  it('survives a missing or odd payload', () => {
    for (const payload of [null, 5, 'x', {}, { title: 42 }]) {
      const message = renderIncidentEmail({
        kind: 'incident_assigned',
        incidentId,
        webOrigin: WEB,
        to: ['a@example.com'],
        payload,
      });
      assert.match(message.subject, /Incident assigned: Untitled incident/);
    }
  });
});

class RecordingEmail implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly result: SendResult | 'throw' = { ok: true }) {}
  send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    if (this.result === 'throw') return Promise.reject(new Error('smtp password is hunter2'));
    return Promise.resolve(this.result);
  }
}

describe('fan-out and email delivery', { skip }, () => {
  let workspaces: string[] = [];
  let users: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    workspaces = [];
    users = [];
  });
  after(() => prisma.$disconnect());

  /** One workspace, two owners (so one incident event writes two outbox
   * rows), and a way to open an incident. */
  async function fixture() {
    const w = await prisma.workspace.create({ data: { name: 'E', slug: `e-${randomUUID()}` } });
    workspaces.push(w.id);
    for (let i = 0; i < 2; i += 1) {
      const user = await prisma.user.create({
        data: { email: `em-${randomUUID()}@test.example`, displayName: `Owner ${i}` },
      });
      users.push(user.id);
      await prisma.membership.create({
        data: { workspaceId: w.id, userId: user.id, role: 'owner' },
      });
    }
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        name: 'Orders are fresh',
        type: 'freshness',
        severity: 'critical',
        currentVersion: 1,
        revisions: {
          create: {
            version: 1,
            definition: { version: 1, type: 'freshness', maxAgeMinutes: 60 },
            severity: 'critical',
          },
        },
      },
      include: { revisions: true },
    });
    const open = async () => {
      const check = await prisma.checkRun.create({
        data: {
          workspaceId: w.id,
          ruleId: rule.id,
          ruleRevisionId: rule.revisions[0]!.id,
          trigger: 'manual',
          status: 'failed',
          idempotencyKey: `k-${randomUUID()}`,
          endedAt: new Date(),
        },
      });
      await openIncidentForCheck(prisma, w.id, check.id);
    };
    const destination = (
      data: Partial<{
        name: string;
        status: 'active' | 'paused' | 'archived';
        events: string[];
        recipients: string[];
      }> = {},
    ) =>
      prisma.destination.create({
        data: {
          workspaceId: w.id,
          name: data.name ?? `d-${randomUUID()}`,
          type: 'email',
          status: data.status ?? 'active',
          events: data.events ?? ['incident_opened'],
          settings: { recipients: data.recipients ?? ['ops@example.com'] },
        },
      });
    const deliveries = () =>
      prisma.notificationDelivery.findMany({
        where: { workspaceId: w.id },
        orderBy: { createdAt: 'asc' },
      });
    const outbox = () => prisma.notificationOutbox.findMany({ where: { workspaceId: w.id } });
    return { workspaceId: w.id, open, destination, deliveries, outbox };
  }

  it('fans one incident event out once per matching destination, however many recipients', async () => {
    const f = await fixture();
    const wanted = await f.destination({ name: 'wanted' });
    await f.destination({ name: 'paused', status: 'paused' });
    await f.destination({ name: 'archived', status: 'archived' });
    await f.destination({ name: 'other-kind', events: ['incident_assigned'] });
    await f.open();
    assert.equal((await f.outbox()).length, 2);

    const now = new Date(Date.now() + 5_000);
    assert.deepEqual(await fanOutOutbox(prisma, now, 100, f.workspaceId), {
      events: 1,
      deliveries: 1,
    });
    const [delivery, ...rest] = await f.deliveries();
    assert.equal(rest.length, 0);
    assert.equal(delivery?.destinationId, wanted.id);
    assert.equal(delivery?.status, 'pending');
    assert.deepEqual(
      (await f.outbox()).map((o) => o.status),
      ['sent', 'sent'],
    );
    // Running it again finds nothing new.
    assert.deepEqual(await fanOutOutbox(prisma, now, 100, f.workspaceId), {
      events: 0,
      deliveries: 0,
    });
    assert.equal((await f.deliveries()).length, 1);
  });

  it('suppresses outbox rows when no destination wants them', async () => {
    const f = await fixture();
    await f.open();
    await fanOutOutbox(prisma, new Date(), 100, f.workspaceId);
    assert.equal((await f.deliveries()).length, 0);
    assert.deepEqual(
      (await f.outbox()).map((o) => o.status),
      ['suppressed', 'suppressed'],
    );
  });

  it('sends a safe email, records it, and never sends it twice', async () => {
    const f = await fixture();
    await f.destination({ recipients: ['ops@example.com', 'lead@example.com'] });
    await f.open();
    const now = new Date(Date.now() + 5_000);
    await fanOutOutbox(prisma, now, 100, f.workspaceId);
    const transport = new RecordingEmail();
    const deps = { prisma, email: transport, webOrigin: WEB, workspaceIds: [f.workspaceId] };

    const results = await Promise.all([deliverEmails(deps, now), deliverEmails(deps, now)]);
    assert.equal(
      results.reduce((n, r) => n + r.sent, 0),
      1,
    );
    assert.equal(transport.sent.length, 1);
    assert.deepEqual(transport.sent[0]?.to, ['ops@example.com', 'lead@example.com']);
    assert.match(transport.sent[0]?.subject ?? '', /Incident opened: /);
    const [delivery] = await f.deliveries();
    assert.equal(delivery?.status, 'sent');
    assert.equal(delivery?.attempts, 1);
    assert.equal(delivery?.lastError, null);
    assert.ok(delivery?.sentAt);

    await deliverEmails(deps, new Date(now.getTime() + 3_600_000));
    assert.equal(transport.sent.length, 1);
  });

  it('records failures as short reason codes, never provider text', async () => {
    const cases: [SendResult | 'throw', string][] = [
      [{ ok: false, retryable: false, reason: 'mailbox_full' }, 'mailbox_full'],
      [
        { ok: false, retryable: true, reason: '550 Rejected: password hunter2 wrong' },
        'send_failed',
      ],
      ['throw', 'transport_error'],
    ];
    for (const [result, expected] of cases) {
      const f = await fixture();
      await f.destination();
      await f.open();
      const now = new Date(Date.now() + 5_000);
      await fanOutOutbox(prisma, now, 100, f.workspaceId);
      await prisma.notificationDelivery.updateMany({
        where: { workspaceId: f.workspaceId },
        data: { attempts: 4 },
      });
      const out = await deliverEmails(
        {
          prisma,
          email: new RecordingEmail(result),
          webOrigin: WEB,
          workspaceIds: [f.workspaceId],
        },
        now,
      );
      assert.equal(out.failed, 1);
      const [delivery] = await f.deliveries();
      assert.equal(delivery?.status, 'failed');
      assert.equal(delivery?.lastError, expected);
      assert.equal(delivery?.attempts, 5);
      assert.equal(JSON.stringify(delivery).includes('hunter2'), false);
    }
  });

  it('fails visibly when no email provider is configured', async () => {
    const f = await fixture();
    await f.destination();
    await f.open();
    const now = new Date(Date.now() + 5_000);
    await fanOutOutbox(prisma, now, 100, f.workspaceId);
    await deliverEmails(
      { prisma, email: unconfiguredEmail, webOrigin: WEB, workspaceIds: [f.workspaceId] },
      now,
    );
    const [delivery] = await f.deliveries();
    assert.equal(delivery?.status, 'failed');
    assert.equal(delivery?.lastError, 'email_not_configured');
  });

  it('suppresses a delivery whose destination was paused after fan-out', async () => {
    const f = await fixture();
    const destination = await f.destination();
    await f.open();
    const now = new Date(Date.now() + 5_000);
    await fanOutOutbox(prisma, now, 100, f.workspaceId);
    await prisma.destination.update({ where: { id: destination.id }, data: { status: 'paused' } });
    const transport = new RecordingEmail();
    const out = await deliverEmails(
      { prisma, email: transport, webOrigin: WEB, workspaceIds: [f.workspaceId] },
      now,
    );
    assert.equal(out.suppressed, 1);
    assert.equal(transport.sent.length, 0);
    assert.equal((await f.deliveries())[0]?.status, 'suppressed');
  });

  it('brings a claimed but unfinished delivery back after the lease', async () => {
    const f = await fixture();
    await f.destination();
    await f.open();
    const now = new Date(Date.now() + 5_000);
    await fanOutOutbox(prisma, now, 100, f.workspaceId);
    // A crashed worker claimed it: the due time moved forward, status is still pending.
    await prisma.notificationDelivery.updateMany({
      where: { workspaceId: f.workspaceId },
      data: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
    });
    const transport = new RecordingEmail();
    const deps = { prisma, email: transport, webOrigin: WEB, workspaceIds: [f.workspaceId] };
    assert.equal((await deliverEmails(deps, now)).sent, 0);
    assert.equal((await deliverEmails(deps, new Date(now.getTime() + 6 * 60_000))).sent, 1);
  });
});
