import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';

// Backward-compat: old links nested a session under its runner with raw UUIDs
// (`/agents/<uuid>/sessions/<uuid>`). Redirect them to the flat short URL.
function LegacySessionRedirect() {
  const { sessionId } = useParams();
  let to = '/';
  try {
    to = `/sessions/${encodeId(sessionId ?? '')}`;
  } catch {
    to = '/';
  }
  return <Navigate to={to} replace />;
}

// Paths whose page renders its own full-height two-pane layout (the top-nav
// sections all share the Tasks view). Everything else gets content padding.
const FULL_HEIGHT = ['/', '/tasks', '/active', '/skills', '/runner', '/runners'];

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const isTasksList =
    FULL_HEIGHT.includes(loc.pathname) ||
    loc.pathname.startsWith('/agents/') ||
    loc.pathname.startsWith('/sessions/') ||
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
          <Route path="/active" element={<Shell><TasksPage /></Shell>} />
          <Route path="/skills" element={<Shell><TasksPage /></Shell>} />
          <Route path="/runner" element={<Shell><TasksPage /></Shell>} />
          <Route path="/runners" element={<Shell><TasksPage /></Shell>} />
          <Route path="/agents/:id" element={<Shell><TasksPage /></Shell>} />
          <Route path="/sessions/:id" element={<Shell><TasksPage /></Shell>} />
          <Route path="/agents/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
          <Route path="/lists/:key" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks/:id" element={<Shell><TaskDetailPage /></Shell>} />
        </>
      )}
    </Routes>
  );
}
