import { vi } from 'vitest';

type Handler = (body: unknown) => unknown;

/** An answer with a status other than 200. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
export const reply = (status: number, body: unknown) => new Reply(status, body);

/** Answers requests by "METHOD path" (path without the API base); records
 * every call. Unknown requests fail like a network error. */
export function routeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; body: unknown }[] = [];
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://api.test').pathname + new URL(url, 'http://api.test').search;
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ key, body });
    const route = routes[key];
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
    if (handler === undefined) return Promise.reject(new TypeError(`no route for ${key}`));
    const answer = handler(body);
    const { status, json } =
      answer instanceof Reply
        ? { status: answer.status, json: answer.body }
        : { status: 200, json: answer };
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}
