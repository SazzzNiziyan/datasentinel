import type { DeliveryItem, DestinationSummary } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/pages/SettingsPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

afterEach(() => vi.unstubAllGlobals());

const BASE = '/workspaces/w1/destinations';
const LIST = `GET ${BASE}`;

function renderSettings(role: Parameters<typeof signedIn>[0] = 'admin') {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </WithSession>,
  );
}

const dest = (over: Partial<DestinationSummary>): DestinationSummary => ({
  id: 'd1',
  name: 'On-call email',
  type: 'email',
  status: 'active',
  events: ['incident_opened', 'incident_reopened'],
  recipients: ['a@example.com', 'b@example.com'],
  url: null,
  repository: null,
  hasSecret: false,
  secretRotatedAt: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...over,
});

const base = {
  [`GET ${BASE}/options`]: () => ({ types: ['email', 'slack', 'webhook'] }),
  'GET /workspaces/w1/members': () => [],
  'GET /workspaces/w1/invitations': () => [],
  'GET /workspaces/w1/queue-jobs': () => ({ jobs: [], omitted: 0 }),
  'GET /workspaces/w1/documents': () => [],
  'GET /workspaces/w1/action-policy': () => ({ requireSecondApprover: true }),
  'GET /workspaces/w1/ai-settings': () => ({
    available: false,
    enabled: false,
    provider: null,
    region: null,
    retention: null,
  }),
};

const delivery = (over: Partial<DeliveryItem>): DeliveryItem => ({
  id: 'x1',
  kind: 'incident_opened',
  status: 'sent',
  attempts: 1,
  lastError: null,
  nextAttemptAt: '2026-10-17T12:00:00.000Z',
  incidentId: 'i1',
  createdAt: '2026-10-17T11:00:00.000Z',
  sentAt: null,
  ...over,
});

const user = () => userEvent.setup();

describe('Alert destinations', () => {
  it('lists destinations without any secret text', async () => {
    routeApi({
      ...base,
      [LIST]: () => [
        dest({}),
        dest({ id: 'd2', name: 'Team Slack', type: 'slack', recipients: [], hasSecret: true }),
        dest({
          id: 'd3',
          name: 'Old hook',
          type: 'webhook',
          url: 'https://h.example/x',
          status: 'archived',
        }),
      ],
    });
    renderSettings();
    const table = await screen.findByRole('table', { name: 'Alert destinations' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('a@example.com, b@example.com');
    expect(rows[0]).toHaveTextContent('Opened, Reopened');
    expect(rows[1]).toHaveTextContent('Slack incoming webhook');
    expect(rows[2]).toHaveTextContent('https://h.example/x');
    expect(rows[2]).toHaveTextContent('Archived');
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    expect(table).not.toHaveTextContent(/hooks\.slack|whsec_/i);
  });

  it('is hidden and not fetched for an engineer', async () => {
    const calls = routeApi({});
    renderSettings('engineer');
    await screen.findByRole('heading', { name: "You can't manage members" });
    expect(screen.queryByRole('heading', { name: 'Alert destinations' })).toBeNull();
    expect(calls.filter((c) => c.key.includes('/destinations'))).toEqual([]);
  });

  it('creates an email destination with split recipients', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [],
      [`POST ${BASE}`]: () => reply(201, dest({})),
    });
    renderSettings();
    expect(await screen.findByText('No alert destinations')).toBeVisible();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Add destination' }));
    await u.type(screen.getByLabelText('Name'), 'On-call email');
    await u.type(
      screen.getByLabelText('Recipients (comma separated, up to 10)'),
      ' a@example.com, b@example.com ,',
    );
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
        type: 'email',
        name: 'On-call email',
        recipients: ['a@example.com', 'b@example.com'],
        events: ['incident_opened', 'incident_reopened', 'incident_assigned'],
      }),
    );
  });

  it('shows a webhook signing secret once', async () => {
    routeApi({
      ...base,
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(201, {
          ...dest({ type: 'webhook', url: 'https://h.example/x' }),
          signingSecret: 'whsec_abc123',
        }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await u.selectOptions(screen.getByLabelText('Type'), 'webhook');
    await u.type(screen.getByLabelText('Name'), 'Hook');
    await u.type(screen.getByLabelText('Webhook address (https)'), 'https://h.example/x');
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    expect(await screen.findByText('whsec_abc123')).toBeVisible();
    expect(screen.getByText(/copy it now, it is not shown again/)).toBeVisible();
    await u.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('whsec_abc123')).toBeNull();
  });

  it('needs at least one alert chosen', async () => {
    const calls = routeApi({ ...base, [LIST]: () => [] });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await u.type(screen.getByLabelText('Name'), 'X');
    await u.type(screen.getByLabelText(/^Recipients/), 'a@example.com');
    for (const label of ['Opened', 'Reopened', 'Assigned']) {
      await u.click(screen.getByRole('checkbox', { name: label }));
    }
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one alert.');
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('shows the server reason when a name is taken', async () => {
    routeApi({
      ...base,
      [LIST]: () => [],
      [`POST ${BASE}`]: () => reply(409, { code: 'conflict', title: 'Conflict' }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await u.type(screen.getByLabelText('Name'), 'X');
    await u.type(screen.getByLabelText(/^Recipients/), 'a@example.com');
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A destination with this name already exists.',
    );
  });

  it('asks before sending a test, then says it is queued', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({})],
      [`POST ${BASE}/d1/test`]: () => reply(202, { deliveryId: 'x', status: 'pending' }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Send test to On-call email' }));
    const dialog = screen.getByRole('dialog', { name: 'Send a test message?' });
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Send test message' }));
    expect(await screen.findByText(/Test message queued/)).toBeVisible();
    expect(calls.find((c) => c.key === `POST ${BASE}/d1/test`)?.body).toEqual({ confirm: true });
  });

  it('explains a test sent too soon', async () => {
    routeApi({
      ...base,
      [LIST]: () => [dest({})],
      [`POST ${BASE}/d1/test`]: () => reply(429, { code: 'test_too_soon', title: 'Too soon' }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Send test to On-call email' }));
    await u.click(screen.getByRole('button', { name: 'Send test message' }));
    expect(await screen.findByText('A test was sent a moment ago. Wait a minute.')).toBeVisible();
  });

  it('pauses a destination', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({})],
      [`PATCH ${BASE}/d1`]: () => dest({ status: 'paused' }),
    });
    renderSettings();
    await user().click(await screen.findByRole('button', { name: 'Pause On-call email' }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.key === `PATCH ${BASE}/d1`)?.body).toEqual({ status: 'paused' }),
    );
  });

  it('archives only after confirming', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({})],
      [`DELETE ${BASE}/d1`]: () => ({}),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Archive On-call email' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive On-call email?' });
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Archive destination' }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === `DELETE ${BASE}/d1`)).toBe(true));
  });

  it('shows delivery states in plain words and retries a failed one', async () => {
    const items = [
      delivery({ id: 'a', status: 'pending', attempts: 0 }),
      delivery({ id: 'b', status: 'pending', attempts: 2 }),
      delivery({ id: 'c', status: 'failed', attempts: 5, lastError: 'webhook_http_503' }),
      delivery({ id: 'd', status: 'sent' }),
      delivery({
        id: 'e',
        status: 'suppressed',
        kind: 'destination_test',
        lastError: 'no_recipients',
      }),
    ];
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({})],
      [`GET ${BASE}/d1/deliveries`]: () => items,
      [`POST ${BASE}/d1/deliveries/c/retry`]: () => reply(202, {}),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Deliveries for On-call email' }));
    const table = await screen.findByRole('table', { name: 'Deliveries for On-call email' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Waiting');
    expect(rows[1]).toHaveTextContent(/Retrying, next try/);
    expect(rows[2]).toHaveTextContent('Failed');
    expect(rows[2]).toHaveTextContent('The receiver answered with an error (503)');
    expect(rows[3]).toHaveTextContent('Sent');
    expect(rows[4]).toHaveTextContent('Skipped');
    expect(rows[4]).toHaveTextContent('Test message');
    expect(rows[4]).toHaveTextContent('No recipients');
    await u.click(within(table).getByRole('button', { name: 'Retry Opened' }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.key === `GET ${BASE}/d1/deliveries`)).toHaveLength(2),
    );
    expect(calls.some((c) => c.key === `POST ${BASE}/d1/deliveries/c/retry`)).toBe(true);
  });

  it('offers Rotate secret only on active Slack and webhook rows', async () => {
    routeApi({
      ...base,
      [LIST]: () => [
        dest({}),
        dest({ id: 'd2', name: 'Team Slack', type: 'slack', recipients: [] }),
        dest({ id: 'd3', name: 'Hook', type: 'webhook', url: 'https://h.example/x' }),
        dest({
          id: 'd4',
          name: 'Old hook',
          type: 'webhook',
          url: 'https://h.example/y',
          status: 'archived',
        }),
      ],
    });
    renderSettings();
    await screen.findByRole('table', { name: 'Alert destinations' });
    expect(screen.queryByRole('button', { name: 'Rotate secret for On-call email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate secret for Old hook' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rotate secret for Team Slack' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rotate secret for Hook' })).toBeVisible();
  });

  it('rotates a Slack URL without showing it back', async () => {
    const url = 'https://hooks.slack.com/services/T1/B2/abc';
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({ id: 'd2', name: 'Team Slack', type: 'slack', recipients: [] })],
      [`POST ${BASE}/d2/rotate-secret`]: () => reply(200, dest({ id: 'd2', type: 'slack' })),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Rotate secret for Team Slack' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('New Slack incoming webhook URL'), url);
    await u.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await screen.findByText('Secret rotated.')).toBeVisible();
    expect(calls.find((c) => c.key === `POST ${BASE}/d2/rotate-secret`)?.body).toEqual({
      webhookUrl: url,
    });
    expect(document.body.textContent).not.toContain(url);
  });

  it('shows the server reason when a Slack rotation fails', async () => {
    routeApi({
      ...base,
      [LIST]: () => [dest({ id: 'd2', name: 'Team Slack', type: 'slack', recipients: [] })],
      [`POST ${BASE}/d2/rotate-secret`]: () =>
        reply(400, { code: 'invalid', title: 'Invalid', detail: 'Use the Slack URL.' }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Rotate secret for Team Slack' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('New Slack incoming webhook URL'), 'nope');
    await u.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use the Slack URL.');
  });

  it('rotates a webhook secret after confirming and shows it once', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [dest({ id: 'd3', name: 'Hook', type: 'webhook', url: 'https://h.example/x' })],
      [`POST ${BASE}/d3/rotate-secret`]: () =>
        reply(200, { ...dest({ id: 'd3', type: 'webhook' }), signingSecret: 'whsec_new999' }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Rotate secret for Hook' }));
    const dialog = screen.getByRole('dialog', { name: 'Rotate the signing secret?' });
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await screen.findByText('whsec_new999')).toBeVisible();
    expect(screen.getByText(/New signing secret \(copy it now/)).toBeVisible();
    expect(calls.find((c) => c.key === `POST ${BASE}/d3/rotate-secret`)?.body).toEqual({});
    await u.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('whsec_new999')).toBeNull();
  });

  it('offers only the enabled destination types', async () => {
    routeApi({
      ...base,
      [`GET ${BASE}/options`]: () => ({ types: ['email', 'slack', 'webhook', 'github'] }),
      [LIST]: () => [],
    });
    renderSettings();
    await user().click(await screen.findByRole('button', { name: 'Add destination' }));
    await vi.waitFor(() =>
      expect(
        within(screen.getByLabelText('Type'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Email', 'Slack', 'Webhook', 'GitHub issue']),
    );
  });

  async function openGithubForm() {
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('option', { name: 'GitHub issue' })).toBeVisible(),
    );
    await u.selectOptions(screen.getByLabelText('Type'), 'github');
    return u;
  }

  const allTypes = { types: ['email', 'slack', 'webhook', 'github', 'n8n'] };

  it('creates a GitHub destination and never shows the token back', async () => {
    const token = 'github_pat_SECRET123';
    const calls = routeApi({
      ...base,
      [`GET ${BASE}/options`]: () => allTypes,
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(201, dest({ type: 'github', repository: 'acme/data', recipients: [] })),
    });
    renderSettings();
    const u = await openGithubForm();
    expect(screen.queryByRole('group', { name: 'Send alerts for' })).toBeNull();
    expect(screen.getByText('Opens one issue for each new incident.')).toBeVisible();
    await u.type(screen.getByLabelText('Name'), 'Issues');
    await u.type(screen.getByLabelText('Repository owner'), 'acme');
    await u.type(screen.getByLabelText('Repository name'), 'data');
    await u.type(screen.getByLabelText(/^GitHub access token/), token);
    await u.type(screen.getByLabelText(/^Labels/), 'a, b');
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
        type: 'github',
        name: 'Issues',
        owner: 'acme',
        repo: 'data',
        token,
        labels: ['a', 'b'],
      }),
    );
    expect(document.body.textContent).not.toContain(token);
  });

  it('shows an n8n signing secret once', async () => {
    routeApi({
      ...base,
      [`GET ${BASE}/options`]: () => allTypes,
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(201, {
          ...dest({ type: 'n8n', url: 'https://n.example/h' }),
          signingSecret: 'whsec_n8n1',
        }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await vi.waitFor(() => expect(screen.getByRole('option', { name: 'n8n' })).toBeVisible());
    await u.selectOptions(screen.getByLabelText('Type'), 'n8n');
    await u.type(screen.getByLabelText('Name'), 'Flow');
    await u.type(screen.getByLabelText('n8n webhook address (https)'), 'https://n.example/h');
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    expect(await screen.findByText('whsec_n8n1')).toBeVisible();
    await u.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('whsec_n8n1')).toBeNull();
  });

  it('rotates a GitHub token', async () => {
    const calls = routeApi({
      ...base,
      [LIST]: () => [
        dest({ id: 'd5', name: 'Issues', type: 'github', repository: 'acme/data', recipients: [] }),
      ],
      [`POST ${BASE}/d5/rotate-secret`]: () => reply(200, dest({ id: 'd5', type: 'github' })),
    });
    renderSettings();
    const u = user();
    expect(await screen.findByText('acme/data')).toBeVisible();
    await u.click(screen.getByRole('button', { name: 'Rotate secret for Issues' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('New GitHub access token'), 'tok_new');
    await u.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await screen.findByText('Secret rotated.')).toBeVisible();
    expect(calls.find((c) => c.key === `POST ${BASE}/d5/rotate-secret`)?.body).toEqual({
      token: 'tok_new',
    });
    expect(document.body.textContent).not.toContain('tok_new');
  });

  it('shows the reason when a type is turned off', async () => {
    routeApi({
      ...base,
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(409, {
          code: 'feature_disabled',
          title: 'Off',
          detail: 'GitHub issues are turned off.',
        }),
    });
    renderSettings();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Add destination' }));
    await u.type(screen.getByLabelText('Name'), 'X');
    await u.type(screen.getByLabelText(/^Recipients/), 'a@example.com');
    await u.click(screen.getByRole('button', { name: 'Create destination' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub issues are turned off.');
  });
});
