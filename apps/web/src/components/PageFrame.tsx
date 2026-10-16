import type { ReactNode } from 'react';
import './PageFrame.css';

interface PageFrameProps {
  title: string;
  /** Short statement of what the page shows, under the title. */
  summary?: string;
  children?: ReactNode;
}

/** Page title, summary, and the 12-column content grid shared by every screen. */
export function PageFrame({ title, summary, children }: PageFrameProps) {
  return (
    <main className="page">
      <title>{`${title} – DataSentinel`}</title>
      <header className="page__header">
        <h1 className="page__title">{title}</h1>
        {summary !== undefined && <p className="page__summary">{summary}</p>}
      </header>
      <div className="page__grid">{children}</div>
    </main>
  );
}
