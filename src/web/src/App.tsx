import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getToken } from './api';
import { encodeId, routeId } from './lib/idCodec';
import { useManagedRunner } from './lib/managedRunner';
import { workspacesQuery, runnersQuery } from './lib/queries';
import { machineDraftPath } from './lib/machineSetup';
import { firstOpenableWorkspace } from './lib/workspaceOrder';
import { AppShell, DocView, FlushView } from './components/AppShell';
import { AdminLayout } from './components/settings/AdminLayout';
import { SettingsLayout } from './components/settings';
import { SettingsWorkspacePage } from './components/settings/WorkspaceSettingsPage';
import { SettingsKeysPage, SettingsPoolsPage, SettingsProvidersHome } from './components/settings/SettingsProviderPages';
import { MachineSettingsPage } from './components/settings/MachineSettingsPage';
import { useRememberOutsideSettings } from './lib/settingsReturn';
import { ManagedRunnerLanding } from './components/ManagedRunnerNotice';
import { WorkspaceConsole } from './components/WorkspaceConsole';
import { RunnerRegisterGuide } from './components/RunnerRegisterGuide';
import { Spinner } from './components/ui/Spinner';
import { ProfilePage } from './pages/ProfilePage';
import { GeneralSettingsPage } from './pages/settings/GeneralPage';
import { NotificationsSettingsPage } from './pages/settings/NotificationsPage';
import { AppearanceSettingsPage } from './pages/settings/AppearancePage';
import { StorageSettingsPage } from './pages/settings/StoragePage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminSignInPage } from './pages/AdminSignInPage';
import { AdminEmailPage } from './pages/AdminEmailPage';
import { AdminIntegrationsPage } from './pages/AdminIntegrationsPage';
import { ProviderConnectPage, ProviderPickPage } from './pages/ProviderConnectPage';
import { ProviderPoolPage } from './pages/ProviderPoolPage';
import { CliLoginPage } from './pages/CliLoginPage';
import { EnrollPage } from './pages/EnrollPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SetupPage } from './pages/SetupPage';
import { ProjectDetailPage, ProjectsPage } from './pages/ProjectsPage';
import { SharedLinksPage } from './pages/SharedLinksPage';
import { AccessTokensPage } from './pages/AccessTokensPage';
import { FeishuConnectGroupPage } from './pages/FeishuConnectGroupPage';
import { FeishuIntegrationPage } from './pages/FeishuIntegrationPage';
import { SharedLinkPage, SharedProjectTaskRoute } from './pages/SharedLinkPage';
import { SharedSessionPage } from './pages/SharedSessionPage';
import { GuestLinkRedirect } from './pages/GuestSessionPage';
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

// `/runners` lands on /infrastructure with the query it carried, which opens a machine's Settings page:
// older macOS/iOS clients open `/runners` and `/providers` with `?runner=<id>&engine=<engine>` to sign an
// engine in, and that machine's page still opens on that engine.
function InfrastructureRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/infrastructure', search }} replace />;
}

// The API keys and account pools are Settings' Providers pages now (docs/mocks/settings-redesign,
// board-4), and the addresses they had land there: /providers and /admin/providers on the keys,
// /providers/new[/:slug] on connecting one, /providers/:id on editing it, /providers/pools[/:id] on the
// pools. A `?runner=` (an engine to sign in, above) still goes to Infrastructure.
function ProvidersRedirect() {
  const { pathname, search } = useLocation();
  if (new URLSearchParams(search).has('runner')) return <InfrastructureRedirect />;
  const rest = pathname.replace(/^\/(admin\/)?providers\/?/, '');
  const to = rest === '' || /^(new|pools)(\/|$)/.test(rest) ? rest : `keys/${rest}`;
  return <Navigate to={{ pathname: `/settings/providers${to ? `/${to}` : ''}`, search }} replace />;
}

// /settings/machines/:id, drawn afresh for each machine so nothing typed on one carries to the next.
function SettingsMachineRoute() {
  const { id } = useParams();
  return <MachineSettingsPage key={id} />;
}

// A machine's old page, /runners/:id, is its Settings page now. `?workspace=<id>` opened that
// workspace's editor there, which is the workspace's own Settings address now.
function RunnerRedirect() {
  const { id } = useParams();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const workspace = params.get('workspace');
  if (workspace) return <Navigate to={`/settings/workspaces/${routeId(workspace)}`} replace />;
  return <Navigate to={{ pathname: `/settings/machines/${routeId(id)}`, search }} replace />;
}

// /infrastructure's machines live in Settings now: a link that named a machine (and an engine on it to
// sign in, `?runner=<id>&engine=<engine>`) opens that machine's page; otherwise the first machine's,
// or General when there is none. Its #keys and #pools are Settings' Providers pages.
function InfrastructureRoute() {
  const { search, hash } = useLocation();
  const runners = useQuery(runnersQuery());
  if (hash === '#keys') return <Navigate to="/settings/providers" replace />;
  if (hash === '#pools') return <Navigate to="/settings/providers/pools" replace />;
  const params = new URLSearchParams(search);
  const runner = routeId(params.get('runner'));
  if (runner) {
    const engine = params.get('engine');
    return (
      <Navigate
        to={{ pathname: `/settings/machines/${runner}`, search: engine ? `?engine=${encodeURIComponent(engine)}` : '' }}
        replace
      />
    );
  }
  if (runners.isPending) {
    return (
      <main className="app-main">
        <div className="app-view app-view--doc" style={{ padding: 48, textAlign: 'center' }}>
          <Spinner aria-busy="true" />
        </div>
      </main>
    );
  }
  const first = (runners.data ?? [])[0] as { id: string } | undefined;
  return <Navigate to={first ? `/settings/machines/${first.id}` : '/settings/general'} replace />;
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
// (board rule 11); every machine offline → the first machine's Settings page, which says so. BootGate pre-warms both
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
  return <Navigate to={`/settings/machines/${runnerList[0].id}`} replace />;
}

export function App() {
  const authed = !!getToken();
  // Where Settings' Back to Orbit returns to.
  useRememberOutsideSettings();
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
      {/* The guest page's first address. A session shared with you now opens at the same /sessions/<id> its owner
          opens (board docs/mocks/share-links/11-guest-one-link, D8); signed out, that address asks for a sign-in. */}
      <Route path="/g/:sessionId" element={<GuestLinkRedirect />} />
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
          {/* Settings takes over the window (owner's choice A1, docs/mocks/settings-redesign): its own nav
              of five groups in place of the app's sidebar, "Back to Orbit" and Esc to leave. Machines and
              Workspaces open the pages that manage them today until each has its own. */}
          {/* Admin is drawn as Settings is: its own window, a nav of its pages, the page in a centred column. */}
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminUsersPage />} />
            <Route path="sign-in" element={<AdminSignInPage />} />
            <Route path="email" element={<AdminEmailPage />} />
            <Route path="integrations" element={<AdminIntegrationsPage />} />
          </Route>
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/general" replace />} />
            <Route path="general" element={<GeneralSettingsPage />} />
            <Route path="notifications" element={<NotificationsSettingsPage />} />
            <Route path="appearance" element={<AppearanceSettingsPage />} />
            <Route path="storage" element={<StorageSettingsPage />} />
            <Route path="profile" element={<ProfilePage />} />
            {/* Old account-settings link, now Profile. Keep the redirect so existing
                bookmarks/deep links don't 404. */}
            <Route path="account" element={<Navigate to="/settings/profile" replace />} />
            {/* Every public link this account has made: Active / Paused / Ended. */}
            <Route path="shared-links" element={<SharedLinksPage />} />
            {/* The personal access tokens this account has issued: issue, list, revoke. */}
            <Route path="access-tokens" element={<AccessTokensPage />} />
            {/* The account's own Feishu or Lark app (docs/feishu-bot-design.md §4.1, §4.2). */}
            <Route path="integrations/feishu" element={<FeishuIntegrationPage />} />
            {/* Connecting a Feishu group, opened from the bot's card with its one-time ticket (docs/feishu-bot-design.md §8.1). */}
            <Route path="integrations/feishu/connect-group" element={<FeishuConnectGroupPage />} />
            <Route path="machines/:id" element={<SettingsMachineRoute />} />
            {/* Providers (owner's choice C1, board-4; choice A, docs/mocks/settings-providers-compact): every
                API key on one page, a vendor's alone at its own address, Account pools, and a key's connect
                and edit pages, all in Settings' right-hand column. */}
            <Route path="providers" element={<SettingsProvidersHome />} />
            <Route path="providers/new" element={<ProviderPickPage />} />
            <Route path="providers/new/:slug" element={<ProviderConnectPage />} />
            <Route path="providers/keys/:id" element={<ProviderConnectPage />} />
            <Route path="providers/pools" element={<SettingsPoolsPage />} />
            <Route path="providers/pools/:id" element={<ProviderPoolPage />} />
            <Route path="providers/:vendor" element={<SettingsKeysPage />} />
            <Route path="workspaces/:id" element={<SettingsWorkspacePage />} />
          </Route>
          <Route element={<AppShell />}>
            <Route index element={<DefaultLanding />} />
            {/* One element for all three, so the list is one instance across them (TaskRoute). */}
            <Route path="tasks" element={<TaskRoute />} />
            <Route path="tasks/:id" element={<TaskRoute />} />
            <Route path="lists/:key" element={<TaskRoute />} />
            {/* Machines are Settings' now: /infrastructure opens one (InfrastructureRoute), its #keys and
                #pools, and the old /providers addresses, land on Settings' Providers pages. */}
            <Route path="infrastructure" element={<InfrastructureRoute />} />
            <Route path="providers" element={<ProvidersRedirect />} />
            <Route path="providers/*" element={<ProvidersRedirect />} />
            <Route path="admin/providers" element={<ProvidersRedirect />} />
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
            <Route path="runners/:id" element={<RunnerRedirect />} />
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
