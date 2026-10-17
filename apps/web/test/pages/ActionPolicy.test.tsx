import type { Role } from '@datasentinel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActionPolicyPanel } from '../../src/settings/ActionPolicyPanel.tsx';
import { reply, routeApi } from '../api.ts';

const GET = 'GET /workspaces/w1/action-policy';
const PUT = 'PUT /workspaces/w1/action-policy';

const renderAs = (role: Role) => render(<ActionPolicyPanel workspaceId="w1" role={role} />);

describe('Action policy panel', () => {
  it('lets an owner turn the second approver off', async () => {
    let on = true;
    const calls = routeApi({
      [GET]: () => ({ requireSecondApprover: on }),
      [PUT]: (body) => {
        on = (body as { requireSecondApprover: boolean }).requireSecondApprover;
        return { requireSecondApprover: on };
      },
    });
    renderAs('owner');
    expect(await screen.findByText('Two people required')).toBeVisible();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Require a second person to approve actions' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.key === PUT)?.body).toEqual({ requireSecondApprover: false }),
    );
    expect(await screen.findByText('One person may propose and approve')).toBeVisible();
  });

  it('shows the state only to other roles', async () => {
    routeApi({ [GET]: () => ({ requireSecondApprover: false }) });
    renderAs('admin');
    expect(await screen.findByText('One person may propose and approve')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows server errors', async () => {
    routeApi({
      [GET]: () => ({ requireSecondApprover: true }),
      [PUT]: () => reply(403, { code: 'forbidden', title: 'No', detail: 'Owners only.' }),
    });
    renderAs('owner');
    await userEvent.click(await screen.findByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Owners only.');
  });
});
