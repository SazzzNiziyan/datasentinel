import type { ReactNode } from 'react';
import './PageFrame.css';

interface PageFrameProps {
  title: string;
  /** Short statement of what the page shows, under the title. */
  summary?: string;
  /** Marks every value on the page as sample data (D-16, D-19). */
  sample?: boolean;
  children?: ReactNode;
}

/** Page title, summary, and the 12-column content grid shared by every screen. */
export function PageFrame({ title, summary, sample = false, children }: PageFrameProps) {
  return (
    <main className="page">
      <title>{`${title} – DataSentinel`}</title>
      <header className="page__header">
        {/* Focusable by script only: the shell moves focus here after navigation. */}
        <h1 className="page__title" tabIndex={-1}>
          {title}
        </h1>
        {summary !== undefined && <p className="page__summary">{summary}</p>}
        {sample && <p className="page__sample">Sample data. Not connected to live services.</p>}
      </header>
      <div className="page__grid">{children}</div>
    </main>
  );
}
