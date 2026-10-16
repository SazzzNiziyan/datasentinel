import { NavLink } from 'react-router';
import { primaryNav, secondaryNav, type NavItem } from './navigation.ts';

interface NavListProps {
  /** Called after a destination is chosen (closes the mobile drawer). */
  onNavigate?: () => void;
}

function Items({ items, onNavigate }: { items: readonly NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="nav-list__group">
      {items.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            end={item.path === '/'}
            className="nav-list__link"
            onClick={onNavigate}
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function NavList({ onNavigate }: NavListProps) {
  return (
    <nav className="nav-list" aria-label="Main">
      <Items items={primaryNav} onNavigate={onNavigate} />
      <hr className="nav-list__divider" />
      <Items items={secondaryNav} onNavigate={onNavigate} />
    </nav>
  );
}
