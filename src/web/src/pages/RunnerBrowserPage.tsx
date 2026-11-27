import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginEngine, RunnerLoginState } from '@orbit/shared';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import { pastDeadline, type OwnerRequest } from '../lib/ownerRequests';
import { ownerRequestsQuery } from '../lib/queries';
import { sameResourceId } from '../lib/watches';
import { RUNNER_BROWSER_COPY as COPY, isMacLike, runnerBrowserQuery } from '../lib/runnerBrowser';
import { VncCanvas, type Link, type PasteState } from '../components/RunnerBrowserScreen';
import { ENGINE_NAME, inFlight, loginKey } from '../components/RunnerSignIn';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { NotFoundPage } from './NotFoundPage';
import '../components/RunnerBrowserDrawer.css';

/**
 * The Orbit Cloud runner's browser in a tab of its own, `/runners/:id/browser` (owner's option C, 2026-11-19; board
 * docs/mocks/runner-browser/02-control-view frames ② and ③): only the viewer, with a slim bar, so the runner's
 * 1280×800 screen has the window.
 *
 *   - In control (Settings' Open browser and a session's Take control open it so, `?control=1`): the bar says the
 *     agent keeps running, with Fit / 100% and Done, which only stops sending input and stays here view only. The
 *     footer says which session uses the browser, how to paste, the size and scale, and Live.
 *   - View only (the drawer's Open in new tab): the bar says who uses the browser, with a link to that session, and
 *     Take control. Nothing is sent: no pointer, no keys, no paste.
 *   - A sign-in request (browser_request_sign_in) open for this runner puts a banner above the bar (board
 *     03-agent-tools frame ①, notes ④ ⑤): the site and the session that asked, and I'm signed in, which answers the
 *     card as signed in so the agent's waiting turn carries on. Done only stops control and answers nothing; Not now
 *     is the card's.
 *   - An engine sign-in this tab saw going through the runner's browser that then failed (Antigravity refusing the
 *     account, say) puts a banner above the bar with what the runner said: the vendor's last page, a static code
 *     page for Antigravity, otherwise looks as if it hangs. A success needs none: the card closes this tab.
 *   - Closing the tab closes the stream. With the server's browser switch off, or for a runner that is not the
 *     caller's managed one, GET /runners/:id/browser is 404 and this page is not found, like any other.
 */
export function RunnerBrowserPage() {
  const { id = '' } = useParams();
  const runnerId = routeId(id) ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const [control, setControl] = useState(() => new URLSearchParams(location.search).get('control') === '1');
  const [fit, setFit] = useState(true);
  const [link, setLink] = useState<Link>('connecting');
  const [scale, setScale] = useState<number | null>(null);
  const [paste, setPaste] = useState<PasteState | null>(null);
  // One more try when the first open fails: the drawer this tab was opened from may still be letting its stream go.
  const [attempt, setAttempt] = useState(0);
  const everLive = useRef(false);
  const { data: state, isPending } = useQuery(runnerBrowserQuery(runnerId));

  // The address stays the tab's own, whichever way it was opened.
  useEffect(() => {
    if (location.search) navigate({ pathname: location.pathname }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prev = document.title;
    document.title = COPY.tabTitle;
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    if (link === 'live') everLive.current = true;
    if (link !== 'disconnected' || everLive.current || attempt > 0) return undefined;
    const retry = setTimeout(() => setAttempt(1), 1500);
    return () => clearTimeout(retry);
  }, [link, attempt]);

  // A paste's message stays a moment, then the footer's hint comes back.
  useEffect(() => {
    if (!paste || paste.state === 'pasting') return undefined;
    const clear = setTimeout(() => setPaste(null), paste.state === 'failed' ? 6000 : 1500);
    return () => clearTimeout(clear);
  }, [paste]);

  if (isPending) {
    return (
      <div className="rb-tab rb-tab-loading">
        <Spinner />
      </div>
    );
  }
  if (!state) return <NotFoundPage />;

  const holder = state.holderSessionId;
  const holderTitle = state.holderTitle || COPY.untitledSession;
  const holderLine = !holder ? COPY.heldByNone : state.holderTitle ? COPY.heldBy(state.holderTitle) : COPY.heldByUntitled;
  const linkLabel = link === 'live' ? COPY.live : link === 'connecting' ? COPY.connecting : COPY.disconnected;

  return (
    <div className={`rb-tab${control ? ' is-controlling' : ''}`}>
      <EngineSignInFailure runnerId={runnerId} />
      <SignInRequests runnerId={runnerId} />
      <header className="rb-tab-bar">
        {control ? (
          <span className="rb-tab-title">
            <strong>{COPY.controlling}</strong>
            <small> · {COPY.agentKeepsRunning}</small>
          </span>
        ) : (
          <span className="rb-tab-title">
            <strong>{COPY.watching}</strong>
            {holder && (
              <small>
                {' '}
                · {COPY.usedBy}{' '}
                <RouterLink className="rb-tab-session" to={`/sessions/${encodeId(holder)}`}>
                  “{holderTitle}”
                </RouterLink>
              </small>
            )}
          </span>
        )}
        {paste?.state === 'failed' && (
          <span className="rb-paste-error" role="alert">
            {paste.error}
          </span>
        )}
        {control ? (
          <span className="rb-tab-actions">
            <span className="rb-seg" role="group" aria-label="Scale">
              <button type="button" className={fit ? 'is-on' : ''} aria-pressed={fit} onClick={() => setFit(true)}>
                {COPY.fit}
              </button>
              <button type="button" className={fit ? '' : 'is-on'} aria-pressed={!fit} onClick={() => setFit(false)}>
                {COPY.actualSize}
              </button>
            </span>
            <Button onClick={() => setControl(false)}>{COPY.done}</Button>
          </span>
        ) : (
          <span className="rb-tab-actions">
            <Button variant="primary" onClick={() => setControl(true)}>
              {COPY.takeControl}
            </Button>
          </span>
        )}
      </header>
      <main className="rb-tab-stage">
        <VncCanvas
          key={attempt}
          runnerId={runnerId}
          viewOnly={!control}
          fit={control ? fit : true}
          onLink={setLink}
          onScale={setScale}
          onPaste={setPaste}
        />
      </main>
      <footer className="rb-tab-foot">
        <span className="rb-holder">{control ? holderLine : COPY.viewOnly}</span>
        {control && (
          <span className="rb-paste-hint">
            {paste?.state === 'pasting' ? COPY.pasting : COPY.pasteHint(isMacLike())}
          </span>
        )}
        <span className="rb-size">{COPY.size(scale)}</span>
        <span className={`rb-link is-${link}`}>{linkLabel}</span>
      </footer>
    </div>
  );
}

/**
 * The failure of an engine sign-in this tab saw under way in the runner's browser (its state carried `browser`), as
 * the sign-in card shows it. One that had already ended when the tab opened is history and shows nothing, as on the
 * card; a new attempt under way takes the banner down.
 */
function EngineSignInFailure({ runnerId }: { runnerId: string }) {
  const { data } = useQuery({
    queryKey: loginKey(runnerId),
    queryFn: () => api<RunnerLoginState>(`/runners/${runnerId}/login`),
    // The card asks the runner to open the page only after this tab opened, so the read goes on while nothing is under
    // way, at the pace of the runner's heartbeat; a sign-in under way is read as often as the card reads it.
    refetchInterval: (q) => (inFlight(q.state.data?.status) ? 2000 : 10_000),
    refetchIntervalInBackground: true,
  });
  const [watched, setWatched] = useState<LoginEngine | null>(null);
  const status = data?.status;
  const underWayHere = inFlight(status) && !!data?.browser && !!data.engine;
  useEffect(() => {
    if (underWayHere) setWatched(data!.engine);
  }, [underWayHere, data]);
  if (!watched || status !== 'failed') return null;
  return (
    <div className="rb-sign-in is-failed" role="alert">
      <span className="rb-sign-in-text">
        {COPY.engineSignInFailed(ENGINE_NAME[watched])}
        {data?.message ? ` — ${data.message}` : ''} {COPY.engineSignInRetry}
      </span>
    </div>
  );
}

/** The open sign-in requests for this runner's browser, one banner each, oldest first. */
function SignInRequests({ runnerId }: { runnerId: string }) {
  const { data } = useQuery(ownerRequestsQuery('open'));
  // Answered here: gone at once, before the list is read again.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const now = Date.now();
  const asking = (data?.requests ?? [])
    .filter(
      (r) =>
        r.kind === 'BROWSER_SIGN_IN' &&
        r.state === 'PENDING' &&
        !answered.has(r.id) &&
        !pastDeadline(r, now) &&
        !!r.browserRunnerId &&
        sameResourceId(r.browserRunnerId, runnerId),
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (asking.length === 0) return null;
  return (
    <>
      {asking.map((request) => (
        <SignInBanner key={request.id} request={request} onAnswered={() => setAnswered((s) => new Set(s).add(request.id))} />
      ))}
    </>
  );
}

function SignInBanner({ request, onAnswered }: { request: OwnerRequest; onAnswered: () => void }) {
  const qc = useQueryClient();
  // I'm signed in is the card's own answer, DONE: the agent's waiting call reads it as SIGNED_IN.
  const signedIn = useMutation({
    mutationFn: () => api<OwnerRequest>(`/owner-requests/${encodeURIComponent(request.id)}/done`, { method: 'POST', body: {} }),
    onSuccess: onAnswered,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['owner-requests'] });
    },
  });
  const title = request.askedBySessionTitle?.trim() || null;
  return (
    <div className="rb-sign-in" role="region" aria-label={COPY.signInAsked(request.browserSite ?? '', null)}>
      <span className="rb-sign-in-text">{COPY.signInAsked(request.browserSite ?? '', title)}</span>
      {signedIn.isError && (
        <span className="rb-paste-error" role="alert">
          {COPY.signedInFailed}
        </span>
      )}
      <Button variant="primary" disabled={signedIn.isPending} onClick={() => signedIn.mutate()}>
        {COPY.signedIn}
      </Button>
    </div>
  );
}
