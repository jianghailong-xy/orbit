import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getToken } from './api';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  // The Tasks list page renders its own full-height two-pane layout; every
  // other page gets standard content padding.
  const isTasksList = loc.pathname === '/tasks';
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
          <Route path="/" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks/:id" element={<Shell><TaskDetailPage /></Shell>} />
        </>
      )}
    </Routes>
  );
}
