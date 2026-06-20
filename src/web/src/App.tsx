import { Navigate, Route, Routes, useParams } from 'react-router-dom';
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
          <Route path="/" element={<TasksPage />} />
          <Route path="/active" element={<TasksPage />} />
          <Route path="/skills" element={<TasksPage />} />
          <Route path="/runners/register" element={<TasksPage />} />
          <Route path="/runners" element={<TasksPage />} />
          <Route path="/runners/:id" element={<TasksPage />} />
          <Route path="/agents/:id" element={<TasksPage />} />
          <Route path="/agents/:id/new" element={<TasksPage />} />
          <Route path="/sessions/:id" element={<TasksPage />} />
          <Route path="/agents/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
          <Route path="/lists/:key" element={<TasksPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
        </>
      )}
    </Routes>
  );
}
