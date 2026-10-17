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
type Run = {
  id: string;
  name: string;
  status: string;
  sourceName: string;
  datasetName: string | null;
};
type Page = { runs: Run[]; nextCursor: string | null };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 12, 0) + minutes * 60_000);

describe('pipeline run history', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'H', slug: `h-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({
      data: { workspaceId: w.id, userId: user.id, role: 'viewer' },
    });
    const a = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'airflow', type: 'pipeline_event' },
    });
    const b = await prisma.dataSource.create({
      data: { workspaceId: w.id, name: 'dbt', type: 'pipeline_event' },
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId: w.id, sourceId: a.id, stableKey: 'orders', name: 'orders' },
    });
    const cookie = await signInCookie(url, user.email);
    const get = async (path: string) => {
      const res = await fetch(`${url}/workspaces/${w.id}/pipeline-runs${path}`, {
        headers: { cookie, origin: WEB },
      });
      return { status: res.status, body: (await res.json()) as Page };
    };
    const run = (sourceId: string, n: number, status: string, datasetId?: string) =>
      prisma.pipelineRun.create({
        data: {
          workspaceId: w.id,
          sourceId,
          datasetId: datasetId ?? null,
          externalRunId: `run-${n}-${randomUUID()}`,
          name: `job ${n}`,
          status: status as 'running',
          trigger: 'schedule',
          lastEventAt: at(n),
        },
      });
    return { workspaceId: w.id, a, b, dataset, get, run };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lists newest first with source and dataset names, readable by a viewer', async () => {
    const t = await tenant();
    await t.run(t.a.id, 1, 'succeeded', t.dataset.id);
    await t.run(t.b.id, 2, 'failed');
    const res = await t.get('');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.runs.map((r) => [r.name, r.status, r.sourceName, r.datasetName]),
      [
        ['job 2', 'failed', 'dbt', null],
        ['job 1', 'succeeded', 'airflow', 'orders'],
      ],
    );
    assert.equal(res.body.nextCursor, null);
  });

  it('filters by status, source, dataset, and time', async () => {
    const t = await tenant();
    await t.run(t.a.id, 1, 'succeeded', t.dataset.id);
    await t.run(t.a.id, 2, 'failed');
    await t.run(t.b.id, 3, 'failed');
    const names = async (q: string) => (await t.get(q)).body.runs.map((r) => r.name);
    assert.deepEqual(await names('?status=failed'), ['job 3', 'job 2']);
    assert.deepEqual(await names(`?sourceId=${t.b.id}`), ['job 3']);
    assert.deepEqual(await names(`?datasetId=${t.dataset.id}`), ['job 1']);
    assert.deepEqual(await names(`?from=${at(2).toISOString()}&to=${at(2).toISOString()}`), [
      'job 2',
    ]);
    assert.equal((await t.get('?status=nope')).status, 400);
    assert.equal((await t.get('?workspaceId=x')).status, 400);
    assert.equal((await t.get('?limit=101')).status, 400);
  });

  it('pages without repeating or skipping runs, also at equal times', async () => {
    const t = await tenant();
    for (let n = 1; n <= 5; n += 1) await t.run(t.a.id, n === 5 ? 4 : n, 'succeeded');
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const res = await t.get(`?limit=2${cursor === '' ? '' : `&cursor=${cursor}`}`);
      seen.push(...res.body.runs.map((r) => r.id));
      if (res.body.nextCursor === null) break;
      cursor = res.body.nextCursor;
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
    assert.equal((await t.get('?cursor=garbage')).status, 400);
  });

  it("never shows another workspace's runs", async () => {
    const t = await tenant();
    const other = await tenant();
    await other.run(other.a.id, 1, 'failed');
    assert.deepEqual((await t.get('')).body.runs, []);
    assert.deepEqual((await t.get(`?sourceId=${other.a.id}`)).body.runs, []);
  });
});
