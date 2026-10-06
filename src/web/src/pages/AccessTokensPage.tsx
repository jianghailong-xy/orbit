import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircleFilled, CopyOutlined } from '@ant-design/icons';
import { Button, Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { issueAccessToken, revokeAccessToken, type AccessToken, type IssuedAccessToken } from '../api';
import { AccessTokenTable } from '../components/AccessTokenTable';
import { NewAccessTokenDialog, type NewAccessToken } from '../components/NewAccessTokenDialog';
import { copyText } from '../lib/clipboard';
import { accessTokensQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

type Tab = 'active' | 'ended';

/** Said beside the token the one time it is shown (§9). */
export const SHOWN_ONCE =
  'Copy it now — this is the only time it is shown. Once you leave this page, it can’t be seen again.';

/**
 * Settings → Access tokens (docs/personal-access-token-design.md §9): the personal access tokens this
 * account has issued, so scripts and the `orbit` CLI can use the API as you. Active ones can be
 * revoked; revoked and expired ones are kept under their own tab with why they ended. A new token is
 * shown here once, in full, until the page is left or dismissed — the server keeps only its hash.
 */
export function AccessTokensPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const message = useToast();
  const tokensQ = useQuery(accessTokensQuery());
  const workspacesQ = useQuery(workspacesQuery());
  const [creating, setCreating] = useState(false);
  // Each New token opens a fresh form.
  const [dialogKey, setDialogKey] = useState(0);
  const now = Date.now();
  const tokens = tokensQ.data?.tokens ?? [];
  const active = tokens.filter((token) => token.state === 'ACTIVE');
  const ended = tokens.filter((token) => token.state !== 'ACTIVE');
  const tab: Tab = params.get('tab') === 'ended' ? 'ended' : 'active';
  const workspaces: { id: string; name: string }[] = workspacesQ.data ?? [];

  const refresh = () => void qc.invalidateQueries({ queryKey: accessTokensQuery().queryKey });
  // The new token lives in this mutation's answer and nowhere else: never in the query cache, and let
  // go of as soon as this page is (gcTime 0) or dismissed (reset).
  const issue = useMutation({
    mutationFn: (token: NewAccessToken) => issueAccessToken(token),
    gcTime: 0,
    onSuccess: () => {
      setCreating(false);
      setParams({}, { replace: true });
      refresh();
    },
    onError: (e: Error) => message.error("Couldn't create the token", e.message),
  });
  const revoke = useMutation({
    mutationFn: (token: AccessToken) => revokeAccessToken(token.id),
    onSuccess: (_, token) => {
      refresh();
      message.success('Token revoked', `“${token.name}” stopped working.`);
    },
    onError: (e: Error) => message.error("Couldn't revoke the token", e.message),
  });

  return (
    <div className="following-page access-tokens-page">
      <header className="following-head access-tokens-head">
        <div>
          <h1 className="page-title">Access tokens</h1>
          <p className="following-sub">
            Let your scripts and the orbit CLI use the Orbit API as you, with only the access you give each token.
            Treat a token like a password.
          </p>
        </div>
        <Button
          type="primary"
          onClick={() => {
            setDialogKey((key) => key + 1);
            setCreating(true);
          }}
        >
          New token
        </Button>
      </header>
      {issue.data && <IssuedToken issued={issue.data} onDone={() => issue.reset()} />}
      <div className="following-tabs" role="tablist" aria-label="Access tokens">
        {([
          ['active', 'Active', active.length],
          ['ended', 'Revoked & expired', ended.length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`following-tab${tab === key ? ' is-on' : ''}`}
            onClick={() => setParams(key === 'active' ? {} : { tab: key }, { replace: true })}
          >
            {label}
            <span className="following-count">{count}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tokensQ.isPending ? (
          <div className="following-empty">
            <Spin />
          </div>
        ) : tokensQ.isError ? (
          <div className="following-empty">
            Couldn’t load your tokens: {tokensQ.error.message}{' '}
            <Button size="small" onClick={() => void tokensQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <AccessTokenTable
            tokens={tab === 'active' ? active : ended}
            now={now}
            onRevoke={(token) => revoke.mutate(token)}
            revokingId={revoke.isPending ? revoke.variables?.id : null}
            emptyText={
              tab === 'active'
                ? 'No active tokens. Create one to use the API or the orbit CLI as yourself.'
                : 'No token has been revoked or has expired.'
            }
          />
        )}
      </div>
      <NewAccessTokenDialog
        key={dialogKey}
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={(token) => issue.mutate(token)}
        creating={issue.isPending}
        workspaces={workspaces}
      />
    </div>
  );
}

/** The new token, in full, the one time it can be: with a way to copy it and why to do so now. */
function IssuedToken({ issued, onDone }: { issued: IssuedAccessToken; onDone: () => void }) {
  const message = useToast();
  const copy = () =>
    void copyText(issued.token).then((ok) =>
      ok ? message.success('Token copied') : message.error("Couldn't copy the token"),
    );
  return (
    <section className="access-token-issued" aria-label="New access token">
      <div className="access-token-issued-head">
        <CheckCircleFilled className="access-token-issued-icon" />
        <span>
          <b>{issued.name}</b> is ready
        </span>
      </div>
      <p className="access-token-issued-note">{SHOWN_ONCE}</p>
      <div className="access-token-secret-row">
        <code className="access-token-secret">{issued.token}</code>
        <Button icon={<CopyOutlined />} onClick={copy}>
          Copy
        </Button>
      </div>
      <Button size="small" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}
