import { Alert, Button, Card, Descriptions, Result, Space, Spin, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { approveCliLogin, denyCliLogin, getCliLoginRequest, type CliLoginRequest } from '../api';
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
      column={1}
      size="small"
      bordered
      style={{ marginBottom: 16 }}
      styles={{ label: { width: 136, whiteSpace: 'nowrap' } }}
    >
      <Descriptions.Item label="Token name">{request.name}</Descriptions.Item>
      <Descriptions.Item label="Scopes">
        <div>{scopeSummary(request.scopes)}</div>
        <div style={{ marginTop: 6 }}>
          {request.scopes.map((scope) => (
            <Tag key={scope} style={{ marginBottom: 4 }}>
              {scope}
            </Tag>
          ))}
        </div>
      </Descriptions.Item>
      <Descriptions.Item label="Expires">
        {request.expiresInDays === null ? (
          <Tag color="warning">{NEVER_EXPIRES}</Tag>
        ) : (
          lifetimeLine(request.expiresInDays, now)
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Requested from">{request.hostname ?? 'Unknown host'}</Descriptions.Item>
      <Descriptions.Item label="Code">{request.userCode}</Descriptions.Item>
    </Descriptions>
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
            <Spin />
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
                <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={NEVER_EXPIRES_WARNING} />
              )}
              {request.nameInUse && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={`You already have an access token named "${request.name}".`}
                  description={
                    <>
                      Revoke it under Settings → Access tokens, or run <code>orbit login --name</code> with
                      another name.
                    </>
                  }
                />
              )}
              <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                <Button disabled={submitting !== null} loading={submitting === 'DENIED'} onClick={() => decide('DENIED')}>
                  Deny
                </Button>
                <Button
                  type="primary"
                  disabled={request.nameInUse || submitting !== null}
                  loading={submitting === 'APPROVED'}
                  onClick={() => decide('APPROVED')}
                >
                  Approve
                </Button>
              </Space>
            </>
          )
        )}
      </Card>
    </div>
  );
}
