import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { IncidentsPage } from '../../src/pages/IncidentsPage.tsx';
import { OverviewPage } from '../../src/pages/OverviewPage.tsx';
import { SettingsPage } from '../../src/pages/SettingsPage.tsx';
import { WithSession } from '../session.tsx';

function renderPage(page: ReactNode) {
  render(
    <WithSession>
      <MemoryRouter>{page}</MemoryRouter>
    </WithSession>,
  );
}

/** Data rows of a table found by its caption (the header row is skipped). */
function bodyRows(caption: string) {
  const table = screen.getByRole('table', { name: caption });
  return within(table).getAllByRole('row').slice(1);
}

describe.each([
  ['Overview', <OverviewPage key="o" />],
  ['Incidents', <IncidentsPage key="i" />],
  ['Workspace settings', <SettingsPage key="w" />],
])('%s screen', (title, page) => {
  it('has its title and says the data is sample data', () => {
    renderPage(page);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.getByText('Sample data. Not connected to live services.')).toBeVisible();
  });
});

describe('Overview screen', () => {
  it('lists active incidents with the most severe first', () => {
    renderPage(<OverviewPage />);
    const [first] = bodyRows('Active incidents');
    expect(first).toHaveTextContent('Critical');
  });

  it('shows recent activity as a timeline', () => {
    renderPage(<OverviewPage />);
    const timeline = screen.getByRole('list', { name: 'Recent activity' });
    expect(within(timeline).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});

describe('Incidents screen', () => {
  it('filters by severity', async () => {
    const user = userEvent.setup();
    renderPage(<IncidentsPage />);
    await user.selectOptions(screen.getByLabelText('Severity'), 'Warning');
    const rows = bodyRows('Incidents');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveTextContent('Warning');
  });

  it('explains an empty result and clears the filters', async () => {
    const user = userEvent.setup();
    renderPage(<IncidentsPage />);
    await user.selectOptions(screen.getByLabelText('Status'), 'Resolved');
    await user.selectOptions(screen.getByLabelText('Severity'), 'Critical');
    expect(screen.getByRole('heading', { name: 'No incidents match these filters' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByLabelText('Status')).toHaveValue('all');
    expect(bodyRows('Incidents').length).toBeGreaterThan(1);
  });
});

describe('Workspace settings screen', () => {
  it('explains that the current role cannot change member roles', () => {
    renderPage(<SettingsPage />);
    expect(screen.getByRole('heading', { name: "You can't change member roles" })).toBeVisible();
  });
});
