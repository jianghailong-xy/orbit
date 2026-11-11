import { ExportOutlined } from '@ant-design/icons';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import type { GithubAppChange, GithubAppSettings } from '@orbit/shared';
import { api } from '../api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Textarea } from '../components/ui/Textarea';
import '../components/ui/Card.css';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';

/** `GET` and `PUT /admin/integrations/github` (docs/github-workspace-design.md §5.1): never a secret, only whether one is saved. */
export const githubAppQuery = () =>
  queryOptions({
    queryKey: ['admin', 'integrations', 'github'] as const,
    queryFn: () => api<GithubAppSettings>('/admin/integrations/github'),
  });

export const GITHUB_SECRET_UNREADABLE = "The saved secret can't be read. Enter it again.";

/** "7 people have connected GitHub · 12 workspaces were cloned". */
export function githubConnectedText({ connectedUsers, clonedWorkspaces }: GithubAppSettings): string {
  const people = connectedUsers === 0
    ? 'Nobody has connected GitHub'
    : connectedUsers === 1 ? '1 person has connected GitHub' : `${connectedUsers} people have connected GitHub`;
  const cloned = clonedWorkspaces === 1 ? '1 workspace was cloned' : `${clonedWorkspaces} workspaces were cloned`;
  return `${people} · ${cloned}`;
}

/**
 * Admin → Integrations → GitHub App (board 02): the App this deployment's accounts connect GitHub through.
 * The client secret and the private key go in and never come back out. Saving asks GitHub's GET /app
 * whether the App ID and the private key are a pair; the server refuses the save, and says why, when not.
 */
export function GithubAppCard() {
  const message = useToast();
  const qc = useQueryClient();
  const saved = useQuery(githubAppQuery());
  const [draft, setDraft] = useState<{ enabled?: boolean; appId?: string; clientId?: string }>({});
  const [secret, setSecret] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const ids = { title: useId(), enabled: useId(), appId: useId(), clientId: useId(), secret: useId(), key: useId() };

  const save = useMutation({
    mutationFn: (body: GithubAppChange) => api<GithubAppSettings>('/admin/integrations/github', { method: 'PUT', body }),
    onSuccess: (settings) => {
      qc.setQueryData(githubAppQuery().queryKey, settings);
      setDraft({});
      setSecret('');
      setKey(null);
      message.success('GitHub App saved');
    },
    onError: (e: Error) => message.error("Couldn't save the GitHub App", e.message),
  });

  const copy = async (url: string) => {
    if (await copyText(url)) message.success('Callback URL copied');
    else message.error("Couldn't copy the callback URL", 'Select it and copy it by hand.');
  };

  if (saved.isPending) return <Spinner />;
  if (saved.isError) {
    return (
      <p className="admin-signin-error" role="alert">
        Couldn’t load the GitHub App: {saved.error.message}
      </p>
    );
  }

  const settings = saved.data;
  const on = settings.enabled && !settings.secretUnreadable && settings.secretSaved && settings.keySaved;
  const enabled = draft.enabled ?? on;
  const appId = draft.appId ?? settings.appId ?? '';
  const clientId = draft.clientId ?? settings.clientId;
  const keyText = key?.trim() ?? '';
  const changed =
    enabled !== on
    || appId.trim() !== (settings.appId ?? '')
    || clientId.trim() !== settings.clientId
    || secret.trim() !== ''
    || keyText !== '';
  const ready = appId.trim() !== '' && clientId.trim() !== '' && (settings.keySaved || keyText !== '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ready || save.isPending) return;
    save.mutate({
      enabled,
      appId: appId.trim(),
      clientId: clientId.trim(),
      ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
      ...(keyText ? { privateKey: keyText } : {}),
    });
  };

  const readKeyFile = async (file: File | undefined) => {
    if (file) setKey(await file.text());
  };

  return (
    <>
      <form className="orbit-card admin-signin github-app-card" onSubmit={submit} aria-labelledby={ids.title}>
        <div className="orbit-card-head">
          <h2 className="orbit-card-title" id={ids.title}>
            GitHub App
          </h2>
          <Badge tone={on ? 'success' : 'default'}>{on ? 'On' : 'Off'}</Badge>
        </div>
        <div className="orbit-card-body admin-signin-fields">
          {settings.secretUnreadable && (
            <div className="admin-signin-warning" role="alert">
              {GITHUB_SECRET_UNREADABLE}
            </div>
          )}

          <div className="admin-signin-row">
            <div>
              <div className="admin-signin-label" id={ids.enabled}>
                Let people clone from GitHub
              </div>
              <div className="admin-signin-hint">Settings offers Connect GitHub, and a machine’s setup card offers From GitHub.</div>
            </div>
            <Switch aria-labelledby={ids.enabled} checked={enabled} onCheckedChange={(value) => setDraft((d) => ({ ...d, enabled: value }))} />
          </div>

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.appId}>
              App ID
            </label>
            <Input
              id={ids.appId}
              value={appId}
              inputMode="numeric"
              placeholder="1043271"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, appId: e.target.value }))}
            />
            <div className="admin-signin-hint">
              {settings.slug ? (
                <>
                  Checked with GitHub when you save: <b>{settings.slug}</b> (github.com/apps/{settings.slug})
                </>
              ) : (
                'Checked with GitHub when you save.'
              )}
            </div>
          </div>

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.clientId}>
              Client ID
            </label>
            <Input
              id={ids.clientId}
              value={clientId}
              placeholder="Iv23li…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, clientId: e.target.value }))}
            />
          </div>

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.secret}>
              Client secret
            </label>
            <Input
              id={ids.secret}
              type="password"
              value={secret}
              placeholder={settings.secretSaved && !settings.secretUnreadable ? 'A secret is saved. Enter a new one to replace it.' : 'Paste the client secret'}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.key}>
              Private key
            </label>
            {settings.keySaved && key === null ? (
              <div className="admin-signin-redirect">
                <span className="admin-signin-hint">A key is saved (.pem)</span>
                <Button size="small" onClick={() => setKey('')}>
                  Replace…
                </Button>
              </div>
            ) : (
              <>
                <Textarea
                  id={ids.key}
                  value={key ?? ''}
                  rows={4}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
                <div className="admin-signin-hint">
                  Paste the .pem file GitHub generated, or{' '}
                  <label className="github-app-file">
                    choose it
                    <input type="file" accept=".pem" hidden onChange={(e) => void readKeyFile(e.target.files?.[0])} />
                  </label>
                  .
                </div>
              </>
            )}
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label">Callback URL</div>
            <div className="admin-signin-redirect">
              <code>{settings.callbackUrl}</code>
              <Button size="small" onClick={() => void copy(settings.callbackUrl)}>
                Copy
              </Button>
            </div>
            <div className="admin-signin-hint">Enter this exactly in the app’s settings on GitHub.</div>
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label">Connected accounts</div>
            <div className="admin-feishu-count">{githubConnectedText(settings)}</div>
          </div>

          <div className="admin-signin-actions">
            <Button variant="primary" type="submit" disabled={!changed || !ready} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>

      <section className="orbit-card admin-signin github-app-steps" aria-label="Register the app on GitHub">
        <div className="orbit-card-head">
          <h2 className="orbit-card-title">Register the app on GitHub</h2>
        </div>
        <div className="orbit-card-body">
          <ol className="github-app-step-list">
            <li>
              <b>Create a GitHub App</b> under your organization: Settings → Developer settings → GitHub Apps → New GitHub App.{' '}
              <a href="https://github.com/settings/apps/new" target="_blank" rel="noreferrer">
                Open GitHub <ExportOutlined />
              </a>
            </li>
            <li>
              <b>Callback URL:</b> the one above. Turn on <b>Request user authorization (OAuth) during installation</b>. Leave{' '}
              <b>Expire user authorization tokens</b> on.
            </li>
            <li>
              <b>Webhook:</b> turn it off. Orbit doesn’t need one.
            </li>
            <li>
              <b>Repository permissions:</b> <code>Contents: Read and write</code> <code>Metadata: Read-only</code>. Nothing else — no
              account or organization permissions.
            </li>
            <li>
              <b>Where can this app be installed:</b> Any account, so people can install it on their own repositories.
            </li>
            <li>
              Create it, then <b>generate a private key</b> and a <b>client secret</b>, and enter them with the App ID and Client ID above.
            </li>
          </ol>
        </div>
      </section>
    </>
  );
}
