import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Typography } from 'antd';
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  ExportOutlined,
  LoadingOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { api, ApiError } from '../api';
import {
  codexLoginPath,
  loginLine,
  loginName,
  poolLogins,
  type CodexLogin,
  type CodexLoginAttempt,
  type CodexLoginPoll,
} from '../lib/codexLogin';
import { formatResetTime, type ProviderPool } from '../lib/providerPools';
import { ownsPool } from '../lib/sharedPools';
import { ProviderTile } from './ProviderGallery';

/**
 * "Sign in with ChatGPT": the accounts a Codex pool runs on go in by the official codex CLI's device flow,
 * run on the Orbit server (CodexLoginService) — one account per sign-in, as many as the pool's people
 * sign in (migration 0371; its owner alone before that). First what that means — the account runs the
 * sessions of everyone in the pool, its sign-in stays on the server, and only one's own accounts may go
 * in — then the page to open and the one-time code to enter there, while this polls until the person has
 * approved it; then the account, by its email and `…AB12`, never a token, and how many accounts the pool
 * holds now. The same dialog puts
 * an account OpenAI signed out back in.
 *
 * Closing it before the code is approved gives the sign-in up on the server: nothing half-done is left
 * running there.
 */

/** How often the dialog asks whether the code has been approved. */
const POLL_MS = 2000;

type Step =
  | { kind: 'consent' }
  | { kind: 'code'; url: string; code: string; expiresAt: string }
  | { kind: 'done'; account: CodexLogin | null; logins: CodexLogin[] }
  | { kind: 'expired' }
  | { kind: 'failed'; reason: string }
  | { kind: 'dup'; email: string | null };

/** A reason in the server's words, as a sentence of its own. */
const sentence = (reason: string) => {
  const text = reason.trim();
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
};

/** The step a poll's answer moves the dialog to, or null while it is still waiting on the person. */
function pollStep(poll: CodexLoginPoll): Step | null {
  switch (poll.status) {
    case 'PENDING':
      return null;
    case 'CONFIRMED':
      return { kind: 'done', account: poll.account, logins: poll.logins ?? (poll.account ? [poll.account] : []) };
    case 'EXPIRED':
      return { kind: 'expired' };
    case 'CANCELLED':
      return { kind: 'failed', reason: 'it was cancelled' };
    case 'FAILED':
      return { kind: 'failed', reason: poll.error ?? 'the codex CLI stopped without a sign-in' };
    default:
      // Nothing in flight here any more (the server restarted, or another tab finished it): an account
      // that is in and running is the sign-in done; anything else has to start again.
      return poll.account?.state === 'ACTIVE'
        ? { kind: 'done', account: poll.account, logins: poll.logins ?? [poll.account] }
        : { kind: 'failed', reason: 'the Orbit server has no sign-in in progress for this pool' };
  }
}

/** A refusal the dialog has a step of its own for — the same account signed in twice — or null. */
function refusalStep(e: unknown): Step | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'POOL_CODEX_ACCOUNT_DUPLICATE') {
    // The server names the account this sign-in turned out to be in its refusal's own words; an older
    // one names only the pool, and the sentence then reads without the address.
    const email = e.body?.email;
    return { kind: 'dup', email: typeof email === 'string' ? email : null };
  }
  return null;
}

export function CodexSignInModal({
  pool,
  login = null,
  onClose,
}: {
  /** The pool it adds an account to, or puts one back in. */
  pool: ProviderPool;
  /** The account a sign-in again is for, once OpenAI signed it out; null to add one more. */
  login?: CodexLogin | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'consent' });
  const [starting, setStarting] = useState(false);
  const held = login;
  const again = held !== null;
  // Whose pool it is, from the view it carries: a pool of one's own (no `shared`) or one the reader is
  // its owner of. The account runs the whole pool's sessions either way (migration 0371).
  const mine = !pool.shared || ownsPool(pool.shared);
  // How many accounts the pool holds now: what the notice says it is adding one to.
  const accounts = poolLogins(pool).length;
  const path = codexLoginPath(pool.id);
  // Whether a sign-in may be running on the server for this dialog: what closing it has to give up.
  const live = useRef(false);
  // The dialog is gone: a start still on its way gives the sign-in it started up rather than show it.
  const closed = useRef(false);

  const start = async () => {
    setStarting(true);
    try {
      const attempt = await api<CodexLoginAttempt>(path, { method: 'POST' });
      if (closed.current) {
        void api(path, { method: 'DELETE' }).catch(() => undefined);
        return;
      }
      live.current = true;
      setStep({ kind: 'code', url: attempt.verificationUrl, code: attempt.userCode, expiresAt: attempt.expiresAt });
    } catch (e) {
      setStep({ kind: 'failed', reason: e instanceof Error && e.message ? e.message : 'Failed' });
    } finally {
      setStarting(false);
    }
  };

  // While the code is out: ask, every couple of seconds, whether the person approved it.
  const waiting = step.kind === 'code';
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let next: Step | null = null;
      try {
        next = pollStep(await api<CodexLoginPoll>(path));
      } catch (e) {
        // A refusal is an answer; a dropped request is not — ask again.
        next = refusalStep(e);
        if (!next && e instanceof ApiError && e.status === 404) {
          next = { kind: 'failed', reason: 'this pool no longer exists' };
        }
      }
      if (stopped) return;
      if (next) {
        live.current = false;
        if (next.kind === 'done') void qc.invalidateQueries({ queryKey: ['providers'] });
        setStep(next);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waiting, path, qc]);

  // Leaving before it was approved gives the sign-in up — the code and the CLI waiting on it with it.
  const close = () => {
    closed.current = true;
    if (live.current) {
      live.current = false;
      void api(path, { method: 'DELETE' }).catch(() => undefined);
    }
    onClose();
  };
  useEffect(
    () => () => {
      closed.current = true;
      if (live.current) void api(path, { method: 'DELETE' }).catch(() => undefined);
    },
    [path],
  );

  const footer =
    step.kind === 'consent' ? (
      // What this step's press is about: the one-time code to enter on OpenAI's page, which is what
      // comes next — not the sign-in itself, which is finished there (03-flows, the notice's press).
      <>
        <Button onClick={close}>Cancel</Button>
        <Button type="primary" loading={starting} onClick={() => void start()}>
          Get a code
        </Button>
      </>
    ) : step.kind === 'code' ? (
      <Button onClick={close}>Cancel</Button>
    ) : step.kind === 'done' ? (
      <Button type="primary" onClick={close}>
        Done
      </Button>
    ) : (
      // Expired, stopped, or the same account signed in twice: the ways out are to close, and to start
      // over — with the same account or, after a duplicate, with a different one.
      <>
        <Button onClick={close}>Close</Button>
        <Button type="primary" loading={starting} onClick={() => void start()}>
          {step.kind === 'failed' ? 'Try again' : 'Get a new code'}
        </Button>
      </>
    );

  return (
    <Modal open width={500} title="Sign in with ChatGPT" footer={footer} onCancel={close}>
      {/* Adding one more to a pool that already runs on an account of its own: the notice says what the
          pool runs on now, that everyone in the pool — once it is shared — runs on this account too, and
          what the pool does without it. */}
      {step.kind === 'consent' && !again && accounts > 0 && (
        <div className="pa-consent">
          <div className="pa-lead">
            Sign in with another ChatGPT account of yours to add it to <b>{pool.label}</b>. It runs on{' '}
            {accounts} account{accounts === 1 ? '' : 's'} now.
          </div>
          <ul className="pa-facts">
            <li>
              {mine ? (
                <>
                  <b>Everyone in the pool runs on it.</b> Once {pool.label} is shared, the people you add
                  run their sessions on this account too — and see it, with its usage, on the pool’s page.
                </>
              ) : (
                <>
                  <b>Everyone in the pool runs on it.</b> Everyone here runs their sessions on this
                  account too — you included — and sees it, with its usage, on the pool’s page.
                </>
              )}
            </li>
            <li>
              <b>The sign-in stays on the Orbit server.</b> It never goes to a runner. Runners get a
              session token, not your login.
            </li>
            <li>
              <b>Sign out any time.</b> {pool.label} keeps running on its other accounts.
            </li>
          </ul>
          <div className="pa-risk">
            <WarningFilled />
            <span>
              <b>Only your own accounts.</b> Signing in with someone else’s ChatGPT account is sharing it,
              and so is putting yours in a pool others run on: OpenAI’s terms treat both as a violation,
              and an account used that way can be suspended.
            </span>
          </div>
        </div>
      )}
      {step.kind === 'consent' && (again || accounts === 0) && (
        <div className="pa-consent">
          <div className="pa-lead">
            {again ? (
              <>
                OpenAI signed {held?.email ?? 'this account'} out. Sign in with it again to put it back in{' '}
                <b>{pool.label}</b>.
              </>
            ) : (
              <>
                Sign in with your own ChatGPT account to run <b>{pool.label}</b> on it.
              </>
            )}
          </div>
          <ul className="pa-facts">
            <li>
              {mine ? (
                <>
                  <b>Yours, and whoever you add.</b> A pool that is just yours runs your sessions alone;
                  add people and their sessions start on this account too.
                </>
              ) : (
                <>
                  <b>Everyone in this pool runs on it.</b> Add it, and everyone here — you included —
                  runs their sessions on this account.
                </>
              )}
            </li>
            <li>
              <b>The sign-in stays on the Orbit server.</b> It never goes to a runner — runners get a
              session token, not your login — and nobody sees its tokens.
            </li>
            <li>
              <b>Sign out any time.</b> Its usage, and when it resets, show on this pool’s page.
            </li>
          </ul>
          <div className="pa-risk">
            <WarningFilled />
            <span>
              <b>{mine ? 'Adding people shares your account.' : 'Everyone here runs on your account.'}</b>{' '}
              Their sessions run on it — OpenAI’s terms treat account sharing as a violation, and an
              account used that way can be suspended.
            </span>
          </div>
        </div>
      )}
      {step.kind === 'code' && (
        <div className="cx-code-step">
          <div className="cx-open">
            <Button type="primary" icon={<ExportOutlined />} href={step.url} target="_blank" rel="noopener noreferrer">
              Open the sign-in page
            </Button>
            <a className="cx-url" href={step.url} target="_blank" rel="noopener noreferrer">
              {step.url}
            </a>
          </div>
          <div className="cx-hint">
            {again && held?.email ? (
              <>
                Sign in there as <b>{held.email}</b>, then enter this one-time code:
              </>
            ) : (
              'Sign in there, then enter this one-time code:'
            )}
          </div>
          <div className="cx-code">
            <Typography.Text
              className="cx-code-text"
              copyable={{ text: step.code, tooltips: ['Copy code', 'Copied'] }}
            >
              {step.code}
            </Typography.Text>
          </div>
          <div className="cx-wait">
            <LoadingOutlined /> Waiting for you to approve it…
          </div>
          <div className="cx-expiry">The code works until {formatResetTime(step.expiresAt)}.</div>
        </div>
      )}
      {step.kind === 'done' && (
        <div className="pa-added">
          <div className="pa-done">
            <CheckCircleFilled />
            <div>
              <div className="pa-done-t">
                {step.account ? loginName(step.account) : 'Your ChatGPT account'} is in {pool.label}
              </div>
              <div className="pa-done-s">
                {pool.label} has {step.logins.length} account{step.logins.length === 1 ? '' : 's'} now. A
                session moves to this one when the account it’s on runs out.
              </div>
            </div>
          </div>
          {step.account && (
            <div className="pa-acct">
              <ProviderTile slug="openai" label="ChatGPT" size={28} />
              <div>
                <div className="pa-acct-t">{loginName(step.account)}</div>
                <div className="pa-acct-s">
                  {loginLine(step.account)} · its sign-in stays on the Orbit server
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {step.kind === 'expired' && (
        <div className="pa-done pa-dup">
          <ExclamationCircleFilled />
          <div>
            <div className="pa-done-t">The code expired</div>
            <div className="pa-done-s">It wasn’t approved in time. Get a new code to try again.</div>
          </div>
        </div>
      )}
      {step.kind === 'failed' && (
        <div className="pa-done pa-dup">
          <ExclamationCircleFilled />
          <div>
            <div className="pa-done-t">The sign-in didn’t finish</div>
            <div className="pa-done-s">{sentence(step.reason)}</div>
          </div>
        </div>
      )}
      {step.kind === 'dup' && (
        <div className="pa-done pa-dup">
          <ExclamationCircleFilled />
          <div>
            <div className="pa-done-t">This ChatGPT account is already in {pool.label}</div>
            <div className="pa-done-s">
              {step.email
                ? `${step.email} is one of its accounts, and signing it in twice adds no quota. Sign in with a different account.`
                : 'It’s one of its accounts, and signing it in twice adds no quota. Sign in with a different account.'}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
