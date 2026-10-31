import { CheckOutlined, ClockCircleOutlined, CloseOutlined, CopyOutlined, DesktopOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  approveDeviceEnrollment,
  clearToken,
  denyDeviceEnrollment,
  getDeviceEnrollment,
  logoutSession,
  type DeviceEnrollment,
} from '../api';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { copyText } from '../lib/clipboard';
import { encodeId } from '../lib/idCodec';
import { machineDraftPath } from '../lib/machineSetup';
import { ENROLL_NEXT_BODY, ENROLL_NEXT_TITLE, ENROLL_OPEN_MACHINE, START_A_SESSION } from '../lib/machineSetupCopy';
import { meQuery } from '../lib/queries';
import { ago } from '../lib/runnerEngines';
import { useToast } from '../lib/toast';
import { OrbitAppIcon } from './LoginPage';

type Decision = 'APPROVED' | 'DENIED';
type Mark = 'pending' | 'approved' | 'denied' | 'expired';

/** What is left of the request's ten minutes, as the page counts it down: `9:41`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The machine and the account it joins, and a line between them that says how it went. */
function EnrollMark({ mark }: { mark: Mark }) {
  return (
    <div className={`enroll-mark enroll-mark-${mark}`} aria-hidden>
      <span className="login-orbits" />
      <span className="enroll-machine">
        <DesktopOutlined />
      </span>
      <span className="enroll-link">
        {mark !== 'pending' && (
          <span className="enroll-link-badge">
            {mark === 'approved' ? <CheckOutlined /> : mark === 'denied' ? <CloseOutlined /> : <ClockCircleOutlined />}
          </span>
        )}
      </span>
      <OrbitAppIcon />
    </div>
  );
}

/** The login's page — its background, its column — around one state of the request. */
function EnrollShell({ mark, children }: { mark: Mark; children: ReactNode }) {
  return (
    <div className="login-page enroll-page">
      <main className="enroll-form">
        <EnrollMark mark={mark} />
        {children}
      </main>
    </div>
  );
}

/**
 * The identity being approved and where it goes: the machine (its hostname only when `--name` chose
 * another name, its labels only when it has some), where the request came from, the account it
 * joins, and how long is left.
 */
export function EnrollmentDetails({
  info,
  account,
  expiresIn,
  onSwitchAccount,
}: {
  info: DeviceEnrollment;
  account?: string;
  expiresIn?: number | null;
  onSwitchAccount?: () => void;
}) {
  return (
    <dl className="enroll-facts">
      <div>
        <dt>Machine</dt>
        <dd className="enroll-fact-strong">{info.name}</dd>
      </div>
      {info.hostname && info.hostname !== info.name && (
        <div>
          <dt>Hostname</dt>
          <dd>{info.hostname}</dd>
        </div>
      )}
      {info.labels.length > 0 && (
        <div>
          <dt>Labels</dt>
          <dd>
            {info.labels.map((l) => (
              <Badge key={l}>{l}</Badge>
            ))}
          </dd>
        </div>
      )}
      {info.requesterIp && (
        <div>
          <dt>From</dt>
          <dd>
            {info.requesterIp}
            {info.sameNetwork && <span className="enroll-fact-ok"> · same network as this browser</span>}
          </dd>
        </div>
      )}
      {account && (
        <div>
          <dt>Account</dt>
          <dd className="enroll-fact-row">
            <span>{account}</span>
            {onSwitchAccount && (
              <button type="button" className="enroll-text-button" onClick={onSwitchAccount}>
                Switch
              </button>
            )}
          </dd>
        </div>
      )}
      {expiresIn != null && (
        <div>
          <dt>Expires</dt>
          <dd className={expiresIn < 60_000 ? 'enroll-fact-warning' : undefined}>in {countdown(expiresIn)}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The browser half of `orbit register`, reached via /enroll?code=XXXXX-XXXXX: the machine a terminal
 * asks to add as a runner, approved or denied here. Drawn as the login is, since a person signing in
 * to approve comes straight from it.
 */
export function EnrollPage() {
  const message = useToast();
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  const { data: me } = useQuery(meQuery());
  const [info, setInfo] = useState<DeviceEnrollment | null>(null);
  const [loading, setLoading] = useState(!!code);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  // Gone from the server: past its ten minutes, already used, or decided by another account.
  const [gone, setGone] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!code) return;
    getDeviceEnrollment(code)
      .then((found) => {
        setInfo(found);
        if (found.status !== 'PENDING') setDecision(found.status);
        setRunnerId(found.runnerId);
      })
      .catch(() => setGone(true))
      .finally(() => setLoading(false));
  }, [code]);

  const pending = !!info && !decision && !gone;
  useEffect(() => {
    if (!pending) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [pending]);

  const expiresIn = info ? Date.parse(info.expiresAt) - now : null;
  const expired = gone || (pending && expiresIn !== null && expiresIn <= 0);

  const decide = async (wanted: Decision) => {
    setSubmitting(wanted);
    try {
      if (wanted === 'APPROVED') setRunnerId((await approveDeviceEnrollment(code)).runnerId);
      else await denyDeviceEnrollment(code);
      setDecision(wanted);
    } catch (e) {
      // Expired, or used up, while the page sat open: say so in place of the request.
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else message.error(wanted === 'APPROVED' ? "Couldn't register this machine" : "Couldn't deny this request", (e as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  // Another account: signed out, and back here once signed in — the code lasts its ten minutes.
  const switchAccount = async () => {
    await logoutSession();
    clearToken();
    location.href = `/login?next=${encodeURIComponent('/enroll' + location.search)}`;
  };

  if (loading) {
    return (
      <div className="login-page enroll-page">
        <main className="enroll-form">
          <Spinner />
        </main>
      </div>
    );
  }

  if (!code || expired || !info) {
    return (
      <EnrollShell mark="expired">
        <h1 className="login-title">{code ? 'This link has expired' : 'This link is missing its code'}</h1>
        <p className="login-subtitle">
          {code ? (
            <>
              A register link works once, for 10 minutes. Run <code>orbit register</code> on the machine again — it
              prints a new one.
            </>
          ) : (
            <>
              Open the link that <code>orbit register</code> printed in your terminal.
            </>
          )}
        </p>
        <button
          type="button"
          className="enroll-command"
          aria-label="Copy orbit register"
          onClick={() =>
            void copyText('orbit register').then((ok) =>
              ok ? message.success('Command copied') : message.error("Couldn't copy the command"),
            )
          }
        >
          <span className="enroll-command-prompt">$</span>orbit register
          <CopyOutlined className="enroll-command-copy" />
        </button>
        <a className="enroll-quiet-link" href="/">
          Go to Orbit
        </a>
      </EnrollShell>
    );
  }

  if (decision === 'APPROVED') {
    return (
      <EnrollShell mark="approved">
        <h1 className="login-title">Machine registered</h1>
        <p className="login-subtitle">
          <b className="enroll-name">{info.name}</b> is on your account. Go back to the terminal — it finishes setting
          up by itself.
        </p>
        <div className="enroll-next">
          <div className="enroll-next-title">{ENROLL_NEXT_TITLE}</div>
          <div className="enroll-next-body">{ENROLL_NEXT_BODY}</div>
        </div>
        <div className="enroll-actions">
          <a className="login-submit enroll-submit-link" href={runnerId ? machineDraftPath(runnerId) : '/'}>
            {START_A_SESSION}
          </a>
        </div>
        <a className="enroll-quiet-link" href={runnerId ? `/runners/${encodeId(runnerId)}` : '/infrastructure'}>
          {ENROLL_OPEN_MACHINE}
        </a>
      </EnrollShell>
    );
  }

  if (decision === 'DENIED') {
    return (
      <EnrollShell mark="denied">
        <h1 className="login-title">Request denied</h1>
        <p className="login-subtitle">
          Nothing was added to your account. <code>orbit register</code> in that terminal stops and says the request was
          denied.
        </p>
        <a className="enroll-quiet-link" href="/">
          Go to Orbit
        </a>
      </EnrollShell>
    );
  }

  const conflict = info.nameConflict;
  return (
    <EnrollShell mark="pending">
      <h1 className="login-title">{conflict ? 'Re-register this machine?' : 'Approve this machine?'}</h1>
      <p className="login-subtitle">
        A terminal ran <code>orbit register</code> and is waiting. Approve only if that was you, just now.
      </p>

      <div className="enroll-code" aria-label="Verification code">
        {info.userCode}
      </div>
      <p className="enroll-code-hint">It should match the code in your terminal.</p>

      <EnrollmentDetails info={info} account={me?.email} expiresIn={expiresIn} onSwitchAccount={() => void switchAccount()} />

      {conflict && (
        <Alert
          type="warning"
          className="enroll-alert"
          title={`"${info.name}" is already on your account`}
          description={
            <>
              {info.existingLastSeenAt && <>Last online {ago(info.existingLastSeenAt, now)}. </>}
              Approving gives it a new credential and the old one stops working; its workspaces and history stay. A
              different computer with the same name? Deny, then run <code>orbit register --name &lt;new-name&gt;</code>{' '}
              on it.
            </>
          }
        />
      )}

      <div className="enroll-actions">
        <button
          type="button"
          className={`login-submit${conflict ? ' enroll-submit-danger' : ''}`}
          disabled={submitting !== null}
          onClick={() => void decide('APPROVED')}
        >
          {submitting === 'APPROVED' ? 'Approving…' : conflict ? 'Re-register' : 'Approve'}
        </button>
        <Button
          className="enroll-deny"
          size="large"
          disabled={submitting !== null}
          loading={submitting === 'DENIED'}
          onClick={() => void decide('DENIED')}
        >
          Deny
        </Button>
      </div>

      <p className="enroll-note">
        Once approved, it runs agents for your workspaces with the coding CLIs signed in on it. Remove it any time in
        Settings → Machines &amp; models.
      </p>
    </EnrollShell>
  );
}
