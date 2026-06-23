import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { AgentConsole } from './components/AgentConsole';
import { ActiveSessionsView } from './components/ActiveSessionsView';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
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
      <Route path="/login" element={authed ? <Navigate to="/active" /> : <LoginPage />} />
      {/* First-run setup. Signed-out only; once a user exists SetupPage itself bounces to
          login, and a signed-in visitor (so users exist) is sent to the app. */}
      <Route path="/setup" element={authed ? <Navigate to="/active" replace /> : <SetupPage />} />
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
          {/* The app shell hosts one routed view at a time. The default landing is
              Active ("/active") — login redirects there and so does the bare root;
              the task list lives at "/tasks". Each view wraps itself in its layout
              contract (DocView = page gutter + scroll, FlushView = full-bleed). */}
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/active" replace />} />
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
              path="settings/profile"
              element={
                <DocView>
                  <ProfilePage />
                </DocView>
              }
            />
            {/* Old account-settings link, now Profile. Keep the redirect so existing
                bookmarks/deep links don't 404. */}
            <Route path="settings/account" element={<Navigate to="/settings/profile" replace />} />
            <Route
              path="settings"
              element={
                <DocView>
                  <SettingsPage />
                </DocView>
              }
            />
            <Route
              path="admin"
              element={
                <DocView>
                  <AdminUsersPage />
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
