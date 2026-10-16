import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadingState } from '../../src/components/LoadingState.tsx';

describe('LoadingState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills an already-present status region after a short delay, so it is announced', () => {
    vi.useFakeTimers();
    render(<LoadingState label="Loading incidents" />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading incidents…');
  });
});
