import { Shape, type ShapeKind } from './Shape.tsx';
import './SeverityBadge.css';

/** Severity levels (D-17). Which levels open an incident is still open (Q-02). */
export type Severity = 'critical' | 'warning' | 'info';

const display: Record<Severity, { label: string; shape: ShapeKind }> = {
  critical: { label: 'Critical', shape: 'square' },
  warning: { label: 'Warning', shape: 'triangle' },
  info: { label: 'Info', shape: 'diamond' },
};

/** How serious a rule or incident is. Boxed, unlike StatusMark, so severity
 * and current status read as different things when shown side by side. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const { label, shape } = display[severity];
  return (
    <span className="severity-badge" data-severity={severity}>
      <Shape kind={shape} />
      <span className="visually-hidden">Severity: </span>
      <span>{label}</span>
    </span>
  );
}
