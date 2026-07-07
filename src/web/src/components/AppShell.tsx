import { useEffect, useState, type ReactNode } from 'react';
import { MenuOutlined } from '@ant-design/icons';
import { Outlet, useLocation } from 'react-router-dom';
import { TasksSidePanel } from './TasksSidePanel';
import { ControlPlaneProvider } from '../lib/useControlPlane';

// The app shell: a persistent side nav plus a content region (the routed <Outlet/>).
// The nav stays mounted across every route; only the region's view changes. On narrow
// viewports the nav collapses into an off-canvas drawer (CSS, below the 768px breakpoint)
// toggled by the top bar's hamburger; the top bar and backdrop are hidden on desktop.
export function AppShell() {
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  // Any navigation (nav item, session row, deep link) closes the drawer so the chosen
  // view isn't left sitting under the overlay.
  useEffect(() => setNavOpen(false), [loc.pathname]);
  return (
    // ControlPlaneProvider opens the one per-tab control-plane SSE and exposes its liveness, so the
    // session lists below can stop polling while it's connected (see useControlPlane). Mounted here,
    // inside the auth gate, so the stream only runs for a signed-in user and spans every route.
    <ControlPlaneProvider>
    <div className="app-shell">
      <header className="app-topbar">
        <button
          type="button"
          className="app-nav-toggle"
          aria-label="Open menu"
          onClick={() => setNavOpen(true)}
        >
          <MenuOutlined />
        </button>
        <span className="app-topbar-name">Orbit</span>
      </header>
      <TasksSidePanel open={navOpen} />
      {navOpen && <div className="app-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <Outlet />
    </div>
    </ControlPlaneProvider>
  );
}

// Layout contract primitives a routed view wraps itself in. A view fills the main
// region; DocView adds the page gutter and owns its scroll (the document-style views),
// while FlushView is full-bleed (the agent console / runner install guide). The task
// list is the exception — it renders its own <main> so its detail panel can sit as a
// third column beside it — so it uses neither wrapper.
export function DocView({ children }: { children: ReactNode }) {
  return (
    <main className="app-main">
      <div className="app-view app-view--doc">{children}</div>
    </main>
  );
}

export function FlushView({ children }: { children: ReactNode }) {
  return (
    <main className="app-main">
      <div className="app-view">{children}</div>
    </main>
  );
}
