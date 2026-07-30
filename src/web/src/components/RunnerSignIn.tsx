import { CheckCircleFilled, ExportOutlined, LoadingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { LoginEngine, RunnerLoginState } from '@orbit/shared';
import { api } from '../api';

const loginKey = (runnerId: string) => ['runner-login', runnerId] as const;

const ENGINE_NAME: Record<LoginEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Sign a runner back in from the browser, without a terminal on that machine.
 *
 * The runner drives the CLI's sign-in on its own box and reports back what the user has to do.
 * The two engines get there differently, which is why this renders two shapes:
 *
 *  - claude: the CLI prints a URL whose redirect_uri is Anthropic-hosted, not localhost, so the
 *    user approves it in their own browser and the callback page shows a code to paste back here.
 *    What travels through Orbit is a single-use authorization code, useless without the PKCE
 *    verifier that never leaves the runner process.
 *  - codex: `--device-auth` prints a URL *and* a one-time code to enter on that page; the CLI
 *    then polls for the approval itself, so there is nothing to paste back — we just wait. (Plain
 *    `codex login` can't be relayed at all: it serves its callback on localhost on the runner.)
 *
 * The link is a real anchor the user clicks rather than a window.open() from the poll callback:
 * a popup opened outside a user gesture is blocked, and this flow can't afford to lose the URL.
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

  const state = useQuery({
    queryKey: loginKey(runnerId),
    queryFn: () => api<RunnerLoginState>(`/runners/${runnerId}/login`),
    // Only poll while something is actually in flight; idle/terminal states are push-free. The
    // device flow completes without any further input from us, so its wait has to be polled too.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'pending' || s === 'awaiting_code' || s === 'awaiting_approval' ? 2000 : false;
    },
  });

  const put = (next: RunnerLoginState) => qc.setQueryData(loginKey(runnerId), next);

  const start = useMutation({
    mutationFn: () =>
      api<RunnerLoginState>(`/runners/${runnerId}/login`, { method: 'POST', body: { engine } }),
    onSuccess: put,
  });
  const submit = useMutation({
    mutationFn: (c: string) =>
      api<RunnerLoginState>(`/runners/${runnerId}/login/code`, { method: 'POST', body: { code: c } }),
    onSuccess: (next) => {
      setCode('');
      put(next);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<RunnerLoginState>(`/runners/${runnerId}/login`, { method: 'DELETE' }),
    onSuccess: put,
  });

  const s = state.data;
  // A runner runs one relay at a time. If the one in flight is for the other engine (another card,
  // another tab), this card has nothing to report — show it as idle so pressing it takes over.
  const mine = !s?.engine || s.engine === engine;
  const status = mine ? (s?.status ?? null) : null;
  const err = (start.error ?? submit.error) as Error | undefined;

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
        <div className="rsi-hint">It'll show a link here as soon as the CLI prints one.</div>
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
            disabled={!code.trim() || submit.isPending}
            onClick={() => submit.mutate(code)}
            type="button"
          >
            {submit.isPending ? 'Sending…' : 'Submit'}
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
      <button className="rsi-btn" onClick={() => start.mutate()} disabled={start.isPending} type="button">
        {start.isPending
          ? 'Starting…'
          : status === 'failed'
            ? `Try signing in to ${ENGINE_NAME[engine]} again`
            : `Sign in to ${ENGINE_NAME[engine]} from here`}
      </button>
    </div>
  );
}
