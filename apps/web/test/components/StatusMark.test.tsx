import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusMark, type Tone } from '../../src/components/StatusMark.tsx';

describe('StatusMark', () => {
  it('shows the status as words, not only a color', () => {
    render(<StatusMark tone="critical" label="Failing" />);
    expect(screen.getByText('Failing')).toBeVisible();
  });

  it('hides the shape from screen readers so the label is read once', () => {
    const { container } = render(<StatusMark tone="healthy" label="Healthy" />);
    const shape = container.querySelector('[data-shape]');
    expect(shape).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives each tone a different shape, so status survives without color', () => {
    const tones: Tone[] = ['healthy', 'warning', 'critical', 'info', 'neutral'];
    const shapes = tones.map((tone) => {
      const { container, unmount } = render(<StatusMark tone={tone} label={tone} />);
      const shape = container.querySelector('[data-shape]')?.getAttribute('data-shape');
      unmount();
      return shape;
    });
    expect(shapes.every((shape) => typeof shape === 'string')).toBe(true);
    expect(new Set(shapes).size).toBe(tones.length);
  });
});
