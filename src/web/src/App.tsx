import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { AgentConsole } from './components/AgentConsole';
import { ActiveSessionsView } from './components/ActiveSessionsView';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { AccountSettingsPage } from './pages/AccountSettingsPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { RunnerDetailPage } from './pages/RunnerDetailPage';
import { RunnersPage } from './pages/RunnersPage';
import { SkillsPage } from './pages/SkillsPage';
import { TaskListView } from './pages/TaskListView';

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
          {/* The app shell hosts one routed view at a time. The task list is the
              default ("/" and "/tasks"); each other view wraps itself in its layout
              contract (DocView = page gutter + scroll, FlushView = full-bleed). */}
          <Route element={<AppShell />}>
            <Route index element={<TaskListView />} />
            <Route path="tasks" element={<TaskListView />} />
            <Route path="tasks/:id" element={<TaskListView />} />
            <Route path="lists/:key" element={<TaskListView />} />
            <Route
              path="active"
              element={
                <DocView>
                  <ActiveSessionsView />
                </DocView>
              }
            />
            <Route
              path="skills"
              element={
                <DocView>
                  <SkillsPage />
                </DocView>
              }
            />
            <Route
              path="settings/account"
              element={
                <DocView>
                  <AccountSettingsPage />
                </DocView>
              }
            />
            <Route
              path="runners"
              element={
                <DocView>
                  <RunnersPage />
                </DocView>
              }
            />
            <Route
              path="runners/register"
              element={
                <FlushView>
                  <RunnerRegisterGuide />
                </FlushView>
              }
            />
            <Route
              path="runners/:id"
              element={
                <DocView>
                  <RunnerDetailPage />
                </DocView>
              }
            />
            {/* Both agent paths share one AgentConsole layout route, so AgentView
                survives navigation between them without remounting. */}
            <Route element={<AgentConsole />}>
              <Route path="agents/:id/*" />
              <Route path="sessions/:id" />
            </Route>
          </Route>
          <Route path="/agents/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
        </>
      )}
    </Routes>
  );
}
