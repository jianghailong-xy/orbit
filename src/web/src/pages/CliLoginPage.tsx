import { useEffect, useState } from 'react';
import { approveCliLogin, denyCliLogin, getCliLoginRequest, type CliLoginRequest } from '../api';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Descriptions } from '../components/ui/Descriptions';
import { Result } from '../components/ui/Result';
import { Spinner } from '../components/ui/Spinner';
import { NEVER_EXPIRES, NEVER_EXPIRES_WARNING, fullDate, scopeSummary } from '../lib/accessTokens';
import { useToast } from '../lib/toast';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the token would last, said where it is approved; `now` is when the page reads it. */
export function lifetimeLine(expiresInDays: number | null, now: number): string {
  if (expiresInDays === null) return NEVER_EXPIRES;
  return `${expiresInDays} days, until about ${fullDate(new Date(now + expiresInDays * DAY_MS).toISOString())}`;
}

/** The token being asked for, and from where: everything a person approves it on. */
export function CliLoginDetails({ request, now }: { request: CliLoginRequest; now: number }) {
  return (
    <Descriptions
      labelWidth={136}
      style={{ marginBottom: 16 }}
      items={[
        { key: 'name', label: 'Token name', children: request.name },
        {
          key: 'scopes',
          label: 'Scopes',
          children: (
            <>
              <div>{scopeSummary(request.scopes)}</div>
              <div style={{ marginTop: 6 }}>
                {request.scopes.map((scope) => (
                  <Badge key={scope} style={{ marginBottom: 4 }}>
                    {scope}
                  </Badge>
                ))}
              </div>
            </>
          ),
        },
        {
          key: 'expires',
          label: 'Expires',
          children:
            request.expiresInDays === null ? <Badge tone="warning">{NEVER_EXPIRES}</Badge> : lifetimeLine(request.expiresInDays, now),
        },
        { key: 'host', label: 'Requested from', children: request.hostname ?? 'Unknown host' },
        { key: 'code', label: 'Code', children: request.userCode },
      ]}
    />
  );
}

type Decision = 'APPROVED' | 'DENIED';

const decisionOf = (status: CliLoginRequest['status']): Decision | null =>
  status === 'DENIED' ? 'DENIED' : status === 'PENDING' ? null : 'APPROVED';

/**
 * The browser half of `orbit login` (docs/personal-access-token-design.md §7.3), reached via
 * /cli-login?code=XXXXX-XXXXX the way `orbit register` reaches /enroll. Signed in, a person sees the
 * token a terminal asks for — its name, scopes and lifetime, and the host asking — and approves or
 * denies it. Approving issues nothing here: the terminal collects the token, issued to this account,
 * the next time it asks, and this page never sees it.
 */
export function CliLoginPage() {
  const message = useToast();
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  const [request, setRequest] = useState<CliLoginRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!code) {
      setError('Missing login code. Open the link orbit login printed in your terminal.');
      setLoading(false);
      return;
    }
    getCliLoginRequest(code)
      .then((found) => {
        setRequest(found);
        setDecision(decisionOf(found.status));
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [code]);

  const decide = async (wanted: Decision) => {
    setSubmitting(wanted);
    try {
      await (wanted === 'APPROVED' ? approveCliLogin(code) : denyCliLogin(code));
      setDecision(wanted);
    } catch (e) {
      message.error(wanted === 'APPROVED' ? "Couldn't approve this login" : "Couldn't deny this login", (e as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg-base)' }}>
      <Card title="🔑 Approve orbit login" style={{ width: 500 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spinner />
          </div>
        ) : error ? (
          <Result status="warning" title="Cannot approve this login" subTitle={error} />
        ) : decision === 'APPROVED' ? (
          <Result
            status="success"
            title="Login approved"
            subTitle={`Return to your terminal — orbit login collects the token "${request?.name}" and finishes by itself.`}
          />
        ) : decision === 'DENIED' ? (
          <Result
            status="info"
            title="Login denied"
            subTitle="No token was issued. orbit login in that terminal stops and says the request was denied."
          />
        ) : (
          request && (
            <>
              <p style={{ marginTop: 0 }}>
                A terminal is asking for a personal access token that acts as you. Approve it only if you
                just ran <code>orbit login</code> and the code below matches the one it shows.
              </p>
              <CliLoginDetails request={request} now={now} />
              {request.expiresInDays === null && (
                <Alert type="warning" style={{ marginBottom: 16 }} title={NEVER_EXPIRES_WARNING} />
              )}
              {request.nameInUse && (
                <Alert
                  type="error"
                  style={{ marginBottom: 16 }}
                  title={`You already have an access token named "${request.name}".`}
                  description={
                    <>
                      Revoke it under Settings → Access tokens, or run <code>orbit login --name</code> with
                      another name.
                    </>
                  }
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <Button disabled={submitting !== null} loading={submitting === 'DENIED'} onClick={() => decide('DENIED')}>
                  Deny
                </Button>
                <Button
                  variant="primary"
                  disabled={request.nameInUse || submitting !== null}
                  loading={submitting === 'APPROVED'}
                  onClick={() => decide('APPROVED')}
                >
                  Approve
                </Button>
              </div>
            </>
          )
        )}
      </Card>
    </div>
  );
}
