import type { ScheduleDetail } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DatasetSchedules } from '../../src/schedules/DatasetSchedules.tsx';
import { routeApi } from '../api.ts';

const schedule: ScheduleDetail = {
  id: 's1',
  datasetId: 'd9',
  ruleId: null,
  target: 'dataset',
  definition: { version: 1, kind: 'interval', everyMinutes: 60 },
  enabled: true,
  nextRunAt: '2026-10-17T11:00:00.000Z',
  lastRunAt: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  recentOccurrences: [],
};

const listPath = 'GET /workspaces/w1/datasets/d9/schedules';
const rulesPath = 'GET /workspaces/w1/datasets/d9/rules';

function renderSchedules(editable = true) {
  render(
    <StrictMode>
      <MemoryRouter>
        <DatasetSchedules workspaceId="w1" datasetId="d9" editable={editable} />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('Dataset schedules', () => {
  it('lists schedules read-only for viewers', async () => {
    routeApi({ [listPath]: () => [schedule], [rulesPath]: () => [] });
    renderSchedules(false);
    const table = await screen.findByRole('table', { name: 'Schedules on this dataset' });
    expect(within(table).getByText('Every hour')).toBeInTheDocument();
    expect(within(table).getByText('Whole dataset')).toBeInTheDocument();
    expect(within(table).getByText('Not run yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pause/ })).not.toBeInTheDocument();
  });

  it('resumes a paused schedule', async () => {
    const user = userEvent.setup();
    const paused = { ...schedule, enabled: false, nextRunAt: null };
    let resumed = false;
    const calls = routeApi({
      [listPath]: () => [resumed ? schedule : paused],
      [rulesPath]: () => [],
      'PATCH /workspaces/w1/schedules/s1': () => {
        resumed = true;
        return schedule;
      },
    });
    renderSchedules();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Resume/ }));
    await screen.findByRole('button', { name: /Pause/ });
    expect(calls.find((c) => c.key.startsWith('PATCH'))?.body).toEqual({ enabled: true });
  });

  it('adds a schedule at set times of day', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      [listPath]: [() => [], () => [schedule]],
      [rulesPath]: () => [],
      'POST /workspaces/w1/datasets/d9/schedules': () => schedule,
    });
    renderSchedules();
    await user.click(await screen.findByRole('button', { name: 'Add schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add schedule' });
    await user.click(within(dialog).getByLabelText('At set times of day'));
    const times = within(dialog).getByLabelText('Times (24-hour, comma-separated)');
    await user.clear(times);
    await user.type(times, '06:00, 18:30');
    const zone = within(dialog).getByLabelText('Time zone');
    await user.clear(zone);
    await user.type(zone, 'Europe/Berlin');
    await user.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    expect(calls.find((c) => c.key.startsWith('POST'))?.body).toEqual({
      definition: {
        version: 1,
        kind: 'calendar',
        times: ['06:00', '18:30'],
        timezone: 'Europe/Berlin',
      },
    });
  });

  it('explains problems and sends nothing', async () => {
    const user = userEvent.setup();
    const calls = routeApi({ [listPath]: () => [], [rulesPath]: () => [] });
    renderSchedules();
    await user.click(await screen.findByRole('button', { name: 'Add schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add schedule' });
    await user.click(within(dialog).getByLabelText('At set times of day'));
    const times = within(dialog).getByLabelText('Times (24-hour, comma-separated)');
    await user.clear(times);
    await user.type(times, '06:00, 06:05');
    const zone = within(dialog).getByLabelText('Time zone');
    await user.clear(zone);
    await user.type(zone, 'Europe/Berlin');
    await user.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Times must be at least 15 minutes apart.',
    );
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });
});
