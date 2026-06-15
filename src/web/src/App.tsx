import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getToken } from './api';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';

// Paths whose page renders its own full-height two-pane layout (the top-nav
// sections all share the Tasks view). Everything else gets content padding.
const FULL_HEIGHT = ['/', '/tasks', '/running', '/skills', '/schedule', '/activities', '/agents'];

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const isTasksList =
    FULL_HEIGHT.includes(loc.pathname) ||
    loc.pathname.startsWith('/agents/') ||
    loc.pathname.startsWith('/lists/');
  return (
    <div className="orbit-shell">
      <div className="orbit-main">
        {isTasksList ? children : <div className="orbit-page-pad">{children}</div>}
      </div>
    </div>
  );
}

export function App() {
  const authed = !!getToken();
  return (
    <Routes>
      <Route path="/login" element={authed ? <Navigate to="/tasks" /> : <LoginPage />} />
      <Route
        path="/enroll"
        element={
          authed ? (
            <EnrollPage />
          ) : (
            <Navigate
              to={`/login?next=${encodeURIComponent('/enroll' + window.location.search)}`}
              replace
            />
          )
        }
      />
      {!authed ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <>
          <Route path="/" element={<Shell><TasksPage /></Shell>} />
          <Route path="/running" element={<Shell><TasksPage /></Shell>} />
          <Route path="/skills" element={<Shell><TasksPage /></Shell>} />
          <Route path="/schedule" element={<Shell><TasksPage /></Shell>} />
          <Route path="/activities" element={<Shell><TasksPage /></Shell>} />
          <Route path="/agents" element={<Shell><TasksPage /></Shell>} />
          <Route path="/agents/:id" element={<Shell><TasksPage /></Shell>} />
          <Route path="/lists/:key" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks/:id" element={<Shell><TaskDetailPage /></Shell>} />
        </>
      )}
    </Routes>
  );
}
