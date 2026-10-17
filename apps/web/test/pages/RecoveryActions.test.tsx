import type { ActionItem, ActionOptions, ActionStatus, Role } from '@datasentinel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RecoveryActionsPanel } from '../../src/incidents/RecoveryActionsPanel.tsx';
import { reply, routeApi } from '../api.ts';

const LIST = 'GET /workspaces/w1/incidents/i1/actions';
const OPTIONS = 'GET /workspaces/w1/incidents/i1/actions/options';
const CREATE = 'POST /workspaces/w1/incidents/i1/actions';
const APPROVE = 'POST /workspaces/w1/actions/a1/approve';
const REJECT = 'POST /workspaces/w1/actions/a1/reject';
const CANCEL = 'POST /workspaces/w1/actions/a1/cancel';

const action = (extra: Partial<ActionItem> = {}): ActionItem => ({
  id: 'a1',
  type: 'rerun_validation',
  status: 'proposed',
  payload: { ruleId: 'r1' },
  payloadHash: 'abcdef123456',
  preview: {
    title: 'Run the rule "Orders" again',
    steps: ['Queue one new check.', 'Nothing is changed in the source.'],
    leavesDataSentinel: false,
  },
  note: null,
  proposedByName: 'Ana',
  decidedByName: null,
  decisionNote: null,
  proposalExpiresAt: '2026-10-18T10:00:00.000Z',
  approvalExpiresAt: null,
  attempts: 0,
  failureCode: null,
  output: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  finishedAt: null,
  events: [
    {
      id: 'e1',
      type: 'proposed',
      actorType: 'user',
      actorName: 'Ana',
      data: {},
      createdAt: '2026-10-17T10:00:00.000Z',
    },
    {
      id: 'e2',
      type: 'started',
      actorType: 'system',
      actorName: null,
      data: {},
      createdAt: '2026-10-17T10:05:00.000Z',
    },
  ],
  can: { approve: false, reject: false, cancel: false },
  ...extra,
});

const options: ActionOptions = {
  rules: [{ id: 'rule-1', name: 'Orders rule' }],
  uploads: [{ id: 'up-1', filename: 'orders.csv' }],
  destinations: [
    { id: 'd-mail', name: 'Ops mail', type: 'email' },
    { id: 'd-gh', name: 'Repo', type: 'github' },
    { id: 'd-n8n', name: 'Flow', type: 'n8n' },
  ],
};

const renderAs = (role: Role, pollMs = 20) =>
  render(<RecoveryActionsPanel workspaceId="w1" incidentId="i1" role={role} pollMs={pollMs} />);

describe('Recovery actions panel', () => {
  it('shows each fact of a proposed action', async () => {
    routeApi({
      [LIST]: () => [
        action({
          note: 'Looks stuck',
          preview: { ...action().preview, leavesDataSentinel: true },
        }),
      ],
    });
    renderAs('viewer');
    expect(await screen.findByText('Waiting for approval')).toBeVisible();
    expect(screen.getByText('Queue one new check.')).toBeVisible();
    expect(screen.getByText('This sends something outside DataSentinel.')).toBeVisible();
    expect(screen.getByText('Proposed by Ana: Looks stuck')).toBeVisible();
    expect(screen.getByText(/^Proposal expires /)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Waiting for another person/)).toBeNull();
  });

  it('shows approval code, expiry, decider, and history', async () => {
    routeApi({
      [LIST]: () => [
        action({
          status: 'approved',
          decidedByName: 'Eve',
          decisionNote: 'Fine',
          approvalExpiresAt: '2026-10-18T11:00:00.000Z',
        }),
      ],
    });
    renderAs('viewer');
    expect(await screen.findByText('Approved, waiting to run')).toBeVisible();
    expect(screen.getByText('Approved by Eve: Fine')).toBeVisible();
    expect(
      screen.getByText(
        /Approval is only for this exact action \(code abcdef123456\) and is valid until /,
      ),
    ).toBeVisible();
    expect(screen.getByText('Proposed · Ana · ', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/^Started · DataSentinel · /)).toBeInTheDocument();
  });

  it('shows failure reasons and results', async () => {
    routeApi({
      [LIST]: () => [
        action({ id: 'a2', status: 'failed', failureCode: 'payload_changed' }),
        action({ id: 'a3', status: 'succeeded', output: { checkRunId: 'c1' } }),
        action({ id: 'a4', status: 'succeeded', output: { uploadId: 'u1' } }),
        action({ id: 'a5', status: 'succeeded', output: { deliveryId: 'd1' } }),
      ],
    });
    renderAs('viewer');
    expect(await screen.findByText('The action no longer matched what was approved')).toBeVisible();
    expect(screen.getByText('A new check was queued')).toBeVisible();
    expect(screen.getByText('The file was queued for processing again')).toBeVisible();
    expect(screen.getByText(/A notice was queued for delivery\./)).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
    expect(screen.getAllByText('Done')).toHaveLength(3);
  });

  it('shows the waiting hint only to engineers who cannot approve', async () => {
    routeApi({ [LIST]: () => [action()] });
    renderAs('engineer');
    expect(
      await screen.findByText('Waiting for another person with the right role to approve.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Approve|Reject|Withdraw/ })).toBeNull();
  });

  it('asks before approving, then posts', async () => {
    const calls = routeApi({
      [LIST]: () => [action({ can: { approve: true, reject: true, cancel: false } })],
      [APPROVE]: () => action({ status: 'approved' }),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: /^Approve Run the rule/ }));
    expect(await screen.findByText('Approve this action?')).toBeVisible();
    expect(
      screen.getByText(/You are approving exactly this action \(code abcdef123456\)\./),
    ).toBeVisible();
    expect(calls.some((c) => c.key === APPROVE)).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Approve action' }));
    await waitFor(() => expect(calls.some((c) => c.key === APPROVE)).toBe(true));
    expect(calls.filter((c) => c.key === LIST).length).toBeGreaterThan(1);
  });

  it('rejects after confirming', async () => {
    const calls = routeApi({
      [LIST]: () => [action({ can: { approve: true, reject: true, cancel: false } })],
      [REJECT]: () => action({ status: 'rejected' }),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: /^Reject Run the rule/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reject action' }));
    await waitFor(() => expect(calls.some((c) => c.key === REJECT)).toBe(true));
  });

  it('withdraws', async () => {
    const calls = routeApi({
      [LIST]: () => [action({ can: { approve: false, reject: false, cancel: true } })],
      [CANCEL]: () => action({ status: 'cancelled' }),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: /^Withdraw Run the rule/ }));
    await waitFor(() => expect(calls.some((c) => c.key === CANCEL)).toBe(true));
  });

  it('shows a self-approval conflict', async () => {
    routeApi({
      [LIST]: () => [action({ can: { approve: true, reject: true, cancel: false } })],
      [APPROVE]: () =>
        reply(409, {
          code: 'self_approval',
          title: 'Not allowed',
          detail: 'You proposed this action, so someone else must approve it.',
        }),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: /^Approve Run the rule/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve action' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('someone else must approve');
  });

  it('lists only the types an analyst may propose and posts the exact body', async () => {
    const calls = routeApi({
      [LIST]: () => [],
      [OPTIONS]: () => options,
      [CREATE]: () => reply(201, action()),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Propose an action' }));
    const select = await screen.findByLabelText('Action');
    const names = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(names).toEqual(['Run a rule again', 'Send an incident notice']);
    await screen.findByLabelText('Rule');
    await userEvent.type(screen.getByLabelText(/^Why/), 'Try it');
    await userEvent.click(screen.getByRole('button', { name: 'Propose action' }));
    await waitFor(() => expect(calls.some((c) => c.key === CREATE)).toBe(true));
    expect(calls.find((c) => c.key === CREATE)?.body).toEqual({
      type: 'rerun_validation',
      payload: { ruleId: 'rule-1' },
      note: 'Try it',
    });
    await waitFor(() => expect(screen.queryByLabelText('Action')).toBeNull());
  });

  it('builds the body for every other type as an engineer', async () => {
    const calls = routeApi({
      [LIST]: () => [],
      [OPTIONS]: () => options,
      [CREATE]: () => reply(201, action()),
    });
    const cases: [string, string, unknown][] = [
      ['retry_import', 'Failed file', { uploadId: 'up-1' }],
      ['send_notification', 'Destination', { destinationId: 'd-mail' }],
      ['create_github_issue', 'Destination', { destinationId: 'd-gh' }],
      ['trigger_n8n', 'Destination', { destinationId: 'd-n8n' }],
    ];
    renderAs('engineer');
    for (const [type, label, payload] of cases) {
      if (screen.queryByLabelText('Action') === null) {
        await userEvent.click(await screen.findByRole('button', { name: 'Propose an action' }));
      }
      await userEvent.selectOptions(await screen.findByLabelText('Action'), type);
      await screen.findByLabelText(label);
      await userEvent.click(screen.getByRole('button', { name: 'Propose action' }));
      await waitFor(() => expect(calls.filter((c) => c.key === CREATE).length).toBeGreaterThan(0));
      await waitFor(() =>
        expect(calls.filter((c) => c.key === CREATE).map((c) => c.body)).toContainEqual({
          type,
          payload,
        }),
      );
      await waitFor(() => expect(screen.queryByLabelText('Action')).toBeNull());
    }
  });

  it('says nothing is available and disables submit', async () => {
    routeApi({
      [LIST]: () => [],
      [OPTIONS]: () => ({ ...options, rules: [] }),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Propose an action' }));
    expect(await screen.findByText('Nothing is available for this action.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Propose action' })).toBeDisabled();
  });

  it('shows server errors when proposing', async () => {
    routeApi({
      [LIST]: () => [],
      [OPTIONS]: () => options,
      [CREATE]: () =>
        reply(409, { code: 'action_already_pending', title: 'Busy', detail: 'One is pending.' }),
    });
    renderAs('analyst');
    await userEvent.click(await screen.findByRole('button', { name: 'Propose an action' }));
    await screen.findByLabelText('Rule');
    await userEvent.click(screen.getByRole('button', { name: 'Propose action' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('One is pending.');
  });

  it('gives viewers no propose button', async () => {
    routeApi({ [LIST]: () => [] });
    renderAs('viewer');
    expect(await screen.findByText(/No recovery action has been proposed/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('polls only while an action is approved or running', async () => {
    let lists = 0;
    const statuses: ActionStatus[] = ['approved', 'running', 'succeeded'];
    const calls = routeApi({
      [LIST]: () => {
        const status = statuses[Math.min(lists, statuses.length - 1)] ?? 'succeeded';
        lists += 1;
        return [action({ status })];
      },
    });
    renderAs('viewer');
    expect(await screen.findByText('Done')).toBeVisible();
    const total = calls.filter((c) => c.key === LIST).length;
    expect(total).toBe(3);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.filter((c) => c.key === LIST).length).toBe(total);
  });

  it('does not poll a proposed action', async () => {
    const calls = routeApi({ [LIST]: () => [action()] });
    renderAs('viewer');
    await screen.findByText('Waiting for approval');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((c) => c.key === LIST).length).toBe(1);
  });
});
