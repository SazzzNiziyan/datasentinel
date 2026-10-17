import type { PipelineRunListItem } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PipelineRunsPage } from '../../src/runs/PipelineRunsPage.tsx';
import { routeApi } from '../api.ts';
import { WithSession } from '../session.tsx';

const run = (id: string, over: Partial<PipelineRunListItem> = {}): PipelineRunListItem => ({
  id,
  sourceId: 's1',
  datasetId: null,
  externalRunId: `ext-${id}`,
  name: `job-${id}`,
  status: 'succeeded',
  trigger: 'schedule',
  startedAt: null,
  endedAt: null,
  lastEventAt: '2026-10-17T10:00:00.000Z',
  correlationId: null,
  summary: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  sourceName: 'airflow_prod',
  datasetName: null,
  ...over,
});

const sources = [
  { id: 's1', name: 'airflow_prod', type: 'pipeline_event' },
  { id: 's2', name: 'warehouse', type: 'postgres' },
];

const base = 'GET /workspaces/w1/pipeline-runs';

function renderPage() {
  render(
    <WithSession>
      <MemoryRouter>
        <PipelineRunsPage />
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Pipeline runs page', () => {
  it('lists runs newest first with source and status words', async () => {
    routeApi({
      'GET /workspaces/w1/sources': () => sources,
      [`${base}?limit=25`]: () => ({
        runs: [
          run('a', { status: 'failed', datasetName: 'Orders' }),
          run('b', { sourceName: 'dbt_cloud' }),
        ],
        nextCursor: null,
      }),
    });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Pipeline run timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('job-a failed (Orders)');
    expect(items[0]).toHaveTextContent('airflow_prod');
    expect(items[1]).toHaveTextContent('job-b succeeded');
    expect(items[1]).toHaveTextContent('dbt_cloud');
    expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull();
  });

  it('refetches from page one when the status filter changes', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => sources,
      [`${base}?limit=25`]: () => ({ runs: [run('a')], nextCursor: null }),
      [`${base}?status=failed&limit=25`]: () => ({
        runs: [run('f', { status: 'failed' })],
        nextCursor: null,
      }),
    });
    renderPage();
    await screen.findByText(/job-a succeeded/);
    await user.selectOptions(screen.getByLabelText('Status'), 'Failed');
    expect(await screen.findByText(/job-f failed/)).toBeVisible();
    expect(screen.queryByText(/job-a/)).toBeNull();
    expect(calls.map((c) => c.key)).toContain(`${base}?status=failed&limit=25`);
    expect(screen.getByRole('option', { name: 'airflow_prod' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'warehouse' })).toBeNull();
  });

  it('appends older runs and hides the button on the last page', async () => {
    const user = userEvent.setup();
    const cursor = '2026-10-17T10:00:00.000Z_00000000-0000-0000-0000-000000000001';
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => sources,
      [`${base}?limit=25`]: () => ({ runs: [run('a')], nextCursor: cursor }),
      [`${base}?limit=25&cursor=${encodeURIComponent(cursor)}`]: () => ({
        runs: [run('b')],
        nextCursor: null,
      }),
    });
    renderPage();
    await screen.findByText(/job-a/);
    await user.click(screen.getByRole('button', { name: 'Show older runs' }));
    expect(await screen.findByText(/job-b/)).toBeVisible();
    expect(screen.getByText(/job-a/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull();
    expect(calls.some((c) => c.key.includes('cursor='))).toBe(true);
  });

  it('explains an empty list and a filter with no matches', async () => {
    const user = userEvent.setup();
    routeApi({
      'GET /workspaces/w1/sources': () => sources,
      [`${base}?limit=25`]: () => ({ runs: [], nextCursor: null }),
      [`${base}?status=failed&limit=25`]: () => ({ runs: [], nextCursor: null }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No pipeline runs yet' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Status'), 'Failed');
    expect(
      await screen.findByRole('heading', { name: 'No runs match these filters' }),
    ).toBeVisible();
  });
});
