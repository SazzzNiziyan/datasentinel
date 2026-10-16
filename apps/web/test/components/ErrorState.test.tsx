import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from '../../src/components/ErrorState.tsx';

const copy = {
  title: 'Could not load incidents',
  description: 'The incident list did not load. Try again in a moment.',
};

describe('ErrorState', () => {
  it('says what failed and what to do, as an alert', () => {
    render(<ErrorState {...copy} />);
    const alert = screen.getByRole('alert');
    expect(alert).toContainElement(screen.getByRole('heading', { name: copy.title }));
    expect(alert).toHaveTextContent(copy.description);
  });

  it('offers no button when there is nothing to retry', () => {
    render(<ErrorState {...copy} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls back once when the user tries again', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState {...copy} onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps focus on the button while retrying and ignores repeat clicks', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState {...copy} onRetry={onRetry} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    await user.click(button);
    rerender(<ErrorState {...copy} onRetry={onRetry} retrying />);

    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Trying again…');
    await user.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('announces when a retry fails again while the state stays on screen', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState {...copy} onRetry={onRetry} retrying />);
    rerender(<ErrorState {...copy} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('That attempt failed too.');
  });

  it('shows a support reference without exposing the error itself', () => {
    render(<ErrorState {...copy} reference="req_7f3a91" />);
    expect(screen.getByText('req_7f3a91').tagName).toBe('CODE');
    expect(screen.getByRole('alert')).toHaveTextContent('Reference');
  });
});
