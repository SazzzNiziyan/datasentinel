import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionDenied } from '../../src/components/PermissionDenied.tsx';

const props = {
  title: "You can't change alert routing",
  currentRole: 'Viewer',
  requiredRole: 'Administrator or Owner',
  contact: 'Ask a workspace administrator to change your role.',
};

describe('PermissionDenied', () => {
  it('says what is blocked, which role is needed, and who can change it', () => {
    render(<PermissionDenied {...props} />);
    expect(screen.getByRole('heading', { name: props.title })).toBeVisible();
    expect(screen.getByText('Your role').nextElementSibling).toHaveTextContent('Viewer');
    expect(screen.getByText('Needed').nextElementSibling).toHaveTextContent(
      'Administrator or Owner',
    );
    expect(screen.getByText(/Ask a workspace administrator/)).toBeVisible();
  });

  it('is not an error: no alert and nothing to retry', () => {
    render(<PermissionDenied {...props} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
