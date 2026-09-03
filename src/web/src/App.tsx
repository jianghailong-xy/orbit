import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { workspacesQuery, runnersQuery } from './lib/queries';
import { firstOpenableWorkspace } from './lib/workspaceOrder';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { WorkspaceConsole } from './components/WorkspaceConsole';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { ProviderConnectPage, ProviderPickPage } from './pages/ProviderConnectPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { RunnerDetailPage } from './pages/RunnerDetailPage';
import { RunnersPage } from './pages/RunnersPage';
import { ProjectDetailPage, ProjectsPage } from './pages/ProjectsPage';
import { SharedSessionPage } from './pages/SharedSessionPage';
import { TaskListView } from './pages/TaskListView';

// Backward-compat: old links nested a session under its runner with raw UUIDs
// (`/workspaces/<uuid>/sessions/<uuid>`). Redirect them to the flat short URL.
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

// The default landing (bare root, and where login/setup bounce to): the first workspace's session
// list — the same destination as clicking that workspace in the sidebar. Resolving "the first workspace"
// needs the workspaces list, so this is a component (not a static <Navigate>). With no workspace to open
// yet, fall back to onboarding: a brand-new account (no runners) → the registration guide; a
// single runner → that runner's page, where its first workspace is created; several runners → the
// list, since there's a machine to pick first. BootGate pre-warms both queries, so on a fresh
// load these read straight from cache and redirect in one shot.
function DefaultLanding() {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const first =
    workspaces.isSuccess && runners.isFetched
      ? firstOpenableWorkspace(workspaces.data, runners.data ?? [])
      : undefined;
  if (first) return <Navigate to={`/workspaces/${encodeId(first.id)}`} replace />;
  if (!workspaces.isFetched || !runners.isFetched) {
    return (
      <main className="app-main">
        <div className="app-view app-view--doc" style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      </main>
    );
  }
  const runnerList = runners.data ?? [];
  if (runnerList.length === 0) return <Navigate to="/runners/register" replace />;
  if (runnerList.length === 1) {
    return <Navigate to={`/runners/${encodeId(runnerList[0].id)}`} replace />;
  }
  return <Navigate to="/runners" replace />;
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
              workspace's session list — the bare root resolves it via <DefaultLanding>, and login
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
            {/* Providers is for everyone (each user's own BYOK list). Connecting one is its own
                two-page flow — pick a vendor, then paste a key — so "/providers/new/anthropic"
                can be linked to directly. Keep the old admin-only path as a redirect. */}
            <Route
              path="providers"
              element={
                <DocView>
                  <ProvidersPage />
                </DocView>
              }
            />
            <Route
              path="providers/new"
              element={
                <DocView>
                  <ProviderPickPage />
                </DocView>
              }
            />
            <Route
              path="providers/new/:slug"
              element={
                <DocView>
                  <ProviderConnectPage />
                </DocView>
              }
            />
            <Route
              path="providers/:id"
              element={
                <DocView>
                  <ProviderConnectPage />
                </DocView>
              }
            />
            <Route path="admin/providers" element={<Navigate to="/providers" replace />} />
            <Route
              path="projects"
              element={
                <DocView>
                  <ProjectsPage />
                </DocView>
              }
            />
            <Route
              path="projects/:id"
              element={
                <DocView>
                  <ProjectDetailPage />
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
            {/* Both workspace paths share one WorkspaceConsole layout route, so WorkspaceView
                survives navigation between them without remounting. */}
            <Route element={<WorkspaceConsole />}>
              <Route path="workspaces/:id/*" />
              {/* Pre-rename URL, still in people's bookmarks and history. */}
              <Route path="agents/:id/*" />
              <Route path="sessions/:id" />
            </Route>
          </Route>
          <Route path="/workspaces/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
          <Route path="/agents/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
        </>
      )}
    </Routes>
  );
}
