import type { INestApplication } from '@nestjs/common';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { slugify } from '../src/workspaces/workspaces.controller.js';
import { createUser, databaseSkipReason, prisma, signInCookie, startApi, WEB } from './helpers.js';

describe('slugify', () => {
  it('makes a readable, URL-safe slug', () => {
    assert.equal(slugify('Café Müller  Analytics!'), 'cafe-muller-analytics');
    assert.equal(slugify('***'), 'workspace');
  });
});

const skip = await databaseSkipReason();

describe('workspace creation', { skip }, () => {
  let app: INestApplication;
  let url: string;
  let cookie: string;
  let userId: string;

  const create = (body: unknown) =>
    fetch(`${url}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB, cookie },
      body: JSON.stringify(body),
    });

  before(async () => {
    ({ app, url } = await startApi());
    const user = await createUser();
    userId = user.id;
    cookie = await signInCookie(url, user.email);
  });

  after(async () => {
    await prisma.workspace.deleteMany({ where: { memberships: { some: { userId } } } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it('creates the workspace with the caller as owner', async () => {
    const res = await create({ name: 'Acme Analytics', timezone: 'Europe/Berlin' });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; slug: string; role: string; timezone: string };
    assert.equal(body.role, 'owner');
    assert.equal(body.timezone, 'Europe/Berlin');
    assert.match(body.slug, /^acme-analytics/);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { workspaceId: body.id, userId },
    });
    assert.equal(membership.role, 'owner');
    assert.notEqual(membership.acceptedAt, null);
  });

  it('gives a second workspace with the same name its own slug', async () => {
    const a = (await (await create({ name: 'Same Name' })).json()) as { slug: string };
    const b = (await (await create({ name: 'Same Name' })).json()) as { slug: string };
    assert.notEqual(a.slug, b.slug);
  });

  it('defaults the timezone to UTC', async () => {
    const body = (await (await create({ name: 'No Zone' })).json()) as { timezone: string };
    assert.equal(body.timezone, 'UTC');
  });

  it('rejects an empty name and an unknown timezone', async () => {
    assert.equal((await create({ name: '   ' })).status, 400);
    assert.equal((await create({ name: 'Ok', timezone: 'Mars/Olympus' })).status, 400);
  });
});
