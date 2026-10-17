import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppModule } from '../src/app.module.js';
import { DEPENDENCY_CHECKS } from '../src/health/dependency-checks.js';

// Phase N route review, kept as a test: every route is either on a short,
// reviewed public list, or is a workspace route (checked by WorkspaceGuard),
// or is on a short reviewed list of signed-in, user-level routes. A workspace
// route that changes data must say which role it needs; the guard's default
// is viewer.

const PUBLIC = 'datasentinel:public';
const ROLE = 'datasentinel:required-role';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD'];

/** Reviewed public routes: sign-in, health, token-authenticated events,
 * invitation acceptance. Adding to this list is a security decision. */
const PUBLIC_ROUTES = new Set([
  'GET /health/live',
  'GET /health/ready',
  'POST /auth/sessions',
  'DELETE /auth/sessions/current',
  'PATCH /auth/sessions/current',
  'POST /integrations/pipeline-runs',
  'DELETE /integrations/pipeline-runs/:pipelineRunId',
]);

function join(...parts: string[]): string {
  return (
    '/' +
    parts
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .filter((p) => p !== '')
      .join('/')
  );
}

interface Route {
  key: string;
  path: string;
  method: string;
  isPublic: boolean;
  role: string | undefined;
}

async function listRoutes(): Promise<Route[]> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DiscoveryModule,
      AppModule.register({
        logLevel: 'silent',
        databaseUrl: 'postgresql://unused@127.0.0.1:1/unused',
        redisUrl: 'redis://unused',
        webOrigin: 'http://localhost:5173',
        secureCookies: false,
      }),
    ],
  })
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue([])
    .compile();
  const routes: Route[] = [];
  for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
    const instance = wrapper.instance as object | undefined;
    if (instance === undefined || wrapper.metatype === null) continue;
    const controller = wrapper.metatype;
    const prefix = Reflect.getMetadata('path', controller) as string | string[] | undefined;
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const methodIndex = Reflect.getMetadata('method', handler) as number | undefined;
      if (methodIndex === undefined) continue;
      const sub = Reflect.getMetadata('path', handler) as string | string[];
      const path = join(String(Array.isArray(prefix) ? prefix[0] : (prefix ?? '')), String(sub));
      const method = METHODS[methodIndex] ?? String(methodIndex);
      routes.push({
        key: `${method} ${path}`,
        path,
        method,
        isPublic:
          Reflect.getMetadata(PUBLIC, handler) === true ||
          Reflect.getMetadata(PUBLIC, controller) === true,
        role: (Reflect.getMetadata(ROLE, handler) ?? Reflect.getMetadata(ROLE, controller)) as
          string | undefined,
      });
    }
  }
  await moduleRef.close();
  return routes;
}

describe('route permission review', () => {
  it('finds the routes', async () => {
    const routes = await listRoutes();
    assert.ok(routes.length > 80, `only ${routes.length} routes found`);
  });

  it('keeps the public surface to the reviewed list plus invitation routes', async () => {
    const publicKeys = (await listRoutes()).filter((r) => r.isPublic).map((r) => r.key);
    const unexpected = publicKeys.filter(
      (k) => !PUBLIC_ROUTES.has(k) && !/\/invitations\//.test(k),
    );
    assert.deepEqual(unexpected, []);
  });

  it('never makes a workspace route public', async () => {
    const bad = (await listRoutes()).filter((r) => r.isPublic && r.path.includes(':workspaceId'));
    assert.deepEqual(
      bad.map((r) => r.key),
      [],
    );
  });

  it('requires an explicit role on every workspace route that changes data', async () => {
    const missing = (await listRoutes())
      .filter((r) => r.path.includes(':workspaceId') && r.method !== 'GET' && r.role === undefined)
      .map((r) => r.key);
    assert.deepEqual(missing, []);
  });

  it('keeps routes outside a workspace to a reviewed list', async () => {
    const outside = (await listRoutes())
      .filter((r) => !r.isPublic && !r.path.includes(':workspaceId'))
      .map((r) => r.key)
      .sort();
    assert.deepEqual(outside, ['GET /auth/me', 'GET /workspaces', 'POST /workspaces']);
  });
});
