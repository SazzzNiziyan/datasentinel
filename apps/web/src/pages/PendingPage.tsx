import { PageFrame } from '../components/PageFrame.tsx';
import type { NavItem } from '../app/navigation.ts';
import './PendingPage.css';

/** A destination whose screen is not built yet. Says so plainly. */
export function PendingPage({ item }: { item: NavItem }) {
  return (
    <PageFrame title={item.label} summary={item.purpose}>
      <p className="pending">Not connected yet. This screen is built in a later step.</p>
    </PageFrame>
  );
}
