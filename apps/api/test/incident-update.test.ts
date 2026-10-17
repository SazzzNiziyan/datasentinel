import {
  canTransitionIncident,
  incidentStatuses,
  incidentTransitions,
  UpdateIncidentRequest,
} from '@datasentinel/contracts';
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

describe('incident transitions', () => {
  it('allows only the documented moves', () => {
    assert.equal(canTransitionIncident('open', 'acknowledged'), true);
    assert.equal(canTransitionIncident('reopened', 'investigating'), true);
    assert.equal(canTransitionIncident('acknowledged', 'investigating'), true);
    assert.equal(canTransitionIncident('investigating', 'resolved'), true);
    assert.equal(canTransitionIncident('resolved', 'reopened'), true);
    assert.equal(canTransitionIncident('investigating', 'acknowledged'), false);
    assert.equal(canTransitionIncident('open', 'reopened'), false);
    assert.equal(canTransitionIncident('resolved', 'acknowledged'), false);
    for (const status of incidentStatuses) {
      assert.equal(canTransitionIncident(status, 'open'), false, `${status} -> open`);
      assert.equal(canTransitionIncident(status, status), false, `${status} -> ${status}`);
      assert.ok(incidentTransitions[status].length > 0, status);
    }
  });

  it('asks for the note, the reason, and the status the person saw', () => {
    const issue = (body: unknown) => {
      const r = UpdateIncidentRequest.safeParse(body);
      return r.success ? null : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    assert.deepEqual(issue({}), ['status: Send a status change, an assignee, or both.']);
    assert.deepEqual(issue({ status: 'acknowledged' }), [
      'expectedStatus: Send the status you saw.',
    ]);
    assert.deepEqual(issue({ status: 'resolved', expectedStatus: 'open' }), [
      'resolutionNote: A resolution note is required to resolve.',
    ]);
    assert.deepEqual(issue({ status: 'resolved', expectedStatus: 'open', resolutionNote: '   ' }), [
      'resolutionNote: Too small: expected string to have >=1 characters',
    ]);
    assert.deepEqual(issue({ status: 'reopened', expectedStatus: 'resolved' }), [
      'reason: A reason is required to reopen.',
    ]);
    assert.deepEqual(issue({ status: 'acknowledged', expectedStatus: 'open', reason: 'x' }), [
      'reason: A reason belongs only with reopening.',
    ]);
    assert.equal(issue({ assignedMembershipId: null }), null);
    assert.equal(
      issue({ status: 'resolved', expectedStatus: 'open', resolutionNote: 'fixed' }),
      null,
    );
    assert.notEqual(issue({ status: 'acknowledged', expectedStatus: 'open', extra: 1 }), null);
  });
});

type Detail = {
  status: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  assigneeName: string | null;
  history: {
    type: string;
    actorName: string | null;
    fromStatus: string | null;
    toStatus: string | null;
    details: Record<string, unknown>;
  }[];
  code?: string;
  detail?: string;
};

describe('incident updates API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function member(workspaceId: string, role: 'viewer' | 'analyst' | 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const membership = await prisma.membership.create({
      data: { workspaceId, userId: user.id, role },
    });
    // Signed in on first use: the sign-in rate limit is shared by the suite.
    let cached: string | undefined;
    const cookie = async () => (cached ??= await signInCookie(url, user.email));
    return { user, membership, cookie };
  }

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'U', slug: `u-${randomUUID()}` } });
    workspaces.push(w.id);
    const engineer = await member(w.id, 'engineer');
    const analyst = await member(w.id, 'analyst');
    const viewer = await member(w.id, 'viewer');
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
      },
    });
    const incident = (status: 'open' | 'resolved' = 'open', resolvedMinutesAgo = 1) =>
      prisma.incident.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: dataset.id,
          ruleId: rule.id,
          dedupeKey: `rule:${rule.id}`,
          title: 'Orders are fresh failed on orders',
          severity: 'critical',
          status,
          lastFailureAt: new Date(),
          resolvedAt:
            status === 'resolved' ? new Date(Date.now() - resolvedMinutesAgo * 60_000) : null,
        },
      });
    const patch = async (
      who: { cookie: () => Promise<string> },
      id: string,
      body: unknown,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/incidents/${id}`, {
        method: 'PATCH',
        headers: { cookie: await who.cookie(), origin: WEB, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Detail };
    };
    return { workspaceId: w.id, engineer, analyst, viewer, incident, patch };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('acknowledges, investigates, and resolves with a required note, recording who did it', async () => {
    const t = await tenant();
    const inc = await t.incident();
    const ack = await t.patch(t.engineer, inc.id, {
      status: 'acknowledged',
      expectedStatus: 'open',
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'acknowledged');
    const inv = await t.patch(t.engineer, inc.id, {
      status: 'investigating',
      expectedStatus: 'acknowledged',
    });
    assert.equal(inv.body.status, 'investigating');

    const noNote = await t.patch(t.engineer, inc.id, {
      status: 'resolved',
      expectedStatus: 'investigating',
    });
    assert.equal(noNote.status, 400);
    assert.match(String(noNote.body.detail), /resolutionNote: A resolution note is required/);
    assert.equal(
      (await prisma.incident.findUniqueOrThrow({ where: { id: inc.id } })).status,
      'investigating',
    );

    const done = await t.patch(t.engineer, inc.id, {
      status: 'resolved',
      expectedStatus: 'investigating',
      resolutionNote: 'Upstream export was restarted.',
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'resolved');
    assert.ok(done.body.resolvedAt);
    assert.equal(done.body.resolutionNote, 'Upstream export was restarted.');
    assert.deepEqual(
      done.body.history.map((h) => [h.type, h.fromStatus, h.toStatus, h.actorName]),
      [
        ['acknowledged', 'open', 'acknowledged', t.engineer.user.displayName],
        ['investigating', 'acknowledged', 'investigating', t.engineer.user.displayName],
        ['resolved', 'investigating', 'resolved', t.engineer.user.displayName],
      ],
    );
    assert.deepEqual(done.body.history[2]?.details, {
      resolutionNote: 'Upstream export was restarted.',
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'incident.updated', targetId: inc.id },
    });
  });

  it('refuses illegal moves and stale views', async () => {
    const t = await tenant();
    const inc = await t.incident();
    const illegal = await t.patch(t.engineer, inc.id, {
      status: 'reopened',
      expectedStatus: 'open',
      reason: 'x',
    });
    assert.equal(illegal.status, 409);
    assert.equal(illegal.body.code, 'invalid_transition');
    const stale = await t.patch(t.engineer, inc.id, {
      status: 'acknowledged',
      expectedStatus: 'investigating',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'incident_changed');
    await t.patch(t.engineer, inc.id, {
      status: 'resolved',
      expectedStatus: 'open',
      resolutionNote: 'done',
    });
    const backwards = await t.patch(t.engineer, inc.id, {
      status: 'acknowledged',
      expectedStatus: 'resolved',
    });
    assert.equal(backwards.body.code, 'invalid_transition');
  });

  it('reopens with a reason and keeps the resolution notes', async () => {
    const t = await tenant();
    const inc = await t.incident();
    await t.patch(t.engineer, inc.id, {
      status: 'resolved',
      expectedStatus: 'open',
      resolutionNote: 'first fix',
    });
    const noReason = await t.patch(t.engineer, inc.id, {
      status: 'reopened',
      expectedStatus: 'resolved',
    });
    assert.equal(noReason.status, 400);
    const reopened = await t.patch(t.engineer, inc.id, {
      status: 'reopened',
      expectedStatus: 'resolved',
      reason: 'It broke again this morning.',
    });
    assert.equal(reopened.body.status, 'reopened');
    assert.equal(reopened.body.resolvedAt, null);
    assert.equal(reopened.body.resolutionNote, 'first fix');
    await t.patch(t.engineer, inc.id, {
      status: 'resolved',
      expectedStatus: 'reopened',
      resolutionNote: 'second fix',
    });
    const last = await t.patch(t.engineer, inc.id, { assignedMembershipId: null });
    assert.deepEqual(
      last.body.history.filter((h) => h.type === 'resolved').map((h) => h.details.resolutionNote),
      ['first fix', 'second fix'],
    );
    assert.deepEqual(last.body.history.find((h) => h.type === 'reopened')?.details, {
      reason: 'It broke again this morning.',
      automatic: false,
    });
    assert.equal(last.body.resolutionNote, 'second fix');
  });

  it('will not reopen an old incident while a newer one is open for the same rule', async () => {
    const t = await tenant();
    const old = await t.incident('resolved', 3000);
    await prisma.incident.update({
      where: { id: old.id },
      data: { dedupeKey: `${old.dedupeKey}:old` },
    });
    await t.incident('open');
    await prisma.incident
      .update({ where: { id: old.id }, data: { dedupeKey: old.dedupeKey } })
      .catch(() => undefined);
    const res = await t.patch(t.engineer, old.id, {
      status: 'reopened',
      expectedStatus: 'resolved',
      reason: 'again',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'incident_exists');
    assert.equal(
      (await prisma.incident.findUniqueOrThrow({ where: { id: old.id } })).status,
      'resolved',
    );
  });

  it('assigns active members only, and records who was assigned', async () => {
    const t = await tenant();
    const inc = await t.incident();
    const other = await tenant();
    const assigned = await t.patch(t.engineer, inc.id, {
      assignedMembershipId: t.analyst.membership.id,
    });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.assigneeName, t.analyst.user.displayName);
    assert.deepEqual(assigned.body.history.at(-1)?.details, {
      fromMembershipId: null,
      fromName: null,
      toMembershipId: t.analyst.membership.id,
      toName: t.analyst.user.displayName,
    });
    const foreign = await t.patch(t.engineer, inc.id, {
      assignedMembershipId: other.engineer.membership.id,
    });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.code, 'invalid_assignee');
    const again = await t.patch(t.engineer, inc.id, {
      assignedMembershipId: t.analyst.membership.id,
    });
    assert.equal(again.body.history.length, 1);
    const none = await t.patch(t.engineer, inc.id, { assignedMembershipId: null });
    assert.equal(none.body.assigneeName, null);
    assert.equal(none.body.history.at(-1)?.type, 'unassigned');
  });

  it('is for engineers and above, and stays inside the workspace', async () => {
    const t = await tenant();
    const other = await tenant();
    const inc = await t.incident();
    const body = { status: 'acknowledged', expectedStatus: 'open' };
    assert.equal((await t.patch(t.analyst, inc.id, body)).status, 403);
    assert.equal((await t.patch(t.viewer, inc.id, body)).status, 403);
    assert.equal((await t.patch(other.engineer, inc.id, body, other.workspaceId)).status, 404);
    assert.equal((await t.patch(t.engineer, randomUUID(), body)).status, 404);
    assert.equal((await t.patch(t.engineer, 'not-a-uuid', body)).status, 404);
  });
});
