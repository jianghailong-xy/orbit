import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { TasksSidePanel } from './TasksSidePanel';

// The app shell: a persistent side nav plus a content region (the routed <Outlet/>).
// The nav stays mounted across every route; only the region's view changes.
export function AppShell() {
  return (
    <div className="app-shell">
      <TasksSidePanel />
      <Outlet />
    </div>
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
