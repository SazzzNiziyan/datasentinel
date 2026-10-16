export type ShapeKind = 'circle' | 'triangle' | 'square' | 'diamond' | 'ring';

const fills: Record<ShapeKind, string> = {
  circle: 'var(--color-status-healthy)',
  triangle: 'var(--color-status-warning)',
  square: 'var(--color-status-critical)',
  diamond: 'var(--color-status-info)',
  ring: 'none',
};

/** The geometric mark behind every status and severity (D-15). Decorative:
 * the word next to it carries the meaning, so it is hidden from screen readers. */
export function Shape({ kind }: { kind: ShapeKind }) {
  const fill = fills[kind];
  return (
    <svg className="shape" viewBox="0 0 16 16" aria-hidden="true" data-shape={kind}>
      {kind === 'circle' && <circle cx="8" cy="8" r="7" fill={fill} />}
      {kind === 'ring' && (
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--color-text)" strokeWidth="2" />
      )}
      {kind === 'square' && <rect x="1.5" y="1.5" width="13" height="13" fill={fill} />}
      {kind === 'diamond' && <polygon points="8,0.5 15.5,8 8,15.5 0.5,8" fill={fill} />}
      {kind === 'triangle' && (
        // Yellow alone is 1.4:1 on paper; the ink outline carries the contrast.
        <polygon
          points="8,1.25 15,14.5 1,14.5"
          fill={fill}
          stroke="var(--color-status-warning-outline)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
