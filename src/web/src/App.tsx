import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { agentsQuery, runnersQuery } from './lib/queries';
import { firstOpenableAgent } from './lib/agentOrder';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { AgentConsole } from './components/AgentConsole';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ProvidersAdminPage } from './pages/ProvidersAdminPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { RunnerDetailPage } from './pages/RunnerDetailPage';
import { RunnersPage } from './pages/RunnersPage';
import { SharedSessionPage } from './pages/SharedSessionPage';
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

// The default landing (bare root, and where login/setup bounce to): the first agent's session
// list — the same destination as clicking that agent in the sidebar. Resolving "the first agent"
// needs the agents list, so this is a component (not a static <Navigate>). With no agent to open
// yet, fall back to onboarding: a brand-new account (no runners) → the registration guide,
// otherwise the runners list, where agents are created. BootGate pre-warms both queries, so on a
// fresh load these read straight from cache and redirect in one shot.
function DefaultLanding() {
  const agents = useQuery(agentsQuery());
  const runners = useQuery(runnersQuery());
  const first = agents.isSuccess ? firstOpenableAgent(agents.data) : undefined;
  if (first) return <Navigate to={`/agents/${encodeId(first.id)}`} replace />;
  if (!agents.isFetched || !runners.isFetched) {
    return (
      <main className="app-main">
        <div className="app-view app-view--doc" style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      </main>
    );
  }
  return <Navigate to={(runners.data ?? []).length === 0 ? '/runners/register' : '/runners'} replace />;
}

export function App() {
  const authed = !!getToken();
  return (
    <Routes>
      {/* Public read-only share link — works signed-out, so it sits outside the auth gate. */}
      <Route path="/s/:token" element={<SharedSessionPage />} />
      <Route path="/login" element={authed ? <Navigate to="/" /> : <LoginPage />} />
      {/* First-run setup. Signed-out only; once a user exists SetupPage itself bounces to
          login, and a signed-in visitor (so users exist) is sent to the app. */}
      <Route path="/setup" element={authed ? <Navigate to="/" replace /> : <SetupPage />} />
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
          {/* The app shell hosts one routed view at a time. The default landing is the first
              agent's session list — the bare root resolves it via <DefaultLanding>, and login
              redirects to it too; the task list lives at "/tasks". Each view wraps itself in its
              layout contract (DocView = page gutter + scroll, FlushView = full-bleed). */}
          <Route element={<AppShell />}>
            <Route index element={<DefaultLanding />} />
            <Route path="tasks" element={<TaskListView />} />
            <Route path="tasks/:id" element={<TaskListView />} />
            <Route path="lists/:key" element={<TaskListView />} />
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
              path="admin/providers"
              element={
                <DocView>
                  <ProvidersAdminPage />
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
