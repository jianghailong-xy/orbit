import { ExportOutlined, GithubOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { GithubIntegration } from '@orbit/shared';
import { api } from '../api';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Popconfirm } from '../components/ui/Popconfirm';
import { Spinner } from '../components/ui/Spinner';
import '../components/ui/Card.css';
import {
  GITHUB_NOT_SET_UP,
  connectGithub,
  githubErrorText,
  githubIntegrationQuery,
  installationSettingsUrl,
  installationText,
} from '../lib/githubIntegration';
import { useToast } from '../lib/toast';

const PAGE = '/settings/integrations/github';

/** "2 workspaces keep their folders. …" — said before Disconnect when any workspace came from GitHub (board 02, note 3). */
export function disconnectWarning(workspaceCount: number): string {
  const lead = workspaceCount === 1 ? '1 workspace keeps its folder.' : `${workspaceCount} workspaces keep their folders.`;
  return `${lead} Clones and landings that need GitHub will stop until you connect again.`;
}

/**
 * Settings → Integrations → GitHub (docs/github-workspace-design.md §8, board 02): the account's GitHub
 * connection, and where Orbit's app is installed. Which repositories the app reaches is managed on GitHub;
 * this page lists the installations and links there.
 */
export function GithubIntegrationPage() {
  const message = useToast();
  const qc = useQueryClient();
  const integration = useQuery(githubIntegrationQuery());
  const [params, setParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const returned = params.get('github');
  const failed = params.get('github_error');

  // The callback's answer, said once; the address loses it so a reload does not say it again.
  useEffect(() => {
    if (returned === 'connected') message.success('GitHub connected');
    if (returned !== null || failed !== null) {
      if (returned === 'installed') void qc.invalidateQueries({ queryKey: githubIntegrationQuery().queryKey });
      setParams((p) => {
        p.delete('github');
        p.delete('github_error');
        return p;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned]);
  const [error] = useState(failed);

  const disconnect = useMutation({
    mutationFn: () => api<GithubIntegration>('/integrations/github', { method: 'DELETE' }),
    onSuccess: (view) => {
      qc.setQueryData(githubIntegrationQuery().queryKey, view);
      message.success('GitHub disconnected');
    },
    onError: (e: Error) => message.error("Couldn't disconnect GitHub", e.message),
  });

  const connect = async () => {
    setConnecting(true);
    try {
      await connectGithub(PAGE);
    } catch (e) {
      setConnecting(false);
      message.error("Couldn't start connecting GitHub", (e as Error).message);
    }
  };

  if (integration.isPending) {
    return (
      <div className="github-page">
        <Spinner />
      </div>
    );
  }
  if (integration.isError) {
    return (
      <div className="github-page">
        <h1 className="page-title">GitHub</h1>
        <Alert
          type="error"
          title="Couldn't load your GitHub connection"
          description={integration.error.message}
          action={<Button size="small" onClick={() => void integration.refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  const view = integration.data;
  return (
    <div className="github-page">
      <div className="github-crumb">
        <Link to="/settings">Settings</Link> / Integrations
      </div>
      <h1 className="page-title">GitHub</h1>
      {error && <Alert type="error" title={githubErrorText(error)} className="github-alert" />}
      {!view.available && <Alert type="warning" title={GITHUB_NOT_SET_UP} className="github-alert" />}

      <section className="orbit-card github-card" aria-label="Your GitHub account">
        <div className="orbit-card-head">
          <h2 className="orbit-card-title">Your GitHub account</h2>
          {view.connected && (
            <Badge tone={view.needsReconnect ? 'warning' : 'success'}>{view.needsReconnect ? 'Sign in again' : 'Connected'}</Badge>
          )}
        </div>
        <div className="orbit-card-body">
          {view.connected ? (
            <div className="github-account">
              <span className="github-avatar" aria-hidden>
                {(view.login ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <div className="github-account-text">
                <div className="github-login">@{view.login}</div>
                <div className={view.needsReconnect ? 'github-hint github-warn' : 'github-hint'}>
                  {view.needsReconnect
                    ? `@${view.login} needs to sign in again`
                    : `Connected ${new Date(view.connectedAt ?? Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Orbit sees only the repositories you install its app on.`}
                </div>
              </div>
              {view.needsReconnect && view.available && (
                <Button variant="primary" icon={<GithubOutlined />} loading={connecting} onClick={() => void connect()}>
                  Reconnect
                </Button>
              )}
              <Popconfirm
                title="Disconnect GitHub?"
                description={view.workspaceCount > 0 ? disconnectWarning(view.workspaceCount) : 'Orbit forgets your GitHub sign-in. You can connect again any time.'}
                confirmText="Disconnect"
                danger
                onConfirm={() => disconnect.mutateAsync()}
                trigger={
                  <Button danger loading={disconnect.isPending}>
                    Disconnect
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="github-account">
              <div className="github-account-text">
                <div className="github-hint">Connect GitHub to clone your repositories into workspaces. Orbit sees only the repositories you install its app on.</div>
              </div>
              {view.available && (
                <Button variant="primary" icon={<GithubOutlined />} loading={connecting} onClick={() => void connect()}>
                  Connect
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {view.connected && !view.needsReconnect && (
        <section className="orbit-card github-card" aria-label="Where Orbit's app is installed">
          <div className="orbit-card-head">
            <h2 className="orbit-card-title">Where Orbit’s app is installed</h2>
          </div>
          <div className="orbit-card-body">
            {view.installations === null ? (
              <div className="github-hint">GitHub didn’t answer. Try again in a moment.</div>
            ) : (
              <ul className="github-installations">
                {view.installations.map((installation) => (
                  <li key={installation.id} className="github-installation">
                    <span className="github-installation-name">{installation.account}</span>
                    <a href={installationSettingsUrl(installation)} target="_blank" rel="noreferrer">
                      Configure on GitHub <ExportOutlined />
                    </a>
                    <span className="github-hint">{installationText(installation)}</span>
                  </li>
                ))}
                {view.installUrl && (
                  <li className="github-installation">
                    <span />
                    <a href={view.installUrl} target="_blank" rel="noreferrer">
                      {view.installations.length === 0 ? 'Install on GitHub' : 'Install on another account'} <ExportOutlined />
                    </a>
                  </li>
                )}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
