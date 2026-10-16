import type { ReactNode } from 'react';
import './EmptyState.css';

interface EmptyStateProps {
  /** What is missing, e.g. "No data sources yet". */
  title: string;
  /** Why it matters and what to do. */
  description: string;
  /** One next action. */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <section className="empty-state">
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__description">{description}</p>
      {action !== undefined && <div className="empty-state__action">{action}</div>}
    </section>
  );
}
