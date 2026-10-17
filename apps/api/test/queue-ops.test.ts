import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { operatorJobs, STALLED_AFTER_MS, type RawQueueJob } from '../src/ops/queue-ops.js';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

const skip = await databaseSkipReason();

const W = 'w-1';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const ago = (ms: number) => NOW.getTime() - ms;

const job = (over: Partial<RawQueueJob> = {}): RawQueueJob => ({
  queue: 'sources',
  id: 'j1',
  name: 'run-check',
  state: 'failed',
  workspaceId: W,
  attemptsMade: 3,
  attempts: 3,
  addedAt: ago(60_000),
  finishedAt: ago(30_000),
  failedReason: 'connect ETIMEDOUT',
  ...over,
});

describe('operator job view', () => {
  it('shows failed jobs and jobs stuck for over 15 minutes, never other workspaces', () => {
    const { jobs, omitted } = operatorJobs(
      [
        job({ id: 'failed' }),
        job({
          id: 'stuck',
          state: 'waiting',
          addedAt: ago(STALLED_AFTER_MS + 1),
          failedReason: null,
          finishedAt: null,
        }),
        job({ id: 'fresh', state: 'active', addedAt: ago(STALLED_AFTER_MS - 1000) }),
        job({ id: 'theirs', workspaceId: 'other' }),
        job({ id: 'unowned', workspaceId: null }),
      ],
      W,
      NOW,
    );
    assert.deepEqual(
      jobs.map((j) => [j.jobId, j.state]),
      [
        ['failed', 'failed'],
        ['stuck', 'stalled'],
      ],
    );
    assert.equal(omitted, 0);
  });

  it('redacts and shortens the failure and shows only its first line', () => {
    const [shown] = operatorJobs(
      [
        job({
          failedReason: `login failed for postgres://loader:hunter2@db/app password=hunter2 ${'x'.repeat(400)}\n    at secret/stack.js`,
        }),
      ],
      W,
      NOW,
    ).jobs;
    assert.doesNotMatch(shown?.failure ?? '', /hunter2|stack\.js/);
    assert.ok((shown?.failure ?? '').length <= 200);
    assert.equal(operatorJobs([job({ failedReason: null })], W, NOW).jobs[0]?.failure, null);
  });

  it('filters by state, orders newest first, and counts jobs beyond 100', () => {
    const many = Array.from({ length: 103 }, (_, i) =>
      job({ id: `j${i}`, addedAt: ago(1000 + i) }),
    );
    const all = operatorJobs(
      [...many, job({ id: 's', state: 'waiting', addedAt: ago(STALLED_AFTER_MS * 2) })],
      W,
      NOW,
    );
    assert.equal(all.jobs.length, 100);
    assert.equal(all.omitted, 4);
    assert.equal(all.jobs[0]?.jobId, 'j0');
    assert.deepEqual(
      operatorJobs(
        [job(), job({ id: 's', state: 'waiting', addedAt: ago(STALLED_AFTER_MS * 2) })],
        W,
        NOW,
        'stalled',
      ).jobs.map((j) => j.jobId),
      ['s'],
    );
  });
});

describe('queue jobs API', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];
  let raw: RawQueueJob[] = [];

  async function tenant(role: 'admin' | 'engineer') {
    const user = await createUser();
    users.push(user.id);
    const w = await prisma.workspace.create({ data: { name: 'Q', slug: `q-${randomUUID()}` } });
    workspaces.push(w.id);
    await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
    const cookie = await signInCookie(url, user.email);
    const get = async (query = '') => {
      const res = await fetch(`${url}/workspaces/${w.id}/queue-jobs${query}`, {
        headers: { cookie, origin: WEB },
      });
      return {
        status: res.status,
        body: (await res.json()) as { jobs: { jobId: string }[]; omitted: number },
      };
    };
    return { workspaceId: w.id, get };
  }

  before(
    async () => ({ app, url } = await startApi({ queueOps: { list: () => Promise.resolve(raw) } })),
  );
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('lets admins see their workspace jobs only, and refuses engineers', async () => {
    const admin = await tenant('admin');
    const engineer = await tenant('engineer');
    raw = [
      job({ id: 'mine', workspaceId: admin.workspaceId, addedAt: Date.now() - 1000 }),
      job({ id: 'theirs', workspaceId: engineer.workspaceId, addedAt: Date.now() - 1000 }),
    ];
    const res = await admin.get();
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.jobs.map((j) => j.jobId),
      ['mine'],
    );
    assert.equal((await engineer.get()).status, 403);
    assert.equal((await admin.get('?state=bogus')).status, 400);
    assert.deepEqual((await admin.get('?state=stalled')).body.jobs, []);
  });
});
