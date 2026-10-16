import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../../src/components/EmptyState.tsx';

describe('EmptyState', () => {
  it('says what is missing, why it matters, and offers one next action', () => {
    render(
      <EmptyState
        title="No data sources yet"
        description="Checks run against a source. Connect one to start monitoring."
        action={<button type="button">Add a data source</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No data sources yet' })).toBeVisible();
    expect(screen.getByText(/Connect one to start monitoring/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add a data source' })).toBeVisible();
  });
});
