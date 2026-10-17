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

type Doc = { id: string; name: string; chunkCount: number; status: string; code?: string };
type Hit = {
  documentName: string;
  sectionPath: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
  rank: number;
};

const runbook = `# Loader

The nightly loader copies orders into the warehouse at 02:00.

## Credentials

Rotate the warehouse password every ninety days. Never email it.

# Troubleshooting

If freshness fails, check whether the export finished before the loader started.
`;

describe('documents', { skip }, () => {
  let app: INestApplication;
  let url: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  async function tenant() {
    const w = await prisma.workspace.create({ data: { name: 'D', slug: `d-${randomUUID()}` } });
    workspaces.push(w.id);
    const member = async (role: 'viewer' | 'analyst' | 'engineer') => {
      const user = await createUser();
      users.push(user.id);
      await prisma.membership.create({ data: { workspaceId: w.id, userId: user.id, role } });
      let cached: string | undefined;
      return { cookie: async () => (cached ??= await signInCookie(url, user.email)) };
    };
    const viewer = await member('viewer');
    const analyst = await member('analyst');
    const engineer = await member('engineer');
    const call = async (
      who: { cookie: () => Promise<string> },
      method: string,
      path: string,
      body?: unknown,
      workspace = w.id,
    ) => {
      const res = await fetch(`${url}/workspaces/${workspace}/documents${path}`, {
        method,
        headers: { cookie: await who.cookie(), origin: WEB, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Doc };
    };
    const upload = (name: string, content: string, who = engineer) =>
      call(who, 'POST', '', { name, content });
    const search = async (who: typeof analyst, q: string, workspace = w.id) => {
      const res = await call(
        who,
        'GET',
        `/search?q=${encodeURIComponent(q)}`,
        undefined,
        workspace,
      );
      return {
        status: res.status,
        hits: (res.status === 200 ? JSON.parse(res.text) : []) as Hit[],
      };
    };
    return { workspaceId: w.id, viewer, analyst, engineer, call, upload, search };
  }

  before(async () => ({ app, url } = await startApi({ sourceJobs: new RecordingSourceJobs() })));
  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  });

  it('stores a Markdown document as sectioned chunks and audits it without its text', async () => {
    const t = await tenant();
    const res = await t.upload('loader-runbook.md', runbook);
    assert.equal(res.status, 201);
    assert.equal(res.body.chunkCount, 3);
    const chunks = await prisma.documentChunk.findMany({
      where: { documentId: res.body.id },
      orderBy: { ordinal: 'asc' },
    });
    assert.deepEqual(
      chunks.map((c) => c.sectionPath),
      ['Loader', 'Loader > Credentials', 'Troubleshooting'],
    );
    const audits = await prisma.auditEvent.findMany({
      where: { workspaceId: t.workspaceId, action: 'document.uploaded' },
    });
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits).includes('warehouse password'), false);
    const list = await t.call(t.viewer, 'GET', '');
    assert.equal(list.status, 200);
    assert.equal(list.text.includes('warehouse password'), false);
  });

  it('refuses unsupported formats, unreadable files, bad sources, and repeats', async () => {
    const t = await tenant();
    assert.equal((await t.upload('plan.pdf', 'text')).status, 415);
    assert.equal((await t.upload('plan.md', 'binary \u0000 junk')).status, 400);
    assert.equal((await t.upload('plan.md', '# only a heading')).status, 400);
    const foreign = await t.call(t.engineer, 'POST', '', {
      name: 'a.md',
      content: 'text',
      sourceId: randomUUID(),
    });
    assert.equal(foreign.status, 404);
    assert.equal(
      (await t.call(t.engineer, 'POST', '', { name: 'a.md', content: 'x', extra: 1 })).status,
      400,
    );
    assert.equal((await t.upload('one.md', runbook)).status, 201);
    const again = await t.upload('copy.md', runbook);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'document_exists');
    assert.equal(await prisma.document.count({ where: { workspaceId: t.workspaceId } }), 1);
  });

  it('lets engineers add and archive, analysts search, and viewers only list', async () => {
    const t = await tenant();
    assert.equal((await t.upload('a.md', runbook, t.analyst)).status, 403);
    assert.equal((await t.upload('a.md', runbook, t.viewer)).status, 403);
    const doc = await t.upload('a.md', runbook);
    assert.equal((await t.call(t.viewer, 'GET', '')).status, 200);
    assert.equal((await t.search(t.viewer, 'loader')).status, 403);
    assert.equal((await t.search(t.analyst, 'loader')).status, 200);
    assert.equal((await t.call(t.analyst, 'DELETE', `/${doc.body.id}`)).status, 403);
    assert.equal((await t.call(t.engineer, 'DELETE', `/${doc.body.id}`)).status, 204);
    assert.equal((await t.call(t.engineer, 'DELETE', `/${doc.body.id}`)).status, 404);
  });

  it('finds the right section, best match first, with where it came from', async () => {
    const t = await tenant();
    await t.upload('loader-runbook.md', runbook);
    await t.upload('other.txt', 'The billing report is produced by finance on Fridays.');
    const found = await t.search(t.analyst, 'rotate password');
    assert.equal(found.status, 200);
    assert.equal(found.hits.length, 1);
    const hit = found.hits[0]!;
    assert.equal(hit.documentName, 'loader-runbook.md');
    assert.equal(hit.sectionPath, 'Loader > Credentials');
    assert.ok(hit.startLine >= 1 && hit.endLine >= hit.startLine);
    assert.match(hit.snippet, /Rotate the warehouse password/);
    assert.ok(hit.rank > 0);
    // Word forms match (freshness fails / failing), other documents do not.
    const forms = await t.search(t.analyst, 'freshness failing export');
    assert.equal(forms.hits[0]?.sectionPath, 'Troubleshooting');
    assert.equal((await t.search(t.analyst, 'zebra')).hits.length, 0);
  });

  it('never errors on odd queries, and refuses empty or oversized ones', async () => {
    const t = await tenant();
    await t.upload('a.md', runbook);
    for (const q of [
      "loader'; DROP TABLE documents;--",
      '"unclosed quote',
      '& | ! ( )',
      '日本語',
      'a:b:c',
    ]) {
      assert.equal((await t.search(t.analyst, q)).status, 200, q);
    }
    assert.equal((await t.search(t.analyst, '   ')).status, 400);
    assert.equal((await t.search(t.analyst, 'x'.repeat(201))).status, 400);
    assert.equal(await prisma.document.count({ where: { workspaceId: t.workspaceId } }), 1);
  });

  it('keeps workspaces apart in search, list, and archive', async () => {
    const a = await tenant();
    const b = await tenant();
    const doc = await a.upload('a.md', runbook);
    assert.equal((await b.search(b.analyst, 'warehouse password')).hits.length, 0);
    assert.equal((await b.call(b.viewer, 'GET', '')).text, '[]');
    assert.equal(
      (await b.call(b.engineer, 'DELETE', `/${doc.body.id}`, undefined, b.workspaceId)).status,
      404,
    );
    assert.equal((await a.search(a.analyst, 'warehouse password')).hits.length, 1);
  });

  it('removes an archived document from search and lets the same file be added again', async () => {
    const t = await tenant();
    const doc = await t.upload('a.md', runbook);
    assert.equal((await t.search(t.analyst, 'warehouse password')).hits.length, 1);
    assert.equal((await t.call(t.engineer, 'DELETE', `/${doc.body.id}`)).status, 204);
    assert.equal((await t.search(t.analyst, 'warehouse password')).hits.length, 0);
    assert.equal(await prisma.documentChunk.count({ where: { documentId: doc.body.id } }), 0);
    assert.equal((await t.call(t.viewer, 'GET', '')).text, '[]');
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'document.archived', targetId: doc.body.id },
    });
    assert.equal((await t.upload('a-again.md', runbook)).status, 201);
  });
});
