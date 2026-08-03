import { CheckCircleFilled, ExportOutlined, LoadingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { LoginEngine, RunnerLoginState } from '@orbit/shared';
import { api } from '../api';

const loginKey = (runnerId: string) => ['runner-login', runnerId] as const;

const ENGINE_NAME: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
};

/** A sign-in still under way: the card polls while one of these is current, and seeing one is
 *  what makes the outcome that follows this card's own news rather than a leftover (see below). */
const inFlight = (s: RunnerLoginState['status'] | null | undefined) =>
  s === 'pending' || s === 'awaiting_code' || s === 'awaiting_approval';

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
  onDone,
}: {
  runnerId: string;
  engine?: LoginEngine;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  // Set once a pasted code is on its way to the runner — see `verifying` below.
  const [sent, setSent] = useState(false);
  // Set once this card has seen a sign-in actually running — see `status` below.
  const [watched, setWatched] = useState(false);
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
    mutationFn: () =>
      api<RunnerLoginState>(`/runners/${runnerId}/login`, { method: 'POST', body: { engine } }),
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

  const begin = () => {
    // Park a tab now, while the click is still a user gesture, and hand it the URL when the poll
    // brings one back. A browser that blocked it leaves null here and the anchor takes over.
    //
    // Only claude's flow earns that: its page is usable the moment it exists. A device flow's is
    // not — it asks for the one-time code that arrives *with* the URL and is shown on this card,
    // so opening it first strands the user on a code prompt with no code, after half a minute
    // watching a blank tab. Those wait here and open the page from the card instead.
    if (engine === 'claude') {
      tab.current = window.open('', '_blank');
      tab.current?.document.write(WAITING_PAGE);
    }
    start.mutate();
  };

  const s = state.data;
  // A runner runs one relay at a time. If the one in flight is for the other engine (another card,
  // another tab), this card has nothing to report — show it as idle so pressing it takes over.
  const mine = !s?.engine || s.engine === engine;
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
    return (
      <div className="rsi">
        <a className="rsi-open" href={s.url} target="_blank" rel="noopener noreferrer">
          <ExportOutlined /> Open the sign-in page
        </a>
        <div className="rsi-hint">Sign in there, then enter this one-time code:</div>
        <div className="rsi-usercode">{s.userCode}</div>
        <div className="rsi-row">
          <LoadingOutlined /> Waiting for you to approve it…
        </div>
        <button className="rsi-link" onClick={() => cancel.mutate()} type="button">
          Cancel
        </button>
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

  // Idle, or a failed attempt the user can retry.
  return (
    <div className="rsi">
      {status === 'failed' && s?.message && <div className="rsi-warn">{s.message}</div>}
      {err && <div className="rsi-warn">{err.message}</div>}
      <button className="rsi-btn" onClick={begin} disabled={start.isPending} type="button">
        {start.isPending
          ? 'Starting…'
          : status === 'failed'
            ? `Try signing in to ${ENGINE_NAME[engine]} again`
            : `Sign in to ${ENGINE_NAME[engine]} from here`}
      </button>
    </div>
  );
}
