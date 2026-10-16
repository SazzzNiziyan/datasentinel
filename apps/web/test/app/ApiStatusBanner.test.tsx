import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatusBanner } from '../../src/app/ApiStatusBanner.tsx';

// The browser's network is the boundary here, so fetch is replaced.
function stubFetch(respond: () => Promise<Response>) {
  const fetch = vi.fn(respond);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ApiStatusBanner', () => {
  it('says nothing when the API and its services are ready', async () => {
    const fetch = stubFetch(() =>
      json(200, { status: 'ready', dependencies: { database: 'up', redis: 'up', storage: 'up' } }),
    );
    render(<ApiStatusBanner baseUrl="http://api.test" />);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('http://api.test/health/ready', expect.anything()),
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('names the services that are not ready, in plain words', async () => {
    stubFetch(() =>
      json(503, {
        status: 'not_ready',
        dependencies: { database: 'down', redis: 'down', storage: 'up' },
      }),
    );
    render(<ApiStatusBanner baseUrl="http://api.test" />);
    expect(await screen.findByText(/Some services aren't ready/)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('database, job queue');
  });

  it('says the API cannot be reached when the request fails', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<ApiStatusBanner baseUrl="http://api.test" />);
    expect(await screen.findByText(/Can't reach the DataSentinel API/)).toBeVisible();
  });

  it('treats an unexpected answer as unreachable, not as healthy', async () => {
    stubFetch(() => json(200, { hello: 'proxy page' }));
    render(<ApiStatusBanner baseUrl="http://api.test" />);
    expect(await screen.findByText(/Can't reach the DataSentinel API/)).toBeVisible();
  });

  it('stays quiet while the browser is offline; the offline banner explains it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetch = stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<ApiStatusBanner baseUrl="http://api.test" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
