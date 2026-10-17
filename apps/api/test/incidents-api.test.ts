import { compareIncidentsByPriority, type IncidentStatus } from '@datasentinel/contracts';
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

type Row = {
  id: string;
  title: string;
  severity: string;
  status: string;
  datasetName: string;
  assigneeName: string | null;
};
type Page = { incidents: Row[]; total: number; nextOffset: number | null };

const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0) + n * 60_000);

describe('incident priority order', () => {
  const item = (
    id: string,
    severity: 'critical' | 'warning' | 'info',
    status: IncidentStatus,
    minute: number,
  ) => ({ id, severity, status, lastFailureAt: at(minute) });

  it('sorts by severity, then status group, then newest failure, then ID', () => {
    const sorted = [
      item('a-warning-open', 'warning', 'open', 50),
      item('b-critical-resolved', 'critical', 'resolved', 90),
      item('c-critical-acknowledged-new', 'critical', 'acknowledged', 80),
      item('d-critical-open-old', 'critical', 'open', 10),
      item('e-critical-reopened-new', 'critical', 'reopened', 70),
      item('f-info-open', 'info', 'open', 99),
      item('g-critical-investigating-old', 'critical', 'investigating', 5),
    ].sort(compareIncidentsByPriority);
    assert.deepEqual(
      sorted.map((i) => i.id),
      [
        'e-critical-reopened-new',
        'd-critical-open-old',
        'c-critical-acknowledged-new',
        'g-critical-investigating-old',
        'b-critical-resolved',
        'a-warning-open',
        'f-info-open',
      ],
    );
  });

  it('breaks complete ties by ID, higher first, so the order is stable', () => {
    const [first, second] = [
      item('a', 'critical', 'open', 1),
      item('b', 'critical', 'open', 1),
    ].sort(compareIncidentsByPriority);
    assert.deepEqual([first?.id, second?.id], ['b', 'a']);
  });
});

describe('incidents API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant(role: 'viewer' | 'engineer' = 'viewer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'I', slug: `i-${randomUUID()}` } });
    workspaces.push(w.id);
    const membership = await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role },
    });
    const source = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'csv', type: 'csv' },
    });
    const dataset = (name: string) =>
      prisma.dataset.create({
        data: { workspaceId: w.id, sourceId: source.id, stableKey: name, name },
      });
    const orders = await dataset('orders');
    const rule = await prisma.qualityRule.create({
      data: {
        workspaceId: w.id,
        sourceId: source.id,
        datasetId: orders.id,
        name: 'r',
        type: 'freshness',
        severity: 'critical',
        currentVersion: 1,
      },
    });
    let n = 0;
    const incident = (
      title: string,
      over: {
        severity?: 'critical' | 'warning' | 'info';
        status?: IncidentStatus;
        minute?: number;
        datasetId?: string;
        assignedMembershipId?: string;
      } = {},
    ) =>
      prisma.incident.create({
        data: {
          workspaceId: w.id,
          sourceId: source.id,
          datasetId: over.datasetId ?? orders.id,
          ruleId: rule.id,
          dedupeKey: `rule:${rule.id}:${(n += 1)}`,
          title,
          severity: over.severity ?? 'critical',
          status: over.status ?? 'open',
          assignedMembershipId: over.assignedMembershipId ?? null,
          lastFailureAt: at(over.minute ?? n),
          resolvedAt: over.status === 'resolved' ? at(over.minute ?? n) : null,
        },
      });
    const cookie = await signInCookie(url, user.email);
    const list = async (query = '') => {
      const res = await fetch(`${url}/workspaces/${w.id}/incidents${query}`, {
        headers: { cookie, origin: WEB },
      });
      return { status: res.status, body: (await res.json()) as Page };
    };
    const titles = async (query = '') => (await list(query)).body.incidents.map((i) => i.title);
    return { workspaceId: w.id, user, membership, orders, dataset, incident, list, titles };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lists by priority by default, and by recency on request, for any member', async () => {
    const t = await tenant();
    await t.incident('warning open', { severity: 'warning', minute: 50 });
    await t.incident('critical resolved', { status: 'resolved', minute: 90 });
    await t.incident('critical open old', { minute: 10 });
    await t.incident('critical reopened new', { status: 'reopened', minute: 70 });
    assert.deepEqual(await t.titles(), [
      'critical reopened new',
      'critical open old',
      'critical resolved',
      'warning open',
    ]);
    assert.deepEqual(await t.titles('?sort=recent'), [
      'critical resolved',
      'critical reopened new',
      'warning open',
      'critical open old',
    ]);
    const first = (await t.list()).body.incidents[0];
    assert.equal(first?.datasetName, 'orders');
    assert.equal(first?.assigneeName, null);
  });

  it('filters by status, severity, dataset, assignee, and time', async () => {
    const t = await tenant('engineer');
    const other = await t.dataset('customers');
    await t.incident('open', { minute: 10 });
    await t.incident('acknowledged mine', {
      status: 'acknowledged',
      minute: 20,
      assignedMembershipId: t.membership.id,
    });
    await t.incident('resolved', { status: 'resolved', minute: 30 });
    await t.incident('warning customers', { severity: 'warning', datasetId: other.id, minute: 40 });

    assert.deepEqual(await t.titles('?status=active&sort=recent'), [
      'warning customers',
      'acknowledged mine',
      'open',
    ]);
    assert.deepEqual(await t.titles('?status=resolved'), ['resolved']);
    assert.deepEqual(await t.titles('?severity=warning'), ['warning customers']);
    assert.deepEqual(await t.titles(`?datasetId=${other.id}`), ['warning customers']);
    assert.deepEqual(await t.titles('?assignee=me'), ['acknowledged mine']);
    assert.deepEqual(await t.titles(`?assignee=${t.membership.id}`), ['acknowledged mine']);
    assert.deepEqual(await t.titles('?assignee=unassigned&sort=recent'), [
      'warning customers',
      'resolved',
      'open',
    ]);
    assert.deepEqual(
      await t.titles(`?from=${at(20).toISOString()}&to=${at(30).toISOString()}&sort=recent`),
      ['resolved', 'acknowledged mine'],
    );
    const named = (await t.list('?assignee=me')).body.incidents[0];
    assert.equal(named?.assigneeName, t.user.displayName);
  });

  it('pages by offset with a total, and refuses bad filters', async () => {
    const t = await tenant();
    for (let i = 1; i <= 5; i += 1) await t.incident(`i${i}`, { minute: i });
    const first = await t.list('?sort=recent&limit=2');
    assert.deepEqual(
      first.body.incidents.map((i) => i.title),
      ['i5', 'i4'],
    );
    assert.equal(first.body.total, 5);
    assert.equal(first.body.nextOffset, 2);
    const last = await t.list('?sort=recent&limit=2&offset=4');
    assert.deepEqual(
      last.body.incidents.map((i) => i.title),
      ['i1'],
    );
    assert.equal(last.body.nextOffset, null);
    for (const bad of ['?status=nope', '?limit=101', '?offset=-1', '?assignee=someone', '?x=1']) {
      assert.equal((await t.list(bad)).status, 400, bad);
    }
  });

  it("never shows another workspace's incidents", async () => {
    const t = await tenant();
    const other = await tenant();
    await other.incident('theirs');
    assert.deepEqual(await t.titles(), []);
    assert.equal((await t.list(`?datasetId=${other.orders.id}`)).body.total, 0);
  });
});
