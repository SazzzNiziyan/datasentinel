import type { AiSettings, Role } from '@datasentinel/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiSettingsPanel } from '../../src/settings/AiSettingsPanel.tsx';
import { reply, routeApi } from '../api.ts';

const GET = 'GET /workspaces/w1/ai-settings';
const PUT = 'PUT /workspaces/w1/ai-settings';

const settings = (extra: Partial<AiSettings> = {}): AiSettings => ({
  available: true,
  enabled: false,
  provider: 'Acme AI',
  region: 'EU',
  retention: 'none',
  ...extra,
});

const renderAs = (role: Role) => render(<AiSettingsPanel workspaceId="w1" role={role} />);

describe('AI settings panel', () => {
  it('says AI is not available in this deployment', async () => {
    routeApi({ [GET]: () => settings({ available: false, provider: null }) });
    renderAs('owner');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'AI investigation is not available in this deployment.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('needs the acknowledgement before turning on, then sends it', async () => {
    let current = settings();
    const calls = routeApi({
      [GET]: () => current,
      [PUT]: () => {
        current = settings({ enabled: true });
        return current;
      },
    });
    renderAs('admin');
    expect(await screen.findByText('Provider')).toBeVisible();
    expect(screen.getByText('Acme AI')).toBeVisible();
    expect(screen.getByText('Off')).toBeVisible();
    const button = screen.getByRole('button', { name: 'Turn on AI investigation' });
    expect(button).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /I understand that redacted incident facts will be sent to Acme AI in EU\. Retention: none\./,
      }),
    );
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Turn off AI investigation' })).toBeVisible();
    expect(screen.getByText('On')).toBeVisible();
    expect(calls.find((c) => c.key === PUT)?.body).toEqual({ enabled: true, acknowledge: true });
  });

  it('turns AI off', async () => {
    let current = settings({ enabled: true });
    const calls = routeApi({
      [GET]: () => current,
      [PUT]: () => {
        current = settings();
        return current;
      },
    });
    renderAs('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off AI investigation' }));
    expect(await screen.findByRole('button', { name: 'Turn on AI investigation' })).toBeVisible();
    expect(calls.find((c) => c.key === PUT)?.body).toEqual({ enabled: false });
  });

  it('shows the status only to others', async () => {
    routeApi({ [GET]: () => settings({ enabled: true }) });
    renderAs('analyst');
    expect(await screen.findByText('On')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows a server error', async () => {
    routeApi({
      [GET]: () => settings(),
      [PUT]: () =>
        reply(409, { code: 'ai_unavailable', title: 'Unavailable', detail: 'Not configured.' }),
    });
    renderAs('admin');
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI investigation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not configured.');
  });
});
