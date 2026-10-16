import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmActionDialog,
  type ConfirmActionDialogProps,
} from '../../src/components/ConfirmActionDialog.tsx';

function dialog(props: Partial<ConfirmActionDialogProps> = {}) {
  const onConfirm = vi.fn(() => Promise.resolve());
  const onCancel = vi.fn();
  render(
    <ConfirmActionDialog
      open
      title="Retry validation run"
      target="orders_daily"
      effect="Runs all enabled rules for this dataset again."
      permission="Data engineer or above"
      confirmLabel="Retry run"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmActionDialog', () => {
  it('names the target, the effect, and the required permission', () => {
    dialog();
    const box = screen.getByRole('dialog', { name: 'Retry validation run' });
    expect(box).toHaveTextContent('orders_daily');
    expect(box).toHaveTextContent('Runs all enabled rules for this dataset again.');
    expect(box).toHaveTextContent('Data engineer or above');
  });

  it('runs the action once even when the button is clicked twice', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<void>();
    const slow = vi.fn(() => pending.promise);
    dialog({ onConfirm: slow });
    const button = screen.getByRole('button', { name: 'Retry run' });
    await user.click(button);
    await user.click(button);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    pending.resolve();
  });

  it('says the action is running and keeps focus on the button', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<void>();
    dialog({ onConfirm: () => pending.promise });
    const button = screen.getByRole('button', { name: 'Retry run' });
    await user.click(button);
    expect(screen.getByRole('status')).toHaveTextContent('Working');
    expect(button).toHaveFocus();
    pending.resolve();
  });

  it('tells the parent when the browser closes the dialog by itself', () => {
    const { onCancel } = dialog();
    const box = screen.getByRole<HTMLDialogElement>('dialog');
    act(() => box.close());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('requires typing the target name when asked', async () => {
    const user = userEvent.setup();
    dialog({ confirmText: 'orders_daily', confirmLabel: 'Purge source' });
    const button = screen.getByRole('button', { name: 'Purge source' });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /Type orders_daily/ }), 'orders_daily');
    expect(button).toBeEnabled();
  });

  it('starts clean when reopened: no typed text, no old error', async () => {
    const user = userEvent.setup();
    const props: ConfirmActionDialogProps = {
      open: true,
      title: 'Purge source',
      target: 'orders_daily',
      effect: 'Deletes stored credentials and uploaded files.',
      confirmLabel: 'Purge source',
      confirmText: 'orders_daily',
      onConfirm: () => Promise.reject(new Error('Queue unavailable')),
      onCancel: () => {},
    };
    const { rerender } = render(<ConfirmActionDialog {...props} />);
    await user.type(screen.getByRole('textbox'), 'orders_daily');
    await user.click(screen.getByRole('button', { name: 'Purge source' }));
    expect(await screen.findByRole('alert')).toBeVisible();

    rerender(<ConfirmActionDialog {...props} open={false} />);
    rerender(<ConfirmActionDialog {...props} open />);

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('accepts the typed name with surrounding spaces, as pasted text often has', async () => {
    const user = userEvent.setup();
    dialog({ confirmText: 'orders_daily', confirmLabel: 'Purge source' });
    await user.type(screen.getByRole('textbox'), ' orders_daily ');
    expect(screen.getByRole('button', { name: 'Purge source' })).toBeEnabled();
  });

  it('cancels without running the action', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = dialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a failed action as an alert and allows another try', async () => {
    const user = userEvent.setup();
    dialog({ onConfirm: () => Promise.reject(new Error('Queue unavailable')) });
    const button = screen.getByRole('button', { name: 'Retry run' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('The action did not run.');
    expect(button).toBeEnabled();
  });
});
