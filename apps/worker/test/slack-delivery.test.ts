import { destinationContext, keyRing, sealSecret } from '@datasentinel/connectors';
import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, afterEach, describe, it } from 'node:test';
import { deliverSlack, postJson, renderSlackMessage } from '../src/delivery/deliver-slack.js';

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
const slackUrl = 'https://hooks.slack.com/services/T0123/B0456/abcDEF123';
const ring = keyRing({ key: randomBytes(32), version: 5 });

describe('slack message', () => {
  it('escapes markup so a title cannot mention or link, and links back', () => {
    const { text } = renderSlackMessage({
      kind: 'incident_reopened',
      incidentId,
      webOrigin: `${WEB}/`,
      payload: {
        title: '<!channel> <https://evil.example|click> & more\nnewline',
        severity: 'critical',
        datasetName: 'orders',
        rowValue: 'secret-row',
      },
    });
    assert.match(
      text,
      /^\*Incident reopened\*: &lt;!channel&gt; &lt;https:\/\/evil\.example\|click&gt; &amp; more newline/,
    );
    assert.equal(text.includes('<!channel>'), false);
    assert.equal(text.includes('secret-row'), false);
    assert.match(text, new RegExp(`<${WEB}/incidents/${incidentId}\\|Open the incident>$`));
  });
});

describe('default Slack poster', () => {
  it('does not follow redirects, caps the body, and times out', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/followed' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200).end('x'.repeat(5000));
      } else {
        // never answers
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const redirected = await postJson(`http://127.0.0.1:${port}/redirect`, {}, 2000);
      assert.equal(redirected.status, 302);
      assert.equal(hits.includes('/followed'), false);
      assert.equal((await postJson(`http://127.0.0.1:${port}/big`, {}, 2000)).text.length, 200);
      await assert.rejects(postJson(`http://127.0.0.1:${port}/hang`, {}, 100), {
        name: 'TimeoutError',
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('slack delivery', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  async function fixture(options: { url?: string; key?: ReturnType<typeof keyRing> } = {}) {
    const w = await prisma.workspace.create({ data: { name: 'S', slug: `s-${randomUUID()}` } });
    workspaces.push(w.id);
    const id = randomUUID();
    const sealed = sealSecret(
      options.key ?? ring,
      { webhookUrl: options.url ?? slackUrl },
      destinationContext(w.id, id),
    );
    const destination = await prisma.destination.create({
      data: {
        id,
        workspaceId: w.id,
        name: 'slack',
        type: 'slack',
        events: ['incident_opened'],
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

  const clock = () => new Date(Date.now() + 5_000);

  it('posts the message to the sealed Slack URL once and records it', async () => {
    const f = await fixture();
    const calls: { url: string; body: unknown }[] = [];
    const deps = {
      prisma,
      ring,
      webOrigin: WEB,
      workspaceIds: [f.workspaceId],
      post: (url: string, body: unknown) => {
        calls.push({ url, body });
        return Promise.resolve({ status: 200, text: 'ok' });
      },
    };
    const now = clock();
    const out = await Promise.all([deliverSlack(deps, now), deliverSlack(deps, now)]);
    assert.equal(
      out.reduce((n, r) => n + r.sent, 0),
      1,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, slackUrl);
    assert.match((calls[0]?.body as { text: string }).text, /Orders are stale/);
    const row = await f.reload();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1);
    assert.equal(JSON.stringify(row).includes('abcDEF123'), false);
  });

  it('records each failure as a short reason code with no URL or response text', async () => {
    const cases: [number | Error, string][] = [
      [429, 'slack_rate_limited'],
      [500, 'slack_http_500'],
      [404, 'slack_http_404'],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'slack_timeout'],
      [new Error('connect ECONNREFUSED hooks.slack.com abcDEF123'), 'slack_unreachable'],
    ];
    for (const [result, expected] of cases) {
      const f = await fixture();
      await prisma.notificationDelivery.updateMany({
        where: { id: f.delivery.id },
        data: { attempts: 4 },
      });
      const out = await deliverSlack(
        {
          prisma,
          ring,
          webOrigin: WEB,
          workspaceIds: [f.workspaceId],
          post: () =>
            typeof result === 'number'
              ? Promise.resolve({ status: result, text: 'invalid_token abcDEF123' })
              : Promise.reject(result),
        },
        clock(),
      );
      assert.equal(out.failed, 1, expected);
      const row = await f.reload();
      assert.equal(row.status, 'failed');
      assert.equal(row.lastError, expected);
      assert.equal(row.attempts, 5);
      assert.equal(JSON.stringify(row).includes('abcDEF123'), false);
    }
  });

  it('never posts when the secret cannot be opened or is not a Slack URL', async () => {
    const wrongKey = await fixture({ key: keyRing({ key: randomBytes(32), version: 5 }) });
    const notSlack = await fixture({ url: 'https://evil.example/services/T1/B2/c3' });
    let posted = 0;
    const out = await deliverSlack(
      {
        prisma,
        ring,
        webOrigin: WEB,
        workspaceIds: [wrongKey.workspaceId, notSlack.workspaceId],
        post: () => {
          posted += 1;
          return Promise.resolve({ status: 200, text: 'ok' });
        },
      },
      clock(),
    );
    assert.equal(posted, 0);
    assert.equal(out.failed, 2);
    assert.equal((await wrongKey.reload()).lastError, 'secret_unavailable');
    assert.equal((await notSlack.reload()).lastError, 'invalid_destination');
  });
});
