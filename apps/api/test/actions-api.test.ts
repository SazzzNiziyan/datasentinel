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

type Role = 'viewer' | 'analyst' | 'engineer' | 'admin' | 'owner';
type Action = {
  id: string;
  type: string;
  status: string;
  payloadHash: string;
  preview: { title: string; steps: string[]; leavesDataSentinel: boolean };
  proposedByName: string | null;
  decidedByName: string | null;
  approvalExpiresAt: string | null;
  events: { type: string; actorName: string | null }[];
  can: { approve: boolean; reject: boolean; cancel: boolean };
  code?: string;
};
type Options = {
  rules: { name: string }[];
  uploads: { filename: string }[];
  destinations: { name: string; type: string }[];
};

describe('recovery action proposals and approvals', { skip }, () => {
  let on: { app: INestApplication; url: string };
  let off: { app: INestApplication; url: string };
  const users: string[] = [];
  const workspaces: string[] = [];

  const ROLES: [string, Role][] = [
    ['viewer', 'viewer'],
    ['analyst', 'analyst'],
    ['engineer', 'engineer'],
    ['engineer2', 'engineer'],
    ['admin', 'admin'],
    ['owner', 'owner'],
  ];
  /** One user per label, shared by every tenant, so each signs in once per
   * server (sign-in is rate limited). */
  const pool = new Map<string, { id: string; who: (server: { url: string }) => Promise<string> }>();
  async function poolUser(label: string) {
    const existing = pool.get(label);
    if (existing !== undefined) return existing;
    const user = await createUser();
    users.push(user.id);
    const cookies = new Map<string, string>();
    const entry = {
      id: user.id,
      who: async (server: { url: string }) => {
        let cookie = cookies.get(server.url);
        if (cookie === undefined) {
          cookie = await signInCookie(server.url, user.email);
          cookies.set(server.url, cookie);
        }
        return cookie;
      },
    };
    pool.set(label, entry);
    return entry;
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'A', slug: `a-${randomUUID()}` } });
    workspaces.push(w.id);
    type Who = (server: { url: string }) => Promise<string>;
    const people: Record<string, { who: Who; membershipId: string }> = {};
    for (const [label, role] of ROLES) {
      const pooled = await poolUser(label);
      const m = await prisma.membership.create({
        data: { workspaceId: w.id, userId: pooled.id, role },
      });
      people[label] = { membershipId: m.id, who: pooled.who };
    }
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'warehouse', type: 'csv' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'orders', name: 'orders' },
    });
    const otherDataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: source.id, stableKey: 'refunds', name: 'refunds' },
    });
    const mkRule = (datasetId: string, name: string, enabled = true) =>
      prisma.qualityRule.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId,
          name,
          type: 'freshness',
          severity: 'critical',
          enabled,
          currentVersion: 1,
        },
      });
    const rule = await mkRule(dataset.id, 'Orders are fresh');
    const foreignRule = await mkRule(otherDataset.id, 'Refunds are fresh');
    const disabledRule = await mkRule(dataset.id, 'Disabled rule', false);
    const incident = await prisma.incident.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        ruleId: rule.id,
        dedupeKey: `rule:${rule.id}`,
        title: 'Orders are fresh failed on orders',
        severity: 'critical',
        lastFailureAt: new Date(),
      },
    });
    const mkUpload = (status: 'failed' | 'succeeded', filename: string) =>
      prisma.upload.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          objectKey: `k-${randomUUID()}`,
          filename,
          sizeBytes: 10,
          checksumSha256: 'a'.repeat(64),
          status,
          createdByMembershipId: people.engineer!.membershipId,
          uploadUrlExpiresAt: new Date(Date.now() + 60_000),
          retainUntil: new Date(Date.now() + 86_400_000),
        },
      });
    const failedUpload = await mkUpload('failed', 'orders.csv');
    const goodUpload = await mkUpload('succeeded', 'good.csv');
    const mkDest = (type: 'email' | 'github' | 'n8n', name: string) =>
      prisma.destination.create({
        data: {
          workspaceId: w.id,
          name,
          type,
          events: ['incident_opened'],
          settings:
            type === 'email'
              ? { recipients: ['a@x.io'] }
              : type === 'github'
                ? { owner: 'acme', repo: 'alerts' }
                : { url: 'https://n8n.example.com/webhook/abc' },
          ...(type === 'email' ? {} : { ciphertext: new Uint8Array([1, 2, 3]), keyVersion: 1 }),
        },
      });
    const email = await mkDest('email', 'On call');
    const github = await mkDest('github', 'Issues');
    const n8n = await mkDest('n8n', 'Flow');

    const call = async (
      who: keyof typeof people,
      method: string,
      path: string,
      body?: unknown,
      server = on,
    ) => {
      const res = await fetch(`${server.url}/workspaces/${w.id}${path}`, {
        method,
        headers: {
          cookie: await people[who]!.who(server),
          origin: WEB,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Action };
    };
    const propose = (
      who: keyof typeof people,
      type: string,
      payload: Record<string, string>,
      server = on,
    ) => call(who, 'POST', `/incidents/${incident.id}/actions`, { type, payload }, server);
    return {
      workspaceId: w.id,
      people,
      incident,
      rule,
      foreignRule,
      disabledRule,
      failedUpload,
      goodUpload,
      email,
      github,
      n8n,
      call,
      propose,
    };
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

  it('proposes with an exact preview, a payload hash, a log entry, and an audit event', async () => {
    const t = await tenant();
    const res = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'proposed');
    assert.match(res.body.payloadHash, /^[0-9a-f]{12}$/);
    assert.match(res.body.preview.title, /Orders are fresh/);
    assert.equal(res.body.preview.leavesDataSentinel, false);
    assert.deepEqual(
      res.body.events.map((e) => e.type),
      ['proposed'],
    );
    const row = await prisma.actionProposal.findUniqueOrThrow({ where: { id: res.body.id } });
    assert.match(row.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(row.payloadHash.startsWith(res.body.payloadHash), true);
    assert.equal(row.approvedPayloadHash, null);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'action.proposed', workspaceId: t.workspaceId },
    });
    // The same proposal while one is open is refused.
    const again = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'action_already_pending');
  });

  it('only accepts targets that belong to this incident and are usable', async () => {
    const t = await tenant();
    const cases: [string, Record<string, string>][] = [
      ['rerun_validation', { ruleId: t.foreignRule.id }],
      ['rerun_validation', { ruleId: t.disabledRule.id }],
      ['rerun_validation', { ruleId: randomUUID() }],
      ['retry_import', { uploadId: t.goodUpload.id }],
      ['retry_import', { uploadId: randomUUID() }],
      ['send_notification', { destinationId: t.github.id }],
      ['create_github_issue', { destinationId: t.email.id }],
      ['trigger_n8n', { destinationId: t.email.id }],
    ];
    for (const [type, payload] of cases) {
      const res = await t.propose('engineer', type, payload);
      assert.equal(res.status, 409, `${type} ${JSON.stringify(payload)}`);
      assert.equal(res.body.code, 'target_unavailable');
    }
    assert.equal((await t.propose('engineer', 'run_sql', { query: 'drop table x' })).status, 400);
    const off1 = await t.propose(
      'engineer',
      'create_github_issue',
      { destinationId: t.github.id },
      off,
    );
    assert.equal(off1.body.code, 'feature_disabled');
    const off2 = await t.propose('engineer', 'trigger_n8n', { destinationId: t.n8n.id }, off);
    assert.equal(off2.body.code, 'feature_disabled');
    assert.equal(await prisma.actionProposal.count({ where: { workspaceId: t.workspaceId } }), 0);
  });

  it('follows the role policy for proposing and approving each action', async () => {
    const t = await tenant();
    assert.equal(
      (await t.propose('viewer', 'rerun_validation', { ruleId: t.rule.id })).status,
      403,
    );
    assert.equal(
      (await t.propose('analyst', 'retry_import', { uploadId: t.failedUpload.id })).status,
      403,
    );
    assert.equal(
      (await t.propose('analyst', 'create_github_issue', { destinationId: t.github.id })).status,
      403,
    );
    const issue = await t.propose('engineer', 'create_github_issue', {
      destinationId: t.github.id,
    });
    assert.equal(issue.status, 201);
    assert.equal(issue.body.preview.leavesDataSentinel, true);
    // An engineer who did not propose it still cannot approve a GitHub issue.
    assert.equal(
      (await t.call('engineer2', 'POST', `/actions/${issue.body.id}/approve`)).status,
      403,
    );
    assert.equal(
      (await t.call('analyst', 'POST', `/actions/${issue.body.id}/approve`)).status,
      403,
    );
    const approved = await t.call('admin', 'POST', `/actions/${issue.body.id}/approve`, {
      note: 'ok',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.decidedByName !== null, true);
  });

  it('keeps proposer and approver apart while the workspace requires a second person', async () => {
    const t = await tenant();
    const mine = await t.propose('engineer', 'retry_import', { uploadId: t.failedUpload.id });
    assert.equal(mine.body.can.approve, false);
    const self = await t.call('engineer', 'POST', `/actions/${mine.body.id}/approve`);
    assert.equal(self.status, 409);
    assert.equal(self.body.code, 'self_approval');
    assert.equal(
      (await prisma.actionProposal.findUniqueOrThrow({ where: { id: mine.body.id } })).status,
      'proposed',
    );
    const other = await t.call('engineer2', 'POST', `/actions/${mine.body.id}/approve`);
    assert.equal(other.status, 200);

    // Only an owner can change the policy; then a proposer may approve their own.
    assert.equal(
      (await t.call('admin', 'PUT', '/action-policy', { requireSecondApprover: false })).status,
      403,
    );
    assert.equal(
      (await t.call('owner', 'PUT', '/action-policy', { requireSecondApprover: false })).status,
      200,
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'workspace.action_policy_changed', workspaceId: t.workspaceId },
    });
    const solo = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    assert.equal(solo.status, 201);
    const soloApproved = await t.call('engineer', 'POST', `/actions/${solo.body.id}/approve`);
    assert.equal(soloApproved.status, 200);
    const selfAllowed = await t.propose('engineer', 'send_notification', {
      destinationId: t.email.id,
    });
    assert.equal(selfAllowed.body.can.approve, true);
    assert.equal(
      (await t.call('engineer', 'POST', `/actions/${selfAllowed.body.id}/approve`)).status,
      200,
    );
    assert.equal(
      (await t.call('owner', 'PUT', '/action-policy', { requireSecondApprover: 'no' })).status,
      400,
    );
  });

  it('binds an approval to the exact payload hash with an expiry, and logs who did it', async () => {
    const t = await tenant();
    const p = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    const approved = await t.call('engineer', 'POST', `/actions/${p.body.id}/approve`);
    const row = await prisma.actionProposal.findUniqueOrThrow({ where: { id: p.body.id } });
    assert.equal(row.approvedPayloadHash, row.payloadHash);
    assert.equal(row.decidedByMembershipId, t.people.engineer!.membershipId);
    const left = row.approvalExpiresAt!.getTime() - Date.now();
    assert.ok(left > 55 * 60_000 && left <= 60 * 60_000);
    assert.deepEqual(
      approved.body.events.map((e) => e.type),
      ['proposed', 'approved'],
    );
    assert.equal(approved.body.events[1]?.actorName !== null, true);
    assert.equal((await t.call('engineer2', 'POST', `/actions/${p.body.id}/approve`)).status, 409);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'action.approved', workspaceId: t.workspaceId },
    });
  });

  it('rejects, cancels, and refuses decisions on what is already decided', async () => {
    const t = await tenant();
    const a = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    const rejected = await t.call('engineer', 'POST', `/actions/${a.body.id}/reject`, {
      note: 'not needed',
    });
    assert.equal(rejected.body.status, 'rejected');
    assert.equal((await t.call('engineer2', 'POST', `/actions/${a.body.id}/approve`)).status, 409);
    assert.equal((await t.call('analyst', 'POST', `/actions/${a.body.id}/cancel`)).status, 409);

    const b = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    assert.equal(b.body.can.cancel, true);
    const stranger = await t.call('viewer', 'POST', `/actions/${b.body.id}/cancel`);
    assert.equal(stranger.status, 403);
    const cancelled = await t.call('analyst', 'POST', `/actions/${b.body.id}/cancel`);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal((await t.call('engineer', 'POST', `/actions/${b.body.id}/approve`)).status, 409);
    const events = (await t.call('viewer', 'GET', `/incidents/${t.incident.id}/actions`)).text;
    assert.equal((JSON.parse(events) as unknown[]).length, 2);
  });

  it('lets nothing stale be approved or run: proposals and approvals expire', async () => {
    const t = await tenant();
    const old = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    await prisma.actionProposal.update({
      where: { id: old.body.id },
      data: { proposalExpiresAt: new Date(Date.now() - 1000) },
    });
    const late = await t.call('engineer', 'POST', `/actions/${old.body.id}/approve`);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'action_expired');
    assert.equal(
      (await prisma.actionProposal.findUniqueOrThrow({ where: { id: old.body.id } })).status,
      'expired',
    );

    const fresh = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    await t.call('engineer', 'POST', `/actions/${fresh.body.id}/approve`);
    await prisma.$executeRaw`UPDATE action_proposals SET approval_expires_at = now() - interval '1 second' WHERE id = ${fresh.body.id}::uuid`;
    const list = JSON.parse(
      (await t.call('viewer', 'GET', `/incidents/${t.incident.id}/actions`)).text,
    ) as Action[];
    assert.equal(list.find((a) => a.id === fresh.body.id)?.status, 'expired');
    assert.equal(
      list.find((a) => a.id === fresh.body.id)?.events.some((e) => e.type === 'expired'),
      true,
    );
  });

  it('freezes what was proposed and the finished state at the database', async () => {
    const t = await tenant();
    const p = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    await assert.rejects(
      prisma.actionProposal.update({
        where: { id: p.body.id },
        data: { payload: { ruleId: t.foreignRule.id } },
      }),
      /cannot be changed/,
    );
    await assert.rejects(
      prisma.actionProposal.update({
        where: { id: p.body.id },
        data: { payloadHash: 'b'.repeat(64) },
      }),
      /cannot be changed/,
    );
    // Approved needs its hash, approver, and expiry (a status cannot be faked).
    await assert.rejects(
      prisma.actionProposal.update({ where: { id: p.body.id }, data: { status: 'approved' } }),
      /action_proposals_status_check/,
    );
    await t.call('analyst', 'POST', `/actions/${p.body.id}/cancel`);
    await assert.rejects(
      prisma.actionProposal.update({ where: { id: p.body.id }, data: { status: 'proposed' } }),
      /finished action cannot be changed/,
    );
    const event = await prisma.actionEvent.findFirstOrThrow({ where: { actionId: p.body.id } });
    await assert.rejects(
      prisma.actionEvent.update({ where: { id: event.id }, data: { type: 'forged' } }),
      /append-only/,
    );
  });

  it('shows what can be proposed by name, shows buttons only to who may use them, and isolates workspaces', async () => {
    const t = await tenant();
    const other = await tenant();
    const options = (await t.call('analyst', 'GET', `/incidents/${t.incident.id}/actions/options`))
      .body as unknown as Options;
    assert.deepEqual(
      options.rules.map((r) => r.name),
      ['Orders are fresh'],
    );
    assert.deepEqual(
      options.uploads.map((u) => u.filename),
      ['orders.csv'],
    );
    assert.deepEqual(options.destinations.map((d) => d.type).sort(), ['email', 'github', 'n8n']);
    assert.equal(JSON.stringify(options).includes('ciphertext'), false);
    const offOptions = (
      await t.call('analyst', 'GET', `/incidents/${t.incident.id}/actions/options`, undefined, off)
    ).body as unknown as Options;
    assert.deepEqual(
      offOptions.destinations.map((d) => d.type),
      ['email'],
    );
    assert.equal(
      (await t.call('viewer', 'GET', `/incidents/${t.incident.id}/actions/options`)).status,
      403,
    );

    const p = await t.propose('analyst', 'rerun_validation', { ruleId: t.rule.id });
    const asViewer = JSON.parse(
      (await t.call('viewer', 'GET', `/incidents/${t.incident.id}/actions`)).text,
    ) as Action[];
    assert.deepEqual(asViewer[0]?.can, { approve: false, reject: false, cancel: false });
    const asEngineer = JSON.parse(
      (await t.call('engineer', 'GET', `/incidents/${t.incident.id}/actions`)).text,
    ) as Action[];
    assert.deepEqual(asEngineer[0]?.can, { approve: true, reject: true, cancel: true });

    // Another workspace's admin sees and can do nothing here.
    const foreign = await fetch(
      `${on.url}/workspaces/${other.workspaceId}/actions/${p.body.id}/approve`,
      {
        method: 'POST',
        headers: {
          cookie: await other.people.admin!.who(on),
          origin: WEB,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(foreign.status, 404);
    const crossIncident = await fetch(
      `${on.url}/workspaces/${other.workspaceId}/incidents/${t.incident.id}/actions`,
      { headers: { cookie: await other.people.admin!.who(on), origin: WEB } },
    );
    assert.equal(crossIncident.status, 404);
  });
});
