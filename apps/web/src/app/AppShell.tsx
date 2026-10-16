import { useEffect, useRef } from 'react';
import { Link, Outlet } from 'react-router';
import { AccountMenu } from './AccountMenu.tsx';
import { BrandMark } from './BrandMark.tsx';
import { NavList } from './NavList.tsx';
import { sampleSession } from './sampleSession.ts';
import './AppShell.css';

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="DataSentinel overview">
      <BrandMark />
      <span className="brand__name">DataSentinel</span>
    </Link>
  );
}

/** Persistent navigation, workspace bar, and page frame around every screen. */
export function AppShell() {
  // Below 1024px the navigation lives in a modal <dialog>: it traps focus,
  // closes on Escape, and returns focus to the Menu button by itself.
  const drawer = useRef<HTMLDialogElement>(null);
  const closeDrawer = () => drawer.current?.close();

  // At desktop width the rail shows the navigation, so a drawer left open
  // would trap focus behind a duplicate. Close it when the window grows.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const onChange = (event: { matches: boolean }) => {
      if (event.matches) drawer.current?.close();
    };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <div className="shell__rail">
        <Brand />
        <NavList />
      </div>

      <dialog
        ref={drawer}
        className="shell__drawer"
        aria-label="Navigation"
        onClick={(event) => {
          // A click on the backdrop targets the dialog element itself.
          if (event.target === event.currentTarget) closeDrawer();
        }}
      >
        <div className="shell__drawer-panel">
          <div className="shell__drawer-head">
            <Brand />
            <button
              type="button"
              className="icon-button icon-button--inverse"
              onClick={closeDrawer}
            >
              Close
            </button>
          </div>
          <NavList onNavigate={closeDrawer} />
        </div>
      </dialog>

      <header className="shell__bar">
        <button
          type="button"
          className="icon-button menu-button"
          onClick={() => drawer.current?.showModal()}
        >
          <span className="menu-button__mark" aria-hidden="true" />
          Menu
        </button>
        <div className="workspace">
          <span className="workspace__name">{sampleSession.workspace.name}</span>
          {sampleSession.isSample && <span className="sample-tag">Sample data</span>}
        </div>
        <AccountMenu />
      </header>

      <div className="shell__main" id="content" tabIndex={-1}>
        <Outlet />
      </div>
    </div>
  );
}
