import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Timeline } from '../../src/components/Timeline.tsx';

describe('Timeline', () => {
  it('lists events in order with time, actor, and what happened', () => {
    render(
      <Timeline
        label="Recent activity"
        events={[
          { id: '1', time: '08:40', actor: 'Scheduler', text: 'Row count check failed' },
          { id: '2', time: '08:12', actor: 'Ana Kovac', text: 'Acknowledged incident' },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Recent activity' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('08:40');
    expect(items[0]).toHaveTextContent('Scheduler');
    expect(items[0]).toHaveTextContent('Row count check failed');
  });
});
