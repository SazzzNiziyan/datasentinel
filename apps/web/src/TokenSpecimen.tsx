import './TokenSpecimen.css';

// Development preview of the design tokens. Replaced by the app shell.
const swatches = [
  ['ink', '--palette-ink', 'Text, borders, icons'],
  ['paper', '--palette-paper', 'Page background'],
  ['white', '--palette-white', 'Cards, forms, tables'],
  ['red', '--palette-red', 'Critical'],
  ['blue', '--palette-blue', 'Selected, focus, info'],
  ['yellow', '--palette-yellow', 'Warning (always outlined)'],
  ['green', '--palette-green', 'Healthy'],
  ['line', '--palette-line', 'Decorative dividers only'],
  ['line-strong', '--palette-line-strong', 'Control borders, muted text'],
] as const;

const spaces = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8'];

function WarningShape() {
  // Yellow fill with an ink outline: yellow alone is 1.4:1 on paper (D-15).
  return (
    <svg className="mark__shape" viewBox="0 0 18 16" aria-hidden="true">
      <polygon
        points="9,1 17,15 1,15"
        fill="var(--color-status-warning)"
        stroke="var(--color-status-warning-outline)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TokenSpecimen() {
  return (
    <main className="specimen">
      <header className="specimen__type">
        <h1>Design tokens</h1>
        <p className="specimen__notice">
          Development preview with sample content. Not connected to any data.
        </p>
      </header>

      <section aria-labelledby="palette">
        <h2 id="palette">Palette</h2>
        <div className="specimen__swatches">
          {swatches.map(([name, token, use]) => (
            <div className="swatch" key={name}>
              <div className="swatch__color" style={{ background: `var(${token})` }} />
              <div className="swatch__label">
                <strong>{name}</strong> <code>{token}</code>
                <br />
                {use}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="status">
        <h2 id="status">Status marks</h2>
        <p className="text-helper">Every status is a shape plus a word, never color alone.</p>
        <div className="specimen__marks">
          <span className="mark mark--healthy">
            <span className="mark__shape" aria-hidden="true" />
            Healthy
          </span>
          <span className="mark mark--warning">
            <WarningShape />
            Warning
          </span>
          <span className="mark mark--critical">
            <span className="mark__shape" aria-hidden="true" />
            Critical
          </span>
          <span className="mark mark--info">
            <span className="mark__shape" aria-hidden="true" />
            Info
          </span>
        </div>
      </section>

      <section aria-labelledby="type" className="specimen__type">
        <h2 id="type">Type scale</h2>
        <p style={{ fontSize: 'var(--text-display)', fontWeight: 700, lineHeight: 1.15 }}>
          Display: Overview
        </p>
        <p style={{ fontSize: 'var(--text-heading)', fontWeight: 700 }}>
          Heading: Active incidents
        </p>
        <p>Body: Last checked 8 minutes ago. Expected at least 7,000 rows.</p>
        <p className="text-compact">
          Compact (tables): orders_daily · run <code>chk_01J9Z3</code>
        </p>
        <p className="text-helper">Helper: Use a read-only database user.</p>
      </section>

      <section aria-labelledby="controls">
        <h2 id="controls">Controls and focus</h2>
        <label className="field">
          Dataset name
          <input placeholder="orders_daily" />
          <span className="text-helper">Tab into the field to see the focus ring.</span>
        </label>
      </section>

      <section aria-labelledby="spacing">
        <h2 id="spacing">Spacing (8px base)</h2>
        <div className="specimen__spacing">
          {spaces.map((token) => (
            <div key={token} style={{ display: 'grid', gap: 'var(--space-1)' }}>
              <div className="space-bar" style={{ height: `var(${token})` }} />
              <code className="text-helper">{token.replace('--space-', '')}</code>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
