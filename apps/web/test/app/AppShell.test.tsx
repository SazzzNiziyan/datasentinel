import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/app/AppShell.tsx';
import { PageFrame } from '../../src/components/PageFrame.tsx';
import { WithSession } from '../session.tsx';

// happy-dom cannot resize the viewport, so matchMedia is replaced with one
// whose "change" listeners the test can fire. Stubbed only where unavoidable.
function stubMatchMedia() {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
      listeners.push(listener),
    removeEventListener: () => {},
  }));
  return (matches: boolean) => listeners.forEach((listener) => listener({ matches }));
}

function setViewport(width: number) {
  (
    window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
  ).happyDOM.setViewport({ width });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('closes the navigation drawer when the window grows to desktop width', async () => {
    const changeToDesktop = stubMatchMedia();
    // Start at phone width, where the Menu button is shown.
    setViewport(390);
    const user = userEvent.setup();
    render(
      <WithSession>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeVisible();

    act(() => changeToDesktop(true));

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });

  it('keeps navigation working when a page crashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setViewport(1280);
    function Broken(): never {
      throw new Error('render failed');
    }
    render(
      <WithSession>
        <MemoryRouter initialEntries={['/broken']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/broken" element={<Broken />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </WithSession>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This page failed to display');
    expect(screen.getAllByRole('link', { name: 'Incidents' })[0]).toBeVisible();
    vi.restoreAllMocks();
  });

  it('leaves focus alone on the first page load', () => {
    renderTwoPages();
    expect(document.body).toHaveFocus();
  });

  it('moves focus to the new page heading after navigation', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    renderTwoPages();
    await user.click(screen.getAllByRole('link', { name: 'Incidents' })[0]!);
    expect(screen.getByRole('heading', { level: 1, name: 'Incidents' })).toHaveFocus();
  });

  it('lands on the new page, not the Menu button, after choosing a drawer link', async () => {
    stubMatchMedia();
    setViewport(390);
    const user = userEvent.setup();
    renderTwoPages();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('link', { name: 'Incidents' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Incidents' })).toHaveFocus();
  });
});

function renderTwoPages() {
  render(
    <WithSession>
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<PageFrame title="Overview" />} />
            <Route path="/incidents" element={<PageFrame title="Incidents" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}
