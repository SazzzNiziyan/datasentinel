import { destinationContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import { deliverDisabled } from '../src/delivery/deliver.js';
import { deliverGitHub, renderGitHubIssue } from '../src/delivery/deliver-github.js';
import { deliverWebhooks, signWebhook } from '../src/delivery/deliver-webhook.js';

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
const ring = keyRing({ key: randomBytes(32), version: 5 });
const token = `github_pat_${'D'.repeat(30)}`;

describe('GitHub issue rendering', () => {
  it('keeps markup and mentions out of the issue and adds a delivery marker', () => {
    const issue = renderGitHubIssue({
      kind: 'incident_opened',
      incidentId,
      deliveryId: 'del-1',
      webOrigin: `${WEB}/`,
      labels: ['data-quality'],
      payload: {
        title: '@acme/security [click](https://evil.example) `x`\nnewline',
        severity: 'critical',
        datasetName: 'orders_*',
        rowValue: 'secret-row',
      },
    });
    assert.match(issue.title, /^\[DataSentinel\] Incident opened: @acme\/security/);
    assert.equal(issue.title.includes('\n'), false);
    assert.equal(issue.body.includes('@acme'), false, 'no live mention in the body');
    assert.equal(issue.body.includes('[click](https://evil.example)'), false);
    assert.equal(issue.body.includes('secret-row'), false);
    assert.match(issue.body, new RegExp(`\\]\\(${WEB}/incidents/${incidentId}\\)`));
    assert.match(issue.body, /<!-- datasentinel-delivery:del-1 -->$/);
    assert.deepEqual(issue.labels, ['data-quality']);
  });
});

describe('GitHub and n8n delivery', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture(
    type: 'github' | 'n8n',
    settings: Record<string, string | string[]>,
    secret: Record<string, string>,
    sealRing = ring,
  ) {
    const w = await prisma.workspace.create({ data: { name: 'G', slug: `g-${randomUUID()}` } });
    workspaces.push(w.id);
    const id = randomUUID();
    const sealed = sealSecret(sealRing, secret, destinationContext(w.id, id));
    const destination = await prisma.destination.create({
      data: {
        id,
        workspaceId: w.id,
        name: type,
        type,
        events: type === 'github' ? ['incident_opened'] : ['incident_opened', 'incident_reopened'],
        settings: settings,
        ciphertext: new Uint8Array(sealed.ciphertext),
        keyVersion: sealed.keyVersion,
      },
    });
    const delivery = await prisma.notificationDelivery.create({
      data: {
        workspaceId: w.id,
        incidentId,
        incidentEventId: randomUUID(),
        destinationId: destination.id,
        kind: 'incident_opened',
        payload: { title: 'Orders are stale', severity: 'critical', datasetName: 'orders' },
      },
    });
    const reload = () =>
      prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    return { delivery, reload, workspaceId: w.id };
  }

  const github = () =>
    fixture('github', { owner: 'acme', repo: 'data-alerts', labels: ['dq'] }, { token });
  const clock = () => new Date(Date.now() + 5_000);

  it('opens one issue on api.github.com with least-privilege headers, once', async () => {
    const f = await github();
    const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = [];
    const deps = {
      prisma,
      ring,
      webOrigin: WEB,
      workspaceIds: [f.workspaceId],
      post: (url: string, body: unknown, _t: number, headers?: Record<string, string>) => {
        calls.push({ url, body, headers });
        return Promise.resolve({ status: 201, text: '' });
      },
    };
    const now = clock();
    const out = await Promise.all([deliverGitHub(deps, now), deliverGitHub(deps, now)]);
    assert.equal(
      out.reduce((n, r) => n + r.sent, 0),
      1,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.github.com/repos/acme/data-alerts/issues');
    assert.equal(calls[0]?.headers?.authorization, `Bearer ${token}`);
    assert.equal(calls[0]?.headers?.['x-github-api-version'], '2022-11-28');
    assert.equal(JSON.stringify(calls[0]?.body).includes(token), false);
    const row = await f.reload();
    assert.equal(row.status, 'sent');
    assert.equal(JSON.stringify(row).includes(token), false);
  });

  it('maps GitHub answers to short reason codes, retrying only what can recover', async () => {
    const cases: [number | Error, string, 'failed' | 'pending'][] = [
      [401, 'github_unauthorized', 'failed'],
      [403, 'github_forbidden', 'failed'],
      [404, 'github_repo_not_found', 'failed'],
      [422, 'github_rejected', 'failed'],
      [429, 'github_rate_limited', 'pending'],
      [502, 'github_http_502', 'pending'],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'github_timeout', 'pending'],
      [new Error(`ECONNRESET ${token}`), 'github_unreachable', 'pending'],
    ];
    for (const [result, reason, status] of cases) {
      const f = await github();
      await deliverGitHub(
        {
          prisma,
          ring,
          webOrigin: WEB,
          workspaceIds: [f.workspaceId],
          post: () =>
            typeof result === 'number'
              ? Promise.resolve({ status: result, text: `bad credentials ${token}` })
              : Promise.reject(result),
        },
        clock(),
      );
      const row = await f.reload();
      assert.equal(row.lastError, reason);
      assert.equal(row.status, status, reason);
      assert.equal(JSON.stringify(row).includes(token), false);
    }
  });

  it('never calls GitHub for a bad repository, a bad token, or an unopenable secret', async () => {
    const badRepo = await fixture('github', { owner: '..', repo: 'x' }, { token });
    const badToken = await fixture('github', { owner: 'a', repo: 'b' }, { token: 'not-a-token' });
    const wrongKey = await fixture(
      'github',
      { owner: 'a', repo: 'b' },
      { token },
      keyRing({ key: randomBytes(32), version: 5 }),
    );
    let posted = 0;
    await deliverGitHub(
      {
        prisma,
        ring,
        webOrigin: WEB,
        workspaceIds: [badRepo.workspaceId, badToken.workspaceId, wrongKey.workspaceId],
        post: () => {
          posted += 1;
          return Promise.resolve({ status: 201, text: '' });
        },
      },
      clock(),
    );
    assert.equal(posted, 0);
    assert.equal((await badRepo.reload()).lastError, 'invalid_destination');
    assert.equal((await badToken.reload()).lastError, 'secret_unavailable');
    assert.equal((await wrongKey.reload()).lastError, 'secret_unavailable');
  });

  it('delivers n8n like a signed webhook', async () => {
    const f = await fixture(
      'n8n',
      { url: 'https://n8n.example.com/webhook/abc' },
      { signingSecret: 'whsec_n8n' },
    );
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const now = clock();
    const out = await deliverWebhooks(
      {
        prisma,
        ring,
        policy: 'public-only',
        webOrigin: WEB,
        workspaceIds: [f.workspaceId],
        post: (url, headers, body) => {
          calls.push({ url, headers, body });
          return Promise.resolve({ status: 200 });
        },
      },
      now,
      20,
      'n8n',
    );
    assert.equal(out.sent, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://n8n.example.com/webhook/abc');
    const ts = Number(call.headers['x-datasentinel-timestamp']);
    assert.equal(call.headers['x-datasentinel-signature'], signWebhook('whsec_n8n', ts, call.body));
    assert.equal((await f.reload()).status, 'sent');
  });

  it('webhook delivery never picks up n8n or GitHub rows, and a disabled type fails visibly', async () => {
    const n8n = await fixture(
      'n8n',
      { url: 'https://n8n.example.com/webhook/abc' },
      { signingSecret: 'whsec_n8n' },
    );
    let posted = 0;
    const out = await deliverWebhooks(
      {
        prisma,
        ring,
        policy: 'public-only',
        webOrigin: WEB,
        workspaceIds: [n8n.workspaceId],
        post: () => {
          posted += 1;
          return Promise.resolve({ status: 200 });
        },
      },
      clock(),
    );
    assert.equal(posted, 0);
    assert.equal(out.sent + out.failed, 0);

    const off = await deliverDisabled(prisma, 'n8n', clock(), 20, [n8n.workspaceId]);
    assert.equal(off.failed, 1);
    const row = await n8n.reload();
    assert.equal(row.status, 'failed');
    assert.equal(row.lastError, 'feature_disabled');
    assert.equal(posted, 0);
  });
});
