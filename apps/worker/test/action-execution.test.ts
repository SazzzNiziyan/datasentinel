import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import {
  claimAction,
  hashAction,
  processAction,
  type ActionDeps,
  type ClaimedAction,
} from '../src/actions/execute.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

describe('recovery action execution', { skip }, () => {
  let workspaces: string[] = [];
  let users: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    workspaces = [];
    users = [];
  });
  after(() => prisma.$disconnect());

  async function fixture(options: { requireSecondApprover?: boolean } = {}) {
    const w = await prisma.workspace.create({
      data: {
        name: 'X',
        slug: `x-${randomUUID()}`,
        requireSecondApprover: options.requireSecondApprover ?? true,
      },
    });
    workspaces.push(w.id);
    const member = async (role: 'analyst' | 'engineer' | 'admin' | 'viewer') => {
      const user = await prisma.user.create({
        data: { email: `ax-${randomUUID()}@test.example`, displayName: role },
      });
      users.push(user.id);
      return prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    };
    const proposer = await member('engineer');
    const approver = await member('admin');
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
    });
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
    const upload = await prisma.upload.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: dataset.id,
        objectKey: `k-${randomUUID()}`,
        filename: 'orders.csv',
        sizeBytes: 10,
        checksumSha256: 'a'.repeat(64),
        status: 'failed',
        error: { code: 'parse_failed' },
        createdByMembershipId: proposer.id,
        uploadUrlExpiresAt: new Date(Date.now() + 60_000),
        retainUntil: new Date(Date.now() + 86_400_000),
      },
    });
    const mkDest = (type: 'email' | 'github' | 'n8n', status: 'active' | 'paused' = 'active') =>
      prisma.destination.create({
        data: {
          workspaceId: w.id,
          name: `${type}-${randomUUID()}`,
          type,
          status,
          events: ['incident_opened'],
          settings: type === 'email' ? { recipients: ['a@x.io'] } : {},
          ...(type === 'email' ? {} : { ciphertext: new Uint8Array([1]), keyVersion: 1 }),
        },
      });
    const email = await mkDest('email');
    const github = await mkDest('github');
    const n8n = await mkDest('n8n');

    const enqueued: { name: string; jobId: string }[] = [];
    const parses: { uploadId: string; jobId: string }[] = [];
    const behaviour = { failEnqueue: false };
    const deps: ActionDeps = {
      prisma,
      enqueue: (jobs) => {
        if (behaviour.failEnqueue) return Promise.reject(new Error('redis down hunter2'));
        enqueued.push(...jobs.map((j) => ({ name: j.name, jobId: j.jobId })));
        return Promise.resolve();
      },
      enqueueParse: (data, jobId) => {
        parses.push({ uploadId: data.uploadId, jobId });
        return Promise.resolve();
      },
      features: { github: true, n8n: true },
    };

    /** An action in the approved state, as the API leaves it. */
    const approved = async (
      type: string,
      payload: Record<string, string>,
      over: Partial<{
        proposedBy: string;
        decidedBy: string;
        approvalExpiresAt: Date;
        approvedPayloadHash: string;
        payloadHash: string;
        status: 'approved' | 'proposed';
      }> = {},
    ) => {
      const hash = hashAction({ type, workspaceId: w.id, incidentId: incident.id, payload });
      const status = over.status ?? 'approved';
      return prisma.actionProposal.create({
        data: {
          workspaceId: w.id,
          incidentId: incident.id,
          type,
          payload,
          payloadHash: over.payloadHash ?? hash,
          status,
          proposedByMembershipId: over.proposedBy ?? proposer.id,
          proposalExpiresAt: new Date(Date.now() + 86_400_000),
          ...(status === 'approved'
            ? {
                approvedPayloadHash: over.approvedPayloadHash ?? hash,
                approvalExpiresAt: over.approvalExpiresAt ?? new Date(Date.now() + 3_600_000),
                decidedByMembershipId: over.decidedBy ?? approver.id,
                decidedAt: new Date(),
                nextAttemptAt: new Date(Date.now() - 1000),
              }
            : {}),
        },
      });
    };
    /** Claims and processes one action the way the service does. */
    const run = async (id: string, now = new Date()) => {
      const claimed = await claimAction(prisma, new Date(now.getTime() + 1), w.id);
      assert.equal(claimed?.id, id);
      await processAction(deps, claimed, new Date(now.getTime() + 1));
    };
    const reload = (id: string) => prisma.actionProposal.findUniqueOrThrow({ where: { id } });
    const events = async (id: string) =>
      (
        await prisma.actionEvent.findMany({
          where: { actionId: id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((e) => e.type);
    return {
      workspaceId: w.id,
      proposer,
      approver,
      incident,
      rule,
      upload,
      email,
      github,
      n8n,
      deps,
      behaviour,
      enqueued,
      parses,
      approved,
      run,
      reload,
      events,
      member,
    };
  }

  it('reruns a validation once, with the approval and the result attributable', async () => {
    const f = await fixture();
    const a = await f.approved('rerun_validation', { ruleId: f.rule.id });
    await f.run(a.id);
    const row = await f.reload(a.id);
    assert.equal(row.status, 'succeeded');
    assert.ok(row.finishedAt);
    const checkRunId = (row.output as { checkRunId: string }).checkRunId;
    const check = await prisma.checkRun.findUniqueOrThrow({ where: { id: checkRunId } });
    assert.equal(check.trigger, 'manual');
    assert.equal(check.idempotencyKey, `action:${a.id}`);
    assert.deepEqual(f.enqueued, [{ name: 'run-check', jobId: `check-${checkRunId}` }]);
    assert.deepEqual(await f.events(a.id), ['started', 'succeeded']);
    const done = await prisma.actionEvent.findFirstOrThrow({
      where: { actionId: a.id, type: 'succeeded' },
    });
    assert.equal(done.actorType, 'system');
    assert.deepEqual(
      [
        (done.data as Record<string, string>).proposedBy,
        (done.data as Record<string, string>).approvedBy,
      ],
      [f.proposer.id, f.approver.id],
    );
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'action.succeeded', workspaceId: f.workspaceId, actorType: 'system' },
    });
    // Running the same action again (a crash and redelivery) makes no second check.
    await processAction(f.deps, { ...(await claimLike(a.id)), attempts: 2 });
    assert.equal(await prisma.checkRun.count({ where: { workspaceId: f.workspaceId } }), 1);
  });

  /** The claim shape for an action already in the table. */
  async function claimLike(id: string): Promise<ClaimedAction> {
    const r = await prisma.actionProposal.findUniqueOrThrow({ where: { id } });
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      incidentId: r.incidentId,
      type: r.type,
      payload: r.payload,
      payloadHash: r.payloadHash,
      approvedPayloadHash: r.approvedPayloadHash,
      approvalExpiresAt: r.approvalExpiresAt,
      proposedBy: r.proposedByMembershipId,
      decidedBy: r.decidedByMembershipId,
      attempts: r.attempts,
    };
  }

  it('queues a failed import again under a job id of its own', async () => {
    const f = await fixture();
    const a = await f.approved('retry_import', { uploadId: f.upload.id });
    await f.run(a.id);
    assert.equal((await f.reload(a.id)).status, 'succeeded');
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: f.upload.id } });
    assert.equal(upload.status, 'queued');
    assert.equal(upload.error, null);
    assert.deepEqual(f.parses, [{ uploadId: f.upload.id, jobId: `${f.upload.id}-retry-${a.id}` }]);
    assert.deepEqual((await f.reload(a.id)).output, { uploadId: f.upload.id });
  });

  it('sends a notice, a GitHub issue, and an n8n call as one safe delivery each, once', async () => {
    const f = await fixture();
    const cases: [string, string, string][] = [
      ['send_notification', f.email.id, 'email'],
      ['create_github_issue', f.github.id, 'github'],
      ['trigger_n8n', f.n8n.id, 'n8n'],
    ];
    for (const [type, destinationId] of cases) {
      const a = await f.approved(type, { destinationId });
      await f.run(a.id);
      const row = await f.reload(a.id);
      assert.equal(row.status, 'succeeded', type);
      const deliveries = await prisma.notificationDelivery.findMany({ where: { destinationId } });
      assert.equal(deliveries.length, 1, type);
      assert.equal(deliveries[0]?.kind, 'incident_notice');
      assert.equal(deliveries[0]?.status, 'pending');
      assert.equal(deliveries[0]?.incidentEventId, a.id);
      assert.deepEqual(deliveries[0]?.payload, {
        title: 'Orders are fresh failed on orders',
        severity: 'critical',
        datasetName: 'orders',
      });
      assert.deepEqual(row.output, { deliveryId: deliveries[0]?.id });
      await processAction(f.deps, { ...(await claimLike(a.id)), attempts: 2 });
      assert.equal(await prisma.notificationDelivery.count({ where: { destinationId } }), 1);
    }
  });

  it('fails visibly when the target is gone, the wrong kind, paused, or a feature is off', async () => {
    const f = await fixture();
    const paused = await prisma.destination.create({
      data: {
        workspaceId: f.workspaceId,
        name: 'paused',
        type: 'email',
        status: 'paused',
        events: ['incident_opened'],
        settings: { recipients: ['a@x.io'] },
      },
    });
    const cases: [string, Record<string, string>][] = [
      ['send_notification', { destinationId: f.github.id }],
      ['send_notification', { destinationId: paused.id }],
      ['send_notification', { destinationId: randomUUID() }],
      ['create_github_issue', { destinationId: f.email.id }],
      ['rerun_validation', { ruleId: randomUUID() }],
      ['retry_import', { uploadId: randomUUID() }],
    ];
    for (const [type, payload] of cases) {
      const a = await f.approved(type, payload);
      await f.run(a.id);
      const row = await f.reload(a.id);
      assert.equal(row.status, 'failed', `${type} ${JSON.stringify(payload)}`);
      assert.equal(row.failureCode, 'target_unavailable');
    }
    f.deps.features.github = false;
    const off = await f.approved('create_github_issue', { destinationId: f.github.id });
    await f.run(off.id);
    assert.equal((await f.reload(off.id)).failureCode, 'target_unavailable');
    assert.equal(
      await prisma.notificationDelivery.count({ where: { workspaceId: f.workspaceId } }),
      0,
    );
  });

  it('refuses at run time when the approval is not bound to this exact payload', async () => {
    const f = await fixture();
    const wrongApproval = await f.approved(
      'rerun_validation',
      { ruleId: f.rule.id },
      { approvedPayloadHash: 'c'.repeat(64) },
    );
    await f.run(wrongApproval.id);
    assert.equal((await f.reload(wrongApproval.id)).failureCode, 'payload_changed');
    const wrongHash = await f.approved(
      'retry_import',
      { uploadId: f.upload.id },
      { payloadHash: 'd'.repeat(64), approvedPayloadHash: 'd'.repeat(64) },
    );
    await f.run(wrongHash.id);
    assert.equal((await f.reload(wrongHash.id)).failureCode, 'payload_changed');
    assert.equal(await prisma.checkRun.count({ where: { workspaceId: f.workspaceId } }), 0);
    assert.equal(
      (await prisma.upload.findUniqueOrThrow({ where: { id: f.upload.id } })).status,
      'failed',
    );
    assert.deepEqual(f.enqueued.concat(f.parses as never[]), []);
  });

  it('lets an expired approval run nothing and ends it as expired', async () => {
    const f = await fixture();
    const a = await f.approved(
      'rerun_validation',
      { ruleId: f.rule.id },
      { approvalExpiresAt: new Date(Date.now() + 2_000) },
    );
    const later = new Date(Date.now() + 10 * 60_000);
    const claimed = await claimAction(prisma, later, f.workspaceId);
    await processAction(f.deps, claimed as ClaimedAction, later);
    const row = await f.reload(a.id);
    assert.equal(row.status, 'expired');
    assert.equal(row.failureCode, 'approval_expired');
    assert.equal(await prisma.checkRun.count({ where: { workspaceId: f.workspaceId } }), 0);
    assert.equal(f.enqueued.length, 0);
    assert.deepEqual(await f.events(a.id), ['started', 'expired']);
  });

  it('checks permission again: a demoted or removed approver or proposer stops it', async () => {
    const f = await fixture();
    const demoted = await f.approved('create_github_issue', { destinationId: f.github.id });
    await prisma.membership.update({ where: { id: f.approver.id }, data: { role: 'engineer' } });
    await f.run(demoted.id);
    assert.equal((await f.reload(demoted.id)).failureCode, 'permission_lost');

    const removed = await f.approved(
      'send_notification',
      { destinationId: f.email.id },
      { decidedBy: (await f.member('engineer')).id },
    );
    const approverRow = (
      await prisma.actionProposal.findUniqueOrThrow({ where: { id: removed.id } })
    ).decidedByMembershipId!;
    await prisma.membership.update({ where: { id: approverRow }, data: { status: 'removed' } });
    await f.run(removed.id);
    assert.equal((await f.reload(removed.id)).failureCode, 'permission_lost');

    const analyst = await f.member('analyst');
    const tooLow = await f.approved(
      'retry_import',
      { uploadId: f.upload.id },
      { proposedBy: analyst.id, decidedBy: (await f.member('engineer')).id },
    );
    await f.run(tooLow.id);
    assert.equal((await f.reload(tooLow.id)).failureCode, 'permission_lost');
    assert.equal(
      await prisma.notificationDelivery.count({ where: { workspaceId: f.workspaceId } }),
      0,
    );
  });

  it('checks the second-person rule again, and honours a workspace that turned it off', async () => {
    const f = await fixture();
    const self = await f.approved(
      'rerun_validation',
      { ruleId: f.rule.id },
      { decidedBy: f.proposer.id },
    );
    await f.run(self.id);
    assert.equal((await f.reload(self.id)).failureCode, 'self_approval');
    await prisma.workspace.update({
      where: { id: f.workspaceId },
      data: { requireSecondApprover: false },
    });
    const allowed = await f.approved(
      'send_notification',
      { destinationId: f.email.id },
      { decidedBy: f.proposer.id },
    );
    await f.run(allowed.id);
    assert.equal((await f.reload(allowed.id)).status, 'succeeded');
  });

  it('claims only approved, due actions, once, and reclaims a dead worker’s', async () => {
    const f = await fixture();
    const waiting = await f.approved(
      'rerun_validation',
      { ruleId: f.rule.id },
      { status: 'proposed' },
    );
    assert.equal(await claimAction(prisma, new Date(Date.now() + 5_000), f.workspaceId), null);
    assert.equal((await f.reload(waiting.id)).status, 'proposed');

    const a = await f.approved('send_notification', { destinationId: f.email.id });
    await prisma.actionProposal.update({
      where: { id: a.id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    assert.equal(await claimAction(prisma, new Date(), f.workspaceId), null, 'not due yet');
    const due = new Date(Date.now() + 120_000);
    const claims = await Promise.all([
      claimAction(prisma, due, f.workspaceId),
      claimAction(prisma, due, f.workspaceId),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await f.reload(a.id)).status, 'running');
    assert.equal(await claimAction(prisma, due, f.workspaceId), null);
    const reclaimed = await claimAction(
      prisma,
      new Date(due.getTime() + 11 * 60_000),
      f.workspaceId,
    );
    assert.equal(reclaimed?.id, a.id);
    assert.equal(reclaimed?.attempts, 2);
    // Claimed too often without finishing: given up on.
    await processAction(f.deps, { ...reclaimed, attempts: 4 });
    assert.equal((await f.reload(a.id)).failureCode, 'worker_interrupted');
  });

  it('retries a transient failure while the approval holds, then gives up, without leaking', async () => {
    const f = await fixture();
    f.behaviour.failEnqueue = true;
    const a = await f.approved('rerun_validation', { ruleId: f.rule.id });
    const t0 = new Date();
    await f.run(a.id, t0);
    let row = await f.reload(a.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.attempts, 1);
    assert.ok(row.nextAttemptAt!.getTime() > t0.getTime() + 20_000);
    assert.deepEqual(await f.events(a.id), ['started', 'retry_scheduled']);

    for (const minutes of [5, 10]) {
      const claimed = await claimAction(
        prisma,
        new Date(t0.getTime() + minutes * 60_000),
        f.workspaceId,
      );
      assert.ok(claimed, `claim at +${minutes} min`);
      await processAction(f.deps, claimed, new Date(t0.getTime() + minutes * 60_000));
    }
    row = await f.reload(a.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failureCode, 'execution_failed');
    assert.equal(row.attempts, 3);
    const stored = JSON.stringify([
      row,
      await prisma.actionEvent.findMany({ where: { actionId: a.id } }),
    ]);
    assert.equal(stored.includes('hunter2'), false, 'provider and queue text is never stored');
  });

  it('keeps the executor away from monitored sources by construction', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'actions');
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 2);
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        assert.equal(
          /connectors|^pg$|postgres|^node:(net|tls|http|https|dns|child_process)$|undici|axios/.test(
            spec,
          ),
          false,
          `${file} must not import ${spec}`,
        );
      }
      assert.equal(
        /\bfetch\(|\$queryRawUnsafe|\$executeRawUnsafe|new Client\(/.test(source),
        false,
        file,
      );
    }
  });
});
