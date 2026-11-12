import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getToken } from './api';
import { encodeId } from './lib/idCodec';
import { useManagedRunner } from './lib/managedRunner';
import { workspacesQuery, runnersQuery } from './lib/queries';
import { machineDraftPath } from './lib/machineSetup';
import { firstOpenableWorkspace } from './lib/workspaceOrder';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { ManagedRunnerLanding } from './components/ManagedRunnerNotice';
import { WorkspaceConsole } from './components/WorkspaceConsole';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { Spinner } from './components/ui/Spinner';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminSignInPage } from './pages/AdminSignInPage';
import { AdminEmailPage } from './pages/AdminEmailPage';
import { AdminIntegrationsPage } from './pages/AdminIntegrationsPage';
import { InfrastructurePage } from './pages/InfrastructurePage';
import { ProviderConnectPage, ProviderPickPage } from './pages/ProviderConnectPage';
import { ProviderPoolPage } from './pages/ProviderPoolPage';
import { CliLoginPage } from './pages/CliLoginPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SetupPage } from './pages/SetupPage';
import { RunnerDetailPage } from './pages/RunnerDetailPage';
import { ProjectDetailPage, ProjectsPage } from './pages/ProjectsPage';
import { SharedLinksPage } from './pages/SharedLinksPage';
import { AccessTokensPage } from './pages/AccessTokensPage';
import { FeishuConnectGroupPage } from './pages/FeishuConnectGroupPage';
import { FeishuIntegrationPage } from './pages/FeishuIntegrationPage';
import { SharedLinkPage, SharedProjectTaskRoute } from './pages/SharedLinkPage';
import { SharedSessionPage } from './pages/SharedSessionPage';
import { SharedWikiDocRoute } from './pages/SharedWikiPage';
import { TaskRoute } from './pages/TaskRoute';
import { FollowingPage } from './pages/FollowingPage';
import { OwnerRequestRedirect } from './pages/OwnerRequestRedirect';
import { WikiPage } from './pages/WikiPage';

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

// Runners and Providers are one page now, Infrastructure, and their addresses land on it
// with the query they carried: older macOS/iOS clients open `/providers` with
// `?runner=<id>&engine=<engine>` to sign an engine in, and that card still opens on that engine.
// Bare `/providers` meant the keys, so it lands on them.
function InfrastructureRedirect({ keys = false }: { keys?: boolean }) {
  const { search } = useLocation();
  const hash = keys && !new URLSearchParams(search).has('runner') ? '#keys' : '';
  return <Navigate to={{ pathname: '/infrastructure', search, hash }} replace />;
}

// Signed out on an in-app page: log in first, then come back to it. The page (path + query) rides
// along as `next`, which LoginPage follows after a successful login — so an Orbit link clicked on
// a share page, or a pasted task URL, isn't lost to the default landing. The bare root has nowhere
// better to return to than where login lands anyway, so it keeps the plain /login.
function LoginRedirect() {
  const { pathname, search } = useLocation();
  const next = pathname + search;
  return (
    <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  );
}

// The default landing (bare root, and where login/setup bounce to): the first workspace's session
// list — the same destination as clicking that workspace in the sidebar. Resolving "the first workspace"
// needs the workspaces list, so this is a component (not a static <Navigate>). With no workspace to open
// yet, fall back to onboarding: a brand-new account (no runners) → the registration guide; the first
// machine online → its new session page, where its first workspace is made in the conversation
// (board rule 11); every machine offline → Infrastructure, which says so. BootGate pre-warms both
// queries, so on a fresh load these read straight from cache and redirect in one shot.
//
// An account with no runner at all, while the server offers managed runners
// (docs/managed-runner-design.md), is shown its managed runner's state there instead — Set up, or
// why there is none — with the registration guide a link away. That is the only landing that asks:
// every other one makes exactly the requests it made before, and with the capability missing or
// off this one still ends at the registration guide.
function DefaultLanding() {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const first =
    workspaces.isSuccess && runners.isFetched
      ? firstOpenableWorkspace(workspaces.data)
      : undefined;
  const listed = workspaces.isFetched && runners.isFetched;
  const runnerList = runners.data ?? [];
  const managed = useManagedRunner(listed && !first && runnerList.length === 0);
  if (first) return <Navigate to={`/workspaces/${encodeId(first.id)}`} replace />;
  if (!listed || (runnerList.length === 0 && !managed.settled)) {
    return (
      <main className="app-main">
        <div className="app-view app-view--doc" style={{ padding: 48, textAlign: 'center' }}>
          <Spinner aria-busy="true" />
        </div>
      </main>
    );
  }
  if (runnerList.length === 0) {
    return managed.managed ? (
      <ManagedRunnerLanding managed={managed.managed} />
    ) : (
      <Navigate to="/runners/register" replace />
    );
  }
  const online = runnerList.find((runner) => runner.online);
  if (online) return <Navigate to={machineDraftPath(online.id)} replace />;
  return <Navigate to="/infrastructure" replace />;
}

export function App() {
  const authed = !!getToken();
  const notFound = (
    <DocView>
      <NotFoundPage />
    </DocView>
  );
  return (
    <Routes>
      {/* Public read-only share link — works signed-out, so it sits outside the auth gate. The root
          page is drawn for what the link opens; a conversation the link opens besides its root (a
          task or project link's run, a project's coordinator) and a project link's task have pages
          of their own under it. */}
      <Route path="/s/:token" element={<SharedLinkPage />} />
      <Route path="/s/:token/c/:sessionId" element={<SharedSessionPage />} />
      <Route path="/s/:token/t/:taskId" element={<SharedProjectTaskRoute />} />
      <Route path="/s/:token/d/:slug" element={<SharedWikiDocRoute />} />
      {/* The privacy policy, which Google's consent screen and the login page link to: public, and the
          same page signed out or in. */}
      <Route path="/privacy" element={<PrivacyPage />} />
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
      {/* The browser half of `orbit login`, signed in like /enroll: approving issues the terminal a
          personal access token for this account. */}
      <Route
        path="/cli-login"
        element={
          authed ? (
            <CliLoginPage />
          ) : (
            <Navigate
              to={`/login?next=${encodeURIComponent('/cli-login' + window.location.search)}`}
              replace
            />
          )
        }
      />
      {/* The app's own addresses, one table signed in or out: signed out, every one of them is sent to log
          in first, and an address that is none of them is said not to exist. */}
      <Route element={authed ? <Outlet /> : <LoginRedirect />}>
        <>
          {/* The app shell hosts one routed view at a time. The default landing is the first
              workspace's session list — the bare root resolves it via <DefaultLanding>, and login
              redirects to it too; the task list lives at "/tasks". Each view wraps itself in its
              layout contract (DocView = page gutter + scroll, FlushView = full-bleed). */}
          <Route element={<AppShell />}>
            <Route index element={<DefaultLanding />} />
            {/* One element for all three, so the list is one instance across them (TaskRoute). */}
            <Route path="tasks" element={<TaskRoute />} />
            <Route path="tasks/:id" element={<TaskRoute />} />
            <Route path="lists/:key" element={<TaskRoute />} />
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
            {/* Every public link this account has made: Active / Paused / Ended. */}
            <Route
              path="settings/shared-links"
              element={
                <DocView>
                  <SharedLinksPage />
                </DocView>
              }
            />
            {/* The personal access tokens this account has issued: issue, list, revoke. */}
            <Route
              path="settings/access-tokens"
              element={
                <DocView>
                  <AccessTokensPage />
                </DocView>
              }
            />
            {/* The account's own Feishu or Lark app (docs/feishu-bot-design.md §4.1, §4.2). */}
            <Route
              path="settings/integrations/feishu"
              element={
                <DocView>
                  <FeishuIntegrationPage />
                </DocView>
              }
            />
            {/* Connecting a Feishu group, opened from the bot's card with its one-time ticket (docs/feishu-bot-design.md §8.1). */}
            <Route
              path="settings/integrations/feishu/connect-group"
              element={
                <DocView>
                  <FeishuConnectGroupPage />
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
            {/* The admin area's Sign-in settings, beside its user management (docs/google-sign-in-design.md §7.1). */}
            <Route
              path="admin/sign-in"
              element={
                <DocView>
                  <AdminSignInPage />
                </DocView>
              }
            />
            {/* The admin area's outgoing email: Resend and the welcome email (docs/welcome-email-design.md §3.1). */}
            <Route
              path="admin/email"
              element={
                <DocView>
                  <AdminEmailPage />
                </DocView>
              }
            />
            {/* The admin area's Integrations: Feishu bots' switch (docs/feishu-bot-design.md §4.1). */}
            <Route
              path="admin/integrations"
              element={
                <DocView>
                  <AdminIntegrationsPage />
                </DocView>
              }
            />
            {/* Machines, API keys and account pools, for everyone (each user's own). Connecting a
                key is its own two-page flow — pick a vendor, then paste a key — so
                "/providers/new/anthropic" can be linked to directly; the pages under /providers and
                /runners keep their addresses. Keep the old admin-only path as a redirect. */}
            <Route
              path="infrastructure"
              element={
                <DocView>
                  <InfrastructurePage />
                </DocView>
              }
            />
            <Route path="providers" element={<InfrastructureRedirect keys />} />
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
            <Route
              path="providers/pools/:id"
              element={
                <DocView>
                  <ProviderPoolPage />
                </DocView>
              }
            />
            <Route path="admin/providers" element={<InfrastructureRedirect keys />} />
            {/* The Waiting on you inbox is gone; its old address opens the session that filed the request. */}
            <Route path="waiting" element={<OwnerRequestRedirect />} />
            {/* Everything this account follows: watches, filed Active / Needs attention / Triggered
                history. `?watch=<id>` opens one watch's card. */}
            <Route
              path="following"
              element={
                <DocView>
                  <FollowingPage />
                </DocView>
              }
            />
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
            {/* One of the project's tasks, open over its page (lib/projectTaskRoute). The same
                element as the page's own route, so opening and closing a task keeps the page — its
                scroll, what is expanded — where the reader left it. */}
            <Route
              path="projects/:id/tasks/:taskId"
              element={
                <DocView>
                  <ProjectDetailPage />
                </DocView>
              }
            />
            {/* The Wiki: one page component, ten routes. `/wiki/review` is declared before
                `/wiki/:space` for the reader's sake rather than the router's — a static segment
                already outranks a dynamic one, but the two together are what the design's URL
                scheme means (a space is a codebase; Review is the account's queue). */}
            <Route
              path="wiki"
              element={
                <DocView>
                  <WikiPage route="home" />
                </DocView>
              }
            />
            <Route
              path="wiki/review"
              element={
                <DocView>
                  <WikiPage route="review" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/review"
              element={
                <DocView>
                  <WikiPage route="review" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space"
              element={
                <DocView>
                  <WikiPage route="home" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/activity"
              element={
                <DocView>
                  <WikiPage route="activity" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/t/:topic"
              element={
                <DocView>
                  <WikiPage route="topic" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/t/:topic/:part"
              element={
                <DocView>
                  <WikiPage route="topic" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/d/:doc"
              element={
                <DocView>
                  <WikiPage route="doc" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/plan"
              element={
                <DocView>
                  <WikiPage route="plan" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/plan/d/:doc"
              element={
                <DocView>
                  <WikiPage route="planDoc" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/plan/d/:doc/:section"
              element={
                <DocView>
                  <WikiPage route="planSection" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/browse"
              element={
                <DocView>
                  <WikiPage route="browse" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/az"
              element={
                <DocView>
                  <WikiPage route="index" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/e/:entry"
              element={
                <DocView>
                  <WikiPage route="entry" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/settings"
              element={
                <DocView>
                  <WikiPage route="settings" />
                </DocView>
              }
            />
            <Route
              path="wiki/:space/run/:run"
              element={
                <DocView>
                  <WikiPage route="run" />
                </DocView>
              }
            />
            <Route path="runners" element={<InfrastructureRedirect />} />
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
                survives navigation between them without remounting. These children render no view
                of their own — the layout draws it from the address — so each says `element={null}`
                instead of leaving it undefined, which React Router's development build (the dev
                server's and the tests') warns about: a matched leaf with no element. */}
            <Route element={<WorkspaceConsole />}>
              <Route path="workspaces/:id/*" element={null} />
              {/* A machine's own new session page, which needs no workspace to exist (the setup card). */}
              <Route path="runners/:id/new" element={null} />
              {/* Pre-rename URL, still in people's bookmarks and history. */}
              <Route path="agents/:id/*" element={null} />
              <Route path="sessions/:id" element={null} />
              {/* A project's Landings window (owner 2026-10-27): the console's right pane. */}
              <Route path="projects/:id/landings" element={null} />
            </Route>
            {authed && <Route path="*" element={notFound} />}
          </Route>
          <Route path="/workspaces/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
          <Route path="/agents/:id/sessions/:sessionId" element={<LegacySessionRedirect />} />
        </>
      </Route>
      {!authed && <Route path="*" element={notFound} />}
    </Routes>
  );
}
