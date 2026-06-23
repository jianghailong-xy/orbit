import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useMatch } from 'react-router-dom';
import { getToken } from '../api';
import { decodeId } from '../lib/idCodec';
import {
  agentsQuery,
  meQuery,
  runnersQuery,
  sessionQuery,
  sessionsQuery,
  setupStatusQuery,
} from '../lib/queries';

// Routes that render their own loaders and have no first-screen data to wait on.
const BYPASS = ['/login', '/enroll', '/setup'];

type BootWindow = Window & {
  __bootProgress?: (pct: number) => void;
  __bootDone?: () => void;
};

// Drive / dismiss the first-paint splash defined in index.html.
const setBootProgress = (pct: number) => (window as BootWindow).__bootProgress?.(pct);
const finishBoot = () => (window as BootWindow).__bootDone?.();

// The console deep-links the splash must cover before revealing: opening one of these
// straight from a reload lands in AgentView, whose first screen needs the runner-scoped
// session data — not the global lists the home view waits on.
type DeepLink = { kind: 'session' | 'agent'; id: string };

/**
 * Holds the app behind the index.html boot splash until the data the *first screen*
 * needs has resolved, so the UI appears in one shot instead of filling in piecemeal.
 * The bar is determinate: the mounted app plus each settled critical query are real
 * milestones that each fill an equal slice. Every query shares its key with the
 * page/sidebar, so those read straight from cache and never refetch.
 *
 * Which queries are critical depends on the landed route. The home/list views wait on
 * the global session + runner lists. A reload on /sessions/<id> or /agents/<id> instead
 * lands in AgentView: resolve its runner (session detail, or the agents list), then warm
 * the runner-scoped active-session list AgentView reads on open — otherwise the splash
 * dismisses too early and the console flashes a spinner / "Starting…" while that lands.
 *
 * Only the authenticated app pre-warms. A signed-out visitor on a real route instead
 * waits on a single check — setup-status — so a fresh, zero-user deployment can be routed
 * to first-run /setup before any page renders. The bypass routes (login/enroll/setup)
 * pass straight through. The decision is latched on mount, so the 4s/15s background
 * refetches and later in-app navigations never bring the splash back.
 */
export function BootGate({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const sessionMatch = useMatch('/sessions/:id');
  const agentMatch = useMatch('/agents/:id/*');
  const hasToken = !!getToken();
  const onBypass = BYPASS.includes(loc.pathname);
  // Signed-out boot on a real route: the deployment may have zero users (fresh install),
  // in which case every path must funnel to /setup. The client can't know that locally,
  // so the splash holds while we ask the server. A token implies users exist, so only the
  // signed-out path runs this check.
  const [needsSetupCheck] = useState(() => !hasToken && !onBypass);
  // Hold the splash for any non-bypass route — signed-in to pre-warm the first screen,
  // signed-out to resolve setup-status before routing.
  const [gated] = useState(() => !onBypass);
  // The deep-link the very first paint must cover, latched on mount so later in-app
  // navigations (and the background refetches) never re-gate the splash.
  const [deep] = useState<DeepLink | null>(() => {
    const sid = sessionMatch?.params.id ? decodeId(sessionMatch.params.id) : null;
    if (sid) return { kind: 'session', id: sid };
    const aid = agentMatch?.params.id ? decodeId(agentMatch.params.id) : null;
    if (aid) return { kind: 'agent', id: aid };
    return null;
  });
  const [booted, setBooted] = useState(() => !gated);

  // Signed-out: the only thing the splash waits on is whether this is a zero-user system.
  const setupStatus = useQuery({ ...setupStatusQuery(), enabled: needsSetupCheck });
  // Business pre-warm is for the signed-in app only; firing these while signed out would
  // 401 (and bounce to /login), so they gate on `warm`, not `gated`.
  const warm = gated && hasToken;

  // Every query below reuses the shared factory keys (lib/queries) so the data the splash
  // pre-warms lands under the exact keys the page/console then read from cache.
  const runners = useQuery({ ...runnersQuery(), enabled: warm });
  // Warm the signed-in user so the nav footer's name paints with the first frame.
  // Not a readiness milestone — it must never hold the splash open.
  useQuery({ ...meQuery(), enabled: warm });
  // Home/list routes wait on the global session list (shared with the Active view/sidebar).
  const sessionsGlobal = useQuery({ ...sessionsQuery(), enabled: warm && !deep });
  // A /sessions/<id> deep link carries no runner — its session detail resolves one.
  const sessionDetail = useQuery({
    ...sessionQuery(deep?.kind === 'session' ? deep.id : null),
    enabled: warm && deep?.kind === 'session',
  });
  // An /agents/<id> deep link resolves its runner from the agents list.
  const agents = useQuery({ ...agentsQuery(), enabled: warm && deep?.kind === 'agent' });
  const runnerId =
    deep?.kind === 'session'
      ? (sessionDetail.data?.assignedRunnerId ?? null)
      : deep?.kind === 'agent'
        ? ((agents.data ?? []).find((a) => a.id === deep.id)?.runnerId ?? null)
        : null;
  // The runner-scoped active list AgentView reads on open — same factory, so it lands in
  // cache under the same key and the console paints in one shot instead of flashing "Starting…".
  const scopedSessions = useQuery({
    ...sessionsQuery({ runnerId, view: 'active' }),
    enabled: warm && !!deep && !!runnerId,
  });

  // Per-route readiness milestones (besides the mounted app). The signed-out setup check
  // waits on a single query. For a deep link the third milestone waits on the scoped list
  // once the runner resolves, or — if there is no runner to wait on — on the resolver
  // itself, so it can never trap the splash.
  let checks: boolean[];
  if (needsSetupCheck) {
    checks = [setupStatus.isFetched];
  } else if (deep?.kind === 'session') {
    const resolved = sessionDetail.isFetched;
    checks = [runners.isFetched, resolved, runnerId ? scopedSessions.isFetched : resolved];
  } else if (deep?.kind === 'agent') {
    const resolved = agents.isFetched;
    checks = [runners.isFetched, resolved, runnerId ? scopedSessions.isFetched : resolved];
  } else {
    checks = [runners.isFetched, sessionsGlobal.isFetched];
  }
  const settled = checks.filter(Boolean).length;
  const ready = settled === checks.length;

  // Push real progress to the splash as each milestone completes.
  useEffect(() => {
    if (booted || !gated) return;
    setBootProgress(Math.round(((1 + settled) / (1 + checks.length)) * 100));
  }, [settled, checks.length, booted, gated]);

  // Reveal once every critical query settles (success OR error — never trap the user
  // behind the splash), with a hard timeout as a final backstop.
  useEffect(() => {
    if (booted) return;
    if (ready) {
      setBooted(true);
      return;
    }
    const t = setTimeout(() => setBooted(true), 8000);
    return () => clearTimeout(t);
  }, [ready, booted]);

  useEffect(() => {
    if (booted) finishBoot();
  }, [booted]);

  if (!booted) return null;
  // Fresh, zero-user deployment → send the signed-out visitor into first-run setup. Guard
  // on the live path so that, once redirected, we render /setup instead of looping on it.
  if (needsSetupCheck && setupStatus.data?.needsSetup && loc.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }
  return <>{children}</>;
}
