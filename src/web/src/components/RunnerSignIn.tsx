import { CheckCircleFilled, ExportOutlined, LoadingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  KIMI_LOGIN_REGION_V1,
  KIMI_REGIONS,
  type KimiRegion,
  type LoginEngine,
  type RunnerEngineHealth,
  type RunnerLoginState,
} from '@orbit/shared';
import { api } from '../api';
import { runnersQuery } from '../lib/queries';

const loginKey = (runnerId: string) => ['runner-login', runnerId] as const;

/** Kimi Code's two sites, in the words Kimi's own sign-in uses: each keeps accounts of its own, so
 *  the user picks the one they signed up on. */
export const KIMI_SITE: Record<KimiRegion, { domain: string; where: string }> = {
  'mainland-cn': { domain: 'kimi.com', where: 'Mainland China' },
  global: { domain: 'kimi.ai', where: 'International' },
};

/** The site a device-flow page belongs to, read off the URL the CLI printed rather than the site
 *  asked for: it is the page the user is about to sign in on. */
export function kimiSiteOf(url: string | null | undefined): KimiRegion | null {
  try {
    const host = new URL(url ?? '').hostname;
    if (host === 'kimi.ai' || host.endsWith('.kimi.ai')) return 'global';
    if (host === 'kimi.com' || host.endsWith('.kimi.com')) return 'mainland-cn';
  } catch {
    // Not a URL at all: no site to name.
  }
  return null;
}

/** The CLI's own name, as its vendor spells it. Shared with the Providers page's engine rows so
 *  the same machine never gets two names for the same binary. */
export const ENGINE_NAME: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
};

export function GoogleSignInTerms() {
  return <div className="rsi-hint"><a href="https://antigravity.google/terms" target="_blank" rel="noreferrer">Google terms</a> restrict personal account sign-in through third-party tools; your account may be suspended.</div>;
}

/** A sign-in still under way: the card polls while one of these is current, and seeing one is
 *  what makes the outcome that follows this card's own news rather than a leftover (see below). */
const inFlight = (s: RunnerLoginState['status'] | null | undefined) =>
  s === 'pending' || s === 'awaiting_code' || s === 'awaiting_approval';

/** The slice of GET /runners this card reads back: whether that machine's probe has caught up, and
 *  for Kimi whether it can be told a site and which one its login is on. */
type ProbedRunner = { id: string; engines?: RunnerEngineHealth[] | null; capabilities?: string[] | null };

/** Does the runner's own probe now say this engine is signed in? "unknown" is not a yes — the
 *  wait below is bounded precisely because a CLI that won't answer never becomes one. Given an
 *  account of an engine that keeps them, it is that account's own answer: the engine's is Default's,
 *  and says nothing about any other. Given Kimi's site, it is a login on that site: one moved from
 *  the other site was already signed in before, and that yes is the old login's. */
export function probeReportsSignedIn(
  runners: ProbedRunner[] | undefined,
  runnerId: string,
  engine: LoginEngine,
  account?: string,
  accountName?: string,
  site?: KimiRegion,
): boolean {
  const health = runners
    ?.find((r) => r.id === runnerId)
    ?.engines?.find((e) => e.engine === engine);
  if (account || accountName) {
    const accounts = health?.accounts;
    if (accounts) {
      return accounts.some(
        (a) =>
          a.auth === 'yes' &&
          (account ? a.id === account : a.name?.trim() === accountName?.trim()),
      );
    }
    // A named account must appear in the account list before this wait can end. Falling back to
    // the engine's auth bit here is wrong for a new account (or a non-Default slot): that bit
    // answers for Default, which may already be signed in while the target is absent from the
    // heartbeat. Default is the one exception because the engine bit is its own answer.
    if (accountName || account !== 'default') return false;
  }
  if (site && health?.kimiRegion !== site) return false;
  return health?.auth === 'yes' && (engine !== 'antigravity' || health.authSource === 'google');
}

/** How often the runner list is re-read while waiting for that probe, and for how long: the
 *  runner re-probes the moment the CLI exits and reports it with a heartbeat of its own, but an
 *  older one only reports on its next heartbeat, so this is a check-in (30s) plus the probe, with
 *  room for one missed heartbeat. */
const PROBE_POLL_MS = 4000;
const PROBE_WAIT_MS = 90_000;

/** What the parked tab shows until the CLI prints its URL, so it doesn't read as a dead popup. */
const WAITING_PAGE = `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;color:#666">
Waiting for the sign-in link…</body>`;

/**
 * Sign a runner back in from the browser, without a terminal on that machine.
 *
 * The runner drives the CLI's sign-in on its own box and reports back what the user has to do.
 * The engines get there differently, which is why this renders two shapes:
 *
 *  - claude: the CLI prints a URL whose redirect_uri is Anthropic-hosted, not localhost, so the
 *    user approves it in their own browser and the callback page shows a code to paste back here.
 *    What travels through Orbit is a single-use authorization code, useless without the PKCE
 *    verifier that never leaves the runner process.
 *  - codex/kimi: their device flows print a URL *and* a one-time code to enter on that page; the
 *    CLI then polls for the approval itself, so there is nothing to paste back — we just wait.
 *    (Plain `codex login` can't be relayed at all: it serves its callback on localhost on the
 *    runner; Kimi's ordinary `kimi login` is already a device flow.)
 *
 * Either way the URL is slow to arrive: the runner is told to start signing in on its next
 * heartbeat, half a minute off at worst, and only then does the CLI print anything. By that point
 * a window.open() is long outside the user gesture and gets blocked as a popup — so claude's
 * click parks a tab on a holding page and the poll points it at the URL when it lands. The anchor
 * stays either way: it is the fallback when the browser blocked the tab, or the user closed it,
 * and it is all a device flow gets (see `begin`).
 */
export function RunnerSignIn({
  runnerId,
  engine = 'claude',
  account,
  accountName,
  onDone,
  onUseApiKey,
  onCancel,
  autoStart,
}: {
  runnerId: string;
  engine?: LoginEngine;
  /** Sign in this account the runner already has — `default` or a slot id — of an engine that
   *  keeps accounts. Absent: the runner's own login, exactly as before accounts. */
  account?: string;
  /** Sign in a NEW account, which the runner adds under this name. The button waits for one: a
   *  blank name would read as no account at all, which is the runner's own login. */
  accountName?: string;
  onDone?: () => void;
  /** Take the other route out: a key on the account, good for every runner. Offered beside the
   *  sign-in while it is still a choice — once one is under way the other is just noise. */
  onUseApiKey?: () => void;
  /** Close the card. Offered beside the button, while there is no sign-in of its own to cancel. */
  onCancel?: () => void;
  /** Start signing in as the card opens, not on its button: the press that opened it — "+ Account"
   *  — already asked for the sign-in. */
  autoStart?: boolean;
}) {
  const qc = useQueryClient();
  // Kimi signs in on one of two sites. Whether this runner can be told which, and which one its login
  // is on now, are the runner list's to say — read here rather than handed down, so every card that
  // signs Kimi in (an engine row, a session's sign-in card) offers the same choice.
  const kimiRunner = useQuery({
    ...runnersQuery(),
    enabled: engine === 'kimi',
    select: (list) => (list as ProbedRunner[]).find((r) => r.id === runnerId),
  });
  const choosesSite = !!kimiRunner.data?.capabilities?.includes(KIMI_LOGIN_REGION_V1);
  const currentSite = kimiRunner.data?.engines?.find((e) => e.engine === 'kimi')?.kimiRegion;
  // Both sites can always be pressed. A runner too old to be told a site signs in where its CLI
  // decides — kimi.com, on an install Orbit made — so kimi.com goes to it unnamed; kimi.ai is named
  // either way, and such a runner is refused it in words that say to update it (RunnerApiController).
  const kimiSiteToName = (region: KimiRegion) => (choosesSite || region === 'global' ? region : undefined);
  const [code, setCode] = useState('');
  // Set once a pasted code is on its way to the runner — see `verifying` below.
  const [sent, setSent] = useState(false);
  // Set once this card has seen a sign-in actually running — see `status` below.
  const [watched, setWatched] = useState(false);
  // Set once this card has started a sign-in itself — see `mine` below.
  const [startedHere, setStartedHere] = useState(false);
  const adding = accountName !== undefined;
  // The tab parked by the click, waiting for a URL to point at. Cleared once it has one.
  const tab = useRef<Window | null>(null);
  const dropTab = () => {
    tab.current?.close();
    tab.current = null;
  };

  const state = useQuery({
    queryKey: loginKey(runnerId),
    queryFn: () => api<RunnerLoginState>(`/runners/${runnerId}/login`),
    // Only poll while something is actually in flight; idle/terminal states are push-free. The
    // device flow completes without any further input from us, so its wait has to be polled too.
    refetchInterval: (q) => (inFlight(q.state.data?.status) ? 2000 : false),
    // The parked tab takes focus the moment it opens, which backgrounds this one — and a
    // background tab stops polling by default, so the URL we opened it for would never arrive.
    refetchIntervalInBackground: true,
  });

  const put = (next: RunnerLoginState) => qc.setQueryData(loginKey(runnerId), next);

  const start = useMutation({
    mutationFn: (region?: KimiRegion) =>
      api<RunnerLoginState>(`/runners/${runnerId}/login`, {
        method: 'POST',
        // Naming no account is the runner's own login, which is what every card said before
        // accounts — so a card for none still says only which engine. The same goes for Kimi's site.
        body: {
          engine,
          ...(account !== undefined ? { account } : {}),
          ...(adding ? { accountName: accountName.trim() } : {}),
          ...(region ? { region } : {}),
        },
      }),
    onSuccess: put,
    onError: dropTab, // no sign-in is coming; don't strand a blank tab
  });
  const submit = useMutation({
    mutationFn: (c: string) =>
      api<RunnerLoginState>(`/runners/${runnerId}/login/code`, { method: 'POST', body: { code: c } }),
    // A poll already in flight would land after this one and restore the message the submit
    // just cleared, which would end the wait below the moment it started.
    onMutate: () => qc.cancelQueries({ queryKey: loginKey(runnerId) }),
    onSuccess: (next) => {
      setCode('');
      setSent(true);
      put(next);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<RunnerLoginState>(`/runners/${runnerId}/login`, { method: 'DELETE' }),
    onMutate: dropTab, // giving up before the URL arrived leaves a blank tab behind
    onSuccess: put,
  });

  const begin = (region?: KimiRegion) => {
    // Park a tab now, while the click is still a user gesture, and hand it the URL when the poll
    // brings one back. A browser that blocked it leaves null here and the anchor takes over.
    //
    // Only claude's flow earns that: its page is usable the moment it exists. A device flow's is
    // not — it asks for the one-time code that arrives *with* the URL and is shown on this card,
    // so opening it first strands the user on a code prompt with no code, after half a minute
    // watching a blank tab. Those wait here and open the page from the card instead.
    if (engine === 'claude' || engine === 'antigravity') {
      tab.current = window.open('', '_blank');
      tab.current?.document.write(WAITING_PAGE);
    }
    setStartedHere(true);
    start.mutate(region);
  };

  // No tab is parked for this one: the press that asked was on another button, and a tab opened from
  // an effect can't count on that press's gesture. The page opens from the card's own link once the
  // URL lands, as a device flow's always does. The ref keeps StrictMode's second mount from starting
  // it twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    setStartedHere(true);
    start.mutate();
  }, [autoStart, start.mutate]);

  const s = state.data;
  // A runner runs one relay at a time. If the one in flight is for the other engine (another card,
  // another tab), this card has nothing to report — show it as idle so pressing it takes over.
  // The same goes for the other accounts of this engine: a card for one says nothing about
  // another's sign-in. A card adding an account owns only the sign-in it started, because until the runner
  // names the slot it added, that sign-in names no account at all.
  const ownAccount = adding ? startedHere : account === undefined || s?.account === account;
  const mine = !s?.engine || (s.engine === engine && ownAccount);
  const reported = mine ? (s?.status ?? null) : null;
  // done/failed stay on the runner until the *next* sign-in starts, so they describe the last
  // attempt rather than whether that machine's credentials are good now. A card raised by a later
  // failure would open on "Signed in — this runner is ready" left over from a sign-in that has
  // since expired or been logged out — the one thing it must never claim while the engine is
  // signed out. So an outcome is only reported if this card watched the sign-in that produced it;
  // one already finished when the card arrives is history, and the card opens on its button, the
  // same as for a runner that has never signed in from the browser.
  const status = watched || inFlight(reported) ? reported : null;
  const err = (start.error ?? submit.error) as Error | undefined;

  useEffect(() => {
    if (inFlight(reported)) setWatched(true);
  }, [reported]);

  // The Kimi site the sign-in under way is on, kept past its URL for the wait below.
  const [signingInOn, setSigningInOn] = useState<KimiRegion | null>(null);
  useEffect(() => {
    if (engine === 'kimi' && reported === 'awaiting_approval') setSigningInOn(kimiSiteOf(s?.url));
  }, [engine, reported, s?.url]);

  // A finished sign-in does not move the engine row this card opened under: that row reads the
  // runner's last heartbeat probe, and the runner only re-probes once the CLI exits, then (an
  // older one) waits for its next check-in — half a minute at worst, with nothing pushing it here
  // and no refetch on focus. So the row kept saying "Signed out", quota withheld, directly beneath
  // this card's "this runner is ready", until the page was reloaded. Re-read the runner list until
  // that machine's own probe agrees — a single refetch on `done` would only lose the same race.
  const [awaitingProbe, setAwaitingProbe] = useState(false);
  useEffect(() => {
    if (status !== 'done') return;
    setAwaitingProbe(true);
    // The runners query is usually already mounted by the Providers page. Mark it stale when the
    // relay finishes so that this transition always starts a fresh list read; merely mounting a
    // second observer can otherwise reuse a just-read cache entry and leave the account rows old.
    void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    const stop = setTimeout(() => setAwaitingProbe(false), PROBE_WAIT_MS);
    return () => clearTimeout(stop);
  }, [qc, status]);
  useQuery({
    ...runnersQuery(),
    enabled: awaitingProbe,
    refetchInterval: (q) =>
      probeReportsSignedIn(
        q.state.data as ProbedRunner[] | undefined,
        runnerId,
        engine,
        // A new account's slot is the one the runner reported adding for this sign-in.
        account ?? (adding ? (s?.account ?? undefined) : undefined),
        // Until the runner reports the new slot, its login state may not have an account id yet.
        // The name is still known locally and keeps the poll from mistaking Default's auth for the
        // new account's sign-in.
        adding ? accountName : undefined,
        // A runner that can choose a site reports its login's: until it names this sign-in's, the
        // yes it gives may be the login on the other site that this one replaced.
        choosesSite ? (signingInOn ?? undefined) : undefined,
      )
        ? false
        : PROBE_POLL_MS,
    // The sign-in is approved in the tab this one opened, so this wait usually starts while the
    // page is backgrounded — where a paused interval would never run it.
    refetchIntervalInBackground: true,
  });

  // Submitting a code only parks it for the runner's next heartbeat — thirty seconds away at
  // worst — and the CLI still has to exchange it after that. So the POST resolving means nothing
  // has happened yet, and stopping there drops the user back on an empty form for half a minute
  // with no sign their code went anywhere. Hold the wait until the polled state actually moves:
  // to done/failed, or back to awaiting_code carrying the CLI's rejection. Submitting clears the
  // message server-side, so a message here can only be news about this paste.
  const verifying = submit.isPending || (sent && status === 'awaiting_code' && !s?.message);

  useEffect(() => {
    // Anything but awaiting_code — cancelled, restarted, finished — settles the paste above.
    if (status !== 'awaiting_code') setSent(false);
  }, [status]);

  useEffect(() => {
    if (!tab.current || !mine) return;
    if (status === 'failed') {
      dropTab();
      return;
    }
    if (!s?.url) return;
    const w = tab.current;
    tab.current = null;
    if (!w.closed) w.location.replace(s.url);
  }, [mine, status, s?.url]);

  // A card that goes away mid-flow can never point its tab anywhere.
  useEffect(() => dropTab, []);

  if (status === 'done') {
    return (
      <div className="rsi rsi-done">
        <CheckCircleFilled /> Signed in — this runner is ready.
        {onDone && (
          <button className="rsi-link" onClick={onDone} type="button">
            Retry my message
          </button>
        )}
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="rsi">
        <div className="rsi-row">
          <LoadingOutlined /> Starting sign-in on the runner…
        </div>
        <div className="rsi-hint">
          The runner picks it up on its next check-in, so the link can take up to a minute to
          show here.
        </div>
        <button className="rsi-link" onClick={() => cancel.mutate()} type="button">
          Cancel
        </button>
      </div>
    );
  }

  if (verifying) {
    return (
      <div className="rsi">
        <div className="rsi-row">
          <LoadingOutlined /> Signing in with your code…
        </div>
        <div className="rsi-hint">
          The runner picks it up on its next check-in, so this can take up to a minute.
        </div>
        <button className="rsi-link" onClick={() => cancel.mutate()} type="button">
          Cancel
        </button>
      </div>
    );
  }

  // Device flow: the code goes to the browser, not back through here, so all we can do is show
  // both halves and wait for the CLI to finish approving itself.
  if (status === 'awaiting_approval' && s?.url) {
    // Kimi's page belongs to one of its two sites, named so the user knows which account it wants.
    const site = engine === 'kimi' ? kimiSiteOf(s.url) : null;
    const other: KimiRegion = site === 'global' ? 'mainland-cn' : 'global';
    const cancelLink = (
      <button className="rsi-link" onClick={() => cancel.mutate()} type="button">
        Cancel
      </button>
    );
    return (
      <div className="rsi">
        <a className="rsi-open" href={s.url} target="_blank" rel="noopener noreferrer">
          <ExportOutlined /> {site ? `Open the ${KIMI_SITE[site].domain} sign-in page` : 'Open the sign-in page'}
        </a>
        <div className="rsi-hint">
          {adding ? (
            <>
              Sign in <b>with the other account</b>, then enter this one-time code:
            </>
          ) : site ? (
            <>
              Sign in with your <b>{KIMI_SITE[site].domain}</b> account there, then enter this one-time code:
            </>
          ) : (
            'Sign in there, then enter this one-time code:'
          )}
        </div>
        <div className="rsi-usercode">{s.userCode}</div>
        <div className="rsi-row">
          <LoadingOutlined /> Waiting for you to approve it…
        </div>
        {/* The wrong site is the one mistake the user can't see until they are on its page: their
            account isn't there. Starting over on the other one is a single press. */}
        {site ? (
          <div className="rsi-links">
            {cancelLink}
            <button className="rsi-link" onClick={() => begin(kimiSiteToName(other))} type="button">
              Use {KIMI_SITE[other].domain} instead
            </button>
          </div>
        ) : (
          cancelLink
        )}
      </div>
    );
  }

  if (status === 'awaiting_code' && s?.url) {
    return (
      <div className="rsi">
        {/* A rejected code lands back here with the SAME url still valid — the CLI keeps waiting
            on that challenge — so the message is what tells the user anything changed. */}
        {s.message && <div className="rsi-warn">{s.message}</div>}
        <a className="rsi-open" href={s.url} target="_blank" rel="noopener noreferrer">
          <ExportOutlined /> Open the sign-in page
        </a>
        <div className="rsi-hint">
          Approve it there, then paste the code the page gives you:
        </div>
        <div className="rsi-form">
          <input
            className="rsi-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim()) submit.mutate(code);
            }}
          />
          <button
            className="rsi-btn"
            disabled={!code.trim()}
            onClick={() => submit.mutate(code)}
            type="button"
          >
            Submit
          </button>
        </div>
        {err && <div className="rsi-warn">{err.message}</div>}
        <button className="rsi-link" onClick={() => cancel.mutate()} type="button">
          Cancel
        </button>
      </div>
    );
  }

  // Idle, or a failed attempt the user can retry. The two ways back in sit side by side here:
  // signing in fixes this one machine with the account the user already pays for; a key fixes
  // every runner at once but has to be issued and pasted. Neither is the obvious default, so
  // they are shown as a choice, with the one that needs nothing new leading.
  //
  // Kimi's sign-in is itself a choice: kimi.com and kimi.ai keep separate accounts, and left to
  // itself the CLI goes to the site its installer came from. So the press that starts it picks the
  // site, and nothing is picked for the user — guessing wrong costs a trip to the other site's page.
  if (engine === 'kimi') {
    return (
      <div className="rsi">
        {status === 'failed' && s?.message && <div className="rsi-warn">{s.message}</div>}
        {err && <div className="rsi-warn">{err.message}</div>}
        <div className="rsi-q">Which Kimi account are you signing in with?</div>
        <div className="rsi-sites">
          {KIMI_REGIONS.map((region) => (
            <button
              key={region}
              className="rsi-site"
              type="button"
              disabled={start.isPending || kimiRunner.isPending}
              onClick={() => begin(kimiSiteToName(region))}
            >
              <span className="rsi-site-name">
                {KIMI_SITE[region].domain}
                {currentSite === region && <span className="rsi-site-tag">Current</span>}
              </span>
              <span className="rsi-site-sub">{KIMI_SITE[region].where}</span>
            </button>
          ))}
          {onUseApiKey && (
            <button className="rsi-btn-alt" onClick={onUseApiKey} type="button">
              Use an API key instead
            </button>
          )}
          {onCancel && (
            <button className="rsi-link" onClick={onCancel} type="button">
              Cancel
            </button>
          )}
        </div>
        <div className="rsi-hint">The two sites keep separate accounts — pick the one you signed up on.</div>
        {onUseApiKey && (
          <div className="rsi-hint">
            Signing in fixes this runner. A key is account-wide — switch to its model to use it.
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="rsi">
      {engine === 'antigravity' && <GoogleSignInTerms />}
      {status === 'failed' && s?.message && <div className="rsi-warn">{s.message}</div>}
      {err && <div className="rsi-warn">{err.message}</div>}
      <div className="rsi-actions">
        <button
          className="rsi-btn"
          onClick={() => begin()}
          disabled={start.isPending || (adding && !accountName.trim())}
          type="button"
        >
          {start.isPending
            ? 'Starting…'
            : status === 'failed'
              ? `Try signing in to ${ENGINE_NAME[engine]} again`
              : engine === 'antigravity' ? 'Sign in with Google' : `Sign in to ${ENGINE_NAME[engine]}`}
        </button>
        {onUseApiKey && (
          <button className="rsi-btn-alt" onClick={onUseApiKey} type="button">
            Use an API key instead
          </button>
        )}
        {onCancel && (
          <button className="rsi-link" onClick={onCancel} type="button">
            Cancel
          </button>
        )}
      </div>
      {onUseApiKey && (
        // Both halves earn their words. "This runner" is the limit of a sign-in — the next
        // machine to run this workspace needs its own. And a key is not self-applying: it arrives
        // as a provider whose models sit in the picker, so saying "account-wide" alone would
        // leave the user staring at a saved key wondering why nothing changed.
        <div className="rsi-hint">
          Signing in fixes this runner. A key is account-wide — switch to its model to use it.
        </div>
      )}
    </div>
  );
}
