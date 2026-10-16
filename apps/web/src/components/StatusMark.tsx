import { Shape, type ShapeKind } from './Shape.tsx';
import './StatusMark.css';

export type Tone = 'healthy' | 'warning' | 'critical' | 'info' | 'neutral';

const shapeFor: Record<Tone, ShapeKind> = {
  healthy: 'circle',
  warning: 'triangle',
  critical: 'square',
  info: 'diamond',
  neutral: 'ring',
};

interface StatusMarkProps {
  tone: Tone;
  /** The status in words, e.g. "Failing" or "Last check passed". */
  label: string;
}

/** A status as shape plus word, never color alone. Map domain states
 * (source degraded, run timed out, ...) to a tone where they are defined. */
export function StatusMark({ tone, label }: StatusMarkProps) {
  return (
    <span className="status-mark" data-tone={tone}>
      <Shape kind={shapeFor[tone]} />
      <span>{label}</span>
    </span>
  );
}
