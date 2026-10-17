import type { RuleDetail } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DatasetRules } from '../../src/rules/DatasetRules.tsx';
import { routeApi } from '../api.ts';

const rule: RuleDetail = {
  id: 'r1',
  datasetId: 'd9',
  name: 'Customers have an email',
  type: 'not_null',
  severity: 'critical',
  enabled: true,
  version: 1,
  definition: { version: 1, type: 'not_null', column: 'email', maxNullPercent: 0 },
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  recentRuns: [],
};

const run = (status: 'queued' | 'passed') => ({
  id: 'c1',
  ruleVersion: 1,
  trigger: 'manual',
  status,
  expected: null,
  actual: null,
  error: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
});

const columns = [
  { name: 'id', type: 'integer' },
  { name: 'email', type: 'text' },
];

function renderRules(editable = true) {
  // Strict mode mounts twice, like development; run-now must survive it.
  render(
    <StrictMode>
      <MemoryRouter>
        <DatasetRules
          workspaceId="w1"
          datasetId="d9"
          datasetName="Customers"
          csv
          active
          editable={editable}
          columns={columns}
        />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('Dataset rules', () => {
  it('lists each rule with its condition in plain words, read-only for viewers', async () => {
    routeApi({ 'GET /workspaces/w1/datasets/d9/rules': () => [rule] });
    renderRules(false);
    const table = await screen.findByRole('table', { name: 'Rules checked on this dataset' });
    expect(within(table).getByText('Fails when any email value is empty.')).toBeInTheDocument();
    expect(within(table).getByText('Not run yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument();
  });

  it('builds a rule: problems first, then a preview, then one save', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/datasets/d9/rules': [() => [], () => [rule]],
      'POST /workspaces/w1/datasets/d9/rules': () => rule,
    });
    renderRules();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a rule to Customers' });
    await user.type(within(dialog).getByLabelText('Name'), 'Customers have an email');
    await user.selectOptions(within(dialog).getByLabelText('What to check'), 'Empty values');
    const preview = within(dialog).getByRole('status');
    expect(preview).toHaveTextContent('Column: Choose a column.');
    expect(within(dialog).getByRole('button', { name: 'Save rule' })).toBeDisabled();

    await user.selectOptions(within(dialog).getByLabelText('Column'), 'email');
    expect(preview).toHaveTextContent('Fails when any email value is empty.');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));

    expect(calls.find((c) => c.key === 'POST /workspaces/w1/datasets/d9/rules')?.body).toEqual({
      name: 'Customers have an email',
      severity: 'warning',
      definition: { version: 1, type: 'not_null', column: 'email', maxNullPercent: 0 },
    });
    const table = screen.getByRole('table', { name: 'Rules checked on this dataset' });
    // The name also labels the row's Run now button, so match the condition.
    expect(
      await within(table).findByText('Fails when any email value is empty.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('runs a rule now and shows the result once it finishes', async () => {
    const user = userEvent.setup();
    const done = { ...rule, recentRuns: [run('passed')] };
    routeApi({
      'GET /workspaces/w1/datasets/d9/rules': [() => [rule], () => [done]],
      'POST /workspaces/w1/rules/r1/runs': () => run('queued'),
      'GET /workspaces/w1/rules/r1': () => done,
    });
    renderRules();
    await user.click(
      await screen.findByRole('button', { name: 'Run now Customers have an email' }),
    );
    expect(await screen.findByText('Passed', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
