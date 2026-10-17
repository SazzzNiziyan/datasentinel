import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { deliverEmails } from '../src/delivery/deliver-email.js';
import { renderSlackMessage } from '../src/delivery/deliver-slack.js';
import { renderWebhookBody } from '../src/delivery/deliver-webhook.js';
import { isNotificationKind, renderIncidentEmail } from '../src/delivery/email-template.js';

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
const id = '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60';
const payload = {
  title: 'Test notification from DataSentinel',
  severity: 'info',
  datasetName: 'none',
};

describe('test notifications', () => {
  it('are labelled as tests and link to Settings, in every channel', () => {
    assert.equal(isNotificationKind('destination_test'), true);
    assert.equal(isNotificationKind('incident_closed'), false);

    const email = renderIncidentEmail({
      kind: 'destination_test',
      payload,
      incidentId: id,
      webOrigin: WEB,
      to: ['a@example.com'],
    });
    assert.match(email.subject, /^\[DataSentinel\] Test notification: /);
    assert.match(email.text, new RegExp(`${WEB}/settings$`));
    assert.equal(email.text.includes('/incidents/'), false);

    const slack = renderSlackMessage({
      kind: 'destination_test',
      payload,
      incidentId: id,
      webOrigin: WEB,
    });
    assert.match(slack.text, /^\*Test notification\*/);
    assert.match(slack.text, new RegExp(`<${WEB}/settings\\|`));

    const hook = JSON.parse(
      renderWebhookBody({
        deliveryId: 'd',
        kind: 'destination_test',
        createdAt: new Date(),
        payload,
        incidentId: id,
        webOrigin: WEB,
      }),
    ) as { type: string; incident: { url: string } };
    assert.equal(hook.type, 'destination_test');
    assert.equal(hook.incident.url, `${WEB}/settings`);
  });
});

describe('test delivery through the real path', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  it('sends a test email like any other delivery and records it', async () => {
    const w = await prisma.workspace.create({ data: { name: 'T', slug: `t-${randomUUID()}` } });
    workspaces.push(w.id);
    const destination = await prisma.destination.create({
      data: {
        workspaceId: w.id,
        name: 'mail',
        type: 'email',
        events: ['incident_opened'],
        settings: { recipients: ['ops@example.com'] },
      },
    });
    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: w.id,
        destinationId: destination.id,
        incidentId: destination.id,
        incidentEventId: randomUUID(),
        kind: 'destination_test',
        payload,
      },
    });
    const sent: string[] = [];
    const out = await deliverEmails(
      {
        prisma,
        webOrigin: WEB,
        workspaceIds: [w.id],
        email: {
          send: (m) => {
            sent.push(m.subject);
            return Promise.resolve({ ok: true });
          },
        },
      },
      new Date(Date.now() + 5_000),
    );
    assert.equal(out.sent, 1);
    assert.match(sent[0] ?? '', /Test notification/);
    assert.equal(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
      'sent',
    );
  });
});
