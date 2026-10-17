import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/app/AppShell.tsx';
import { DatasetsPage } from '../src/pages/DatasetsPage.tsx';
import { IncidentsPage } from '../src/pages/IncidentsPage.tsx';
import { OverviewPage } from '../src/pages/OverviewPage.tsx';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';
import { SourcesPage } from '../src/pages/SourcesPage.tsx';
import { WithSession } from './session.tsx';

/** Rule ID and offending elements, so a failure says what to fix. */
async function violations(): Promise<string[]> {
  document.documentElement.lang = 'en'; // as in index.html
  const result = await axe.run(document, {
    // happy-dom does no layout, so contrast cannot be measured here;
    // test/tokens.test.ts checks every colour pair instead.
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

describe.each<[string, ReactNode]>([
  ['Overview', <OverviewPage key="o" />],
  ['Incidents', <IncidentsPage key="i" />],
  ['Data sources', <SourcesPage key="s" />],
  ['Datasets', <DatasetsPage key="d" />],
  ['Workspace settings', <SettingsPage key="w" />],
])('%s screen in the app shell', (_title, page) => {
  it('has no automatically detectable accessibility problems', async () => {
    render(
      <WithSession>
        <MemoryRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={page} />
            </Route>
          </Routes>
        </MemoryRouter>
      </WithSession>,
    );
    expect(await violations()).toEqual([]);
  });
});
