import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
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

describe('Overview screen title', () => {
  it('has its title and says the data is sample data', () => {
    renderPage(<OverviewPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
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

describe('Workspace settings screen', () => {
  it('explains that the current role cannot change member roles', () => {
    renderPage(<SettingsPage />);
    expect(screen.getByRole('heading', { name: "You can't manage members" })).toBeVisible();
  });
});
