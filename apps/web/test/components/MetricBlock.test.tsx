import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricBlock } from '../../src/components/MetricBlock.tsx';

describe('MetricBlock', () => {
  it('shows the label and the value with digit grouping', () => {
    render(<MetricBlock label="Rows loaded" value={2140} />);
    expect(screen.getByText('Rows loaded')).toBeVisible();
    expect(screen.getByText('2,140')).toBeVisible();
  });

  it('states the expectation and how far below it the value is', () => {
    render(<MetricBlock label="Rows loaded" value={2140} expected={{ min: 7000 }} />);
    expect(screen.getByText('Expected at least 7,000')).toBeVisible();
    expect(screen.getByText('4,860 below expected (69%)')).toBeVisible();
    expect(screen.getByText('Outside expected range')).toBeVisible();
  });

  it('states how far above a maximum the value is', () => {
    render(<MetricBlock label="Null rate" value={12} unit="%" expected={{ max: 2 }} />);
    expect(screen.getByText('Expected at most 2%')).toBeVisible();
    expect(screen.getByText('10% above expected (500%)')).toBeVisible();
  });

  it('says when the value is inside a range', () => {
    render(<MetricBlock label="Rows loaded" value={8000} expected={{ min: 7000, max: 9000 }} />);
    expect(screen.getByText('Expected between 7,000 and 9,000')).toBeVisible();
    expect(screen.getByText('Within expected range')).toBeVisible();
  });

  it('names the comparison window when given', () => {
    render(<MetricBlock label="Rows loaded" value={1} window="Last 24 hours" />);
    expect(screen.getByText('Last 24 hours')).toBeVisible();
  });

  it('shows no comparison when an expectation has no bounds', () => {
    // The type forbids this; the guard protects untyped data (e.g. from the API).
    const unbounded = {} as unknown as { min: number };
    render(<MetricBlock label="Rows loaded" value={5} expected={unbounded} />);
    expect(screen.queryByText(/expected/i)).toBeNull();
  });

  it('writes percentages without a space, other units with one', () => {
    render(<MetricBlock label="Null rate" value={12} unit="%" expected={{ max: 2 }} />);
    expect(screen.getByText('Expected at most 2%')).toBeVisible();
  });

  it('shows no comparison when nothing is expected', () => {
    render(<MetricBlock label="Rows loaded" value={1} />);
    expect(screen.queryByText(/expected/i)).toBeNull();
  });
});
