import { safeNotificationPayload } from '@datasentinel/contracts';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { renderGitHubIssue } from '../src/delivery/deliver-github.js';
import { renderSlackMessage } from '../src/delivery/deliver-slack.js';
import { renderWebhookBody } from '../src/delivery/deliver-webhook.js';
import { renderIncidentEmail } from '../src/delivery/email-template.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const HOSTILE = {
  title: 'Orders are stale',
  severity: 'critical',
  datasetName: 'orders',
  rows: [{ email: 'SECRET-ROW-VALUE@example.com' }],
  rowValue: 'SECRET-ROW-VALUE',
  password: 'hunter2',
  connectionString: 'postgres://reader:hunter2@db.internal/prod',
  signingSecret: 'whsec_hunter2',
  token: 'github_pat_hunter2',
};
const LEAKS = ['SECRET-ROW-VALUE', 'hunter2', 'postgres://', 'whsec_', 'github_pat_'];

describe('what integrations receive', () => {
  it('keeps only title, severity, and dataset name, as short strings', () => {
    assert.deepEqual(safeNotificationPayload(HOSTILE), {
      title: 'Orders are stale',
      severity: 'critical',
      datasetName: 'orders',
    });
    assert.deepEqual(safeNotificationPayload({ title: 5, severity: null, datasetName: ['x'] }), {});
    assert.equal(safeNotificationPayload({ title: 'x'.repeat(500) }).title?.length, 200);
    for (const odd of [null, undefined, 'text', 7, [], [HOSTILE]]) {
      assert.deepEqual(safeNotificationPayload(odd), {});
    }
  });

  it('never puts a row value or secret into any channel, even from a hostile payload', () => {
    const base = { incidentId: 'i1', webOrigin: 'https://app.example.com', payload: HOSTILE };
    const outputs = [
      JSON.stringify(
        renderIncidentEmail({ ...base, kind: 'incident_opened', to: ['a@example.com'] }),
      ),
      JSON.stringify(renderSlackMessage({ ...base, kind: 'incident_opened' })),
      JSON.stringify(
        renderGitHubIssue({ ...base, kind: 'incident_opened', deliveryId: 'd1', labels: [] }),
      ),
      renderWebhookBody({
        ...base,
        kind: 'incident_opened',
        deliveryId: 'd1',
        createdAt: new Date(),
      }),
    ];
    for (const output of outputs) {
      for (const leak of LEAKS) {
        assert.equal(output.includes(leak), false, `${leak} leaked into: ${output.slice(0, 80)}`);
      }
    }
  });
});

describe('payload allow-list in the database', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  it('refuses any other field, or a non-object, in a delivery', async () => {
    const w = await prisma.workspace.create({ data: { name: 'S', slug: `s-${randomUUID()}` } });
    workspaces.push(w.id);
    const destination = await prisma.destination.create({
      data: {
        workspaceId: w.id,
        name: 'mail',
        type: 'email',
        events: ['incident_opened'],
        settings: { recipients: ['a@x.io'] },
      },
    });
    const make = (payload: object) =>
      prisma.notificationDelivery.create({
        data: {
          workspaceId: w.id,
          destinationId: destination.id,
          incidentId: randomUUID(),
          incidentEventId: randomUUID(),
          kind: 'incident_opened',
          payload,
        },
      });
    await make({ title: 't', severity: 'critical', datasetName: 'd' });
    await make({});
    for (const bad of [{ title: 't', rowValue: 'x' }, { rows: [] }, [], [{ title: 't' }]]) {
      await assert.rejects(make(bad), /payload_allowlist_check/, JSON.stringify(bad));
    }
  });

  it('refuses any other field in an outbox row too', async () => {
    const w = await prisma.workspace.create({ data: { name: 'S', slug: `s-${randomUUID()}` } });
    workspaces.push(w.id);
    const user = await prisma.user.create({
      data: { email: `ps-${randomUUID()}@test.example`, displayName: 'O' },
    });
    try {
      const member = await prisma.membership.create({
        data: { workspaceId: w.id, userId: user.id, role: 'owner' },
      });
      const source = await prisma.dataSource.create({
        data: { workspaceId: w.id, name: 'csv', type: 'csv' },
      });
      const dataset = await prisma.dataset.create({
        data: { workspaceId: w.id, sourceId: source.id, stableKey: 'o', name: 'o' },
      });
      const rule = await prisma.qualityRule.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          name: 'r',
          type: 'freshness',
          severity: 'critical',
          currentVersion: 1,
        },
      });
      const incident = await prisma.incident.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          ruleId: rule.id,
          dedupeKey: `rule:${rule.id}`,
          title: 't',
          severity: 'critical',
          lastFailureAt: new Date(),
        },
      });
      const event = await prisma.incidentEvent.create({
        data: { workspaceId: w.id, incidentId: incident.id, type: 'opened', actorType: 'system' },
      });
      const make = (payload: object) =>
        prisma.notificationOutbox.create({
          data: {
            workspaceId: w.id,
            incidentId: incident.id,
            incidentEventId: event.id,
            recipientMembershipId: member.id,
            kind: 'incident_opened',
            payload,
          },
        });
      await assert.rejects(make({ title: 't', password: 'hunter2' }), /payload_allowlist_check/);
      await make({ title: 't', severity: 'critical', datasetName: 'd' });
    } finally {
      await prisma.workspace.deleteMany({ where: { id: w.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});
