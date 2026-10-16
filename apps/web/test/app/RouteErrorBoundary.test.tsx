import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteErrorBoundary } from '../../src/app/RouteErrorBoundary.tsx';

function Broken(): never {
  throw new Error('render failed: secret detail');
}

beforeEach(() => {
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/fine">Fine page</Link>
      <RouteErrorBoundary>
        <Routes>
          <Route path="/broken" element={<Broken />} />
          <Route path="/fine" element={<p>Fine content</p>} />
        </Routes>
      </RouteErrorBoundary>
    </MemoryRouter>,
  );
}

describe('RouteErrorBoundary', () => {
  it('replaces a crashed page with an error state, keeping the rest usable', () => {
    renderAt('/broken');
    expect(screen.getByRole('heading', { name: 'This page failed to display' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Fine page' })).toBeVisible();
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });

  it('recovers when the user navigates to another page', async () => {
    const user = userEvent.setup();
    renderAt('/broken');
    await user.click(screen.getByRole('link', { name: 'Fine page' }));
    expect(screen.getByText('Fine content')).toBeVisible();
  });
});
