import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeverityBadge } from '../../src/components/SeverityBadge.tsx';

describe('SeverityBadge', () => {
  it.each([
    ['critical', 'Critical'],
    ['warning', 'Warning'],
    ['info', 'Info'],
  ] as const)('labels %s severity as "%s"', (severity, label) => {
    render(<SeverityBadge severity={severity} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it('tells screen readers this is a severity, not a status', () => {
    const { container } = render(<SeverityBadge severity="critical" />);
    expect(container).toHaveTextContent('Severity: Critical');
  });
});
