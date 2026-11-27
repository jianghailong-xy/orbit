import { ExportOutlined } from '@ant-design/icons';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import type { GithubAppChange, GithubAppSettings } from '@orbit/shared';
import { api } from '../api';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../components/settings';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Textarea } from '../components/ui/Textarea';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';

/** `GET` and `PUT /admin/integrations/github` (docs/github-workspace-design.md §5.1): never a secret, only whether one is saved. */
export const githubAppQuery = () =>
  queryOptions({
    queryKey: ['admin', 'integrations', 'github'] as const,
    queryFn: () => api<GithubAppSettings>('/admin/integrations/github'),
  });

export const GITHUB_SECRET_UNREADABLE = "The saved secret can't be read. Enter it again.";

/** On for people only when switched on with both secrets saved and readable: what the nav's dot and the badge say. */
export const githubAppOn = (settings: GithubAppSettings): boolean =>
  settings.enabled && !settings.secretUnreadable && settings.secretSaved && settings.keySaved;

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
export function AdminGithubPage() {
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

  if (saved.isPending) {
    return (
      <div className="settings-page">
        <Spinner />
      </div>
    );
  }
  if (saved.isError) {
    return (
      <div className="settings-page">
        <SettingsHeader title="GitHub App" />
        <p className="admin-signin-error" role="alert">
          Couldn’t load the GitHub App: {saved.error.message}
        </p>
      </div>
    );
  }

  const settings = saved.data;
  const on = githubAppOn(settings);
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
    <form className="settings-page admin-form github-app-page" onSubmit={submit} aria-labelledby={ids.title}>
      <SettingsHeader
        title="GitHub App"
        description="Lets people connect GitHub and clone their repositories into workspaces."
      />
      {settings.secretUnreadable && (
        <div className="admin-signin-warning" role="alert">
          {GITHUB_SECRET_UNREADABLE}
        </div>
      )}
      <SettingsSection
        title={<span id={ids.title}>GitHub App</span>}
        action={<Badge tone={on ? 'success' : 'default'}>{on ? 'On' : 'Off'}</Badge>}
      >
        <SettingsCard>
          <SettingsRow
            title={<span id={ids.enabled}>Let people clone from GitHub</span>}
            description="Settings offers Connect GitHub, and a machine’s setup card offers From GitHub."
            control={<Switch aria-labelledby={ids.enabled} checked={enabled} onCheckedChange={(value) => setDraft((d) => ({ ...d, enabled: value }))} />}
          />
          <SettingsRow
            title={<label htmlFor={ids.appId}>App ID</label>}
            description={
              settings.slug ? (
                <>
                  Checked with GitHub when you save: <b>{settings.slug}</b> (github.com/apps/{settings.slug})
                </>
              ) : (
                'Checked with GitHub when you save.'
              )
            }
            control={
              <Input
                id={ids.appId}
                className="admin-row-input"
                value={appId}
                inputMode="numeric"
                placeholder="1043271"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, appId: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title={<label htmlFor={ids.clientId}>Client ID</label>}
            description="On the App’s settings page on GitHub, under About."
            control={
              <Input
                id={ids.clientId}
                className="admin-row-input"
                value={clientId}
                placeholder="Iv23li…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, clientId: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title={<label htmlFor={ids.secret}>Client secret</label>}
            description={
              settings.secretSaved && !settings.secretUnreadable
                ? 'A secret is saved. It is never shown again; leave this empty to keep it.'
                : 'No secret is saved yet. Once saved, it is never shown again.'
            }
            control={
              <Input
                id={ids.secret}
                className="admin-row-input"
                type="password"
                value={secret}
                placeholder={settings.secretSaved && !settings.secretUnreadable ? 'A secret is saved. Enter a new one to replace it.' : 'Paste the client secret'}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setSecret(e.target.value)}
              />
            }
          />
          <SettingsRow
            title={<label htmlFor={ids.key}>Private key</label>}
            description={
              settings.keySaved && key === null ? (
                'A key is saved (.pem). It is never shown again.'
              ) : (
                <>
                  Paste the .pem file GitHub generated, or{' '}
                  <label className="github-app-file">
                    choose it
                    <input type="file" accept=".pem" hidden onChange={(e) => void readKeyFile(e.target.files?.[0])} />
                  </label>
                  .
                </>
              )
            }
            control={
              settings.keySaved && key === null ? (
                <Button size="small" onClick={() => setKey('')}>
                  Replace…
                </Button>
              ) : (
                <Textarea
                  id={ids.key}
                  className="admin-row-input"
                  value={key ?? ''}
                  rows={3}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
              )
            }
          />
          <SettingsRow
            title="Callback URL"
            description={
              <>
                <code className="admin-row-code">{settings.callbackUrl}</code>
                <br />
                Enter this exactly in the app’s settings on GitHub.
              </>
            }
            control={
              <Button size="small" onClick={() => void copy(settings.callbackUrl)}>
                Copy
              </Button>
            }
          />
          <SettingsRow title="Connected accounts" description={githubConnectedText(settings)} />
        </SettingsCard>
      </SettingsSection>
      <div className="admin-form-actions">
        <Button variant="primary" type="submit" disabled={!changed || !ready} loading={save.isPending}>
          Save
        </Button>
      </div>

      <SettingsSection title="Register the app on GitHub">
        <SettingsCard>
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
              <b>Repository permissions:</b> <code>Contents: Read and write</code> <code>Metadata: Read-only</code>{' '}
              <code>Pull requests: Read and write</code> <code>Checks: Read-only</code> <code>Commit statuses: Read-only</code>{' '}
              <code>Actions: Read-only</code> <code>Workflows: Read and write</code>. Nothing else — no account or organization
              permissions. <b>Workflows: Read and write</b> lets Orbit push changes to CI workflow files, and workflows can read the
              repository’s secrets. Leave it out if you don’t want that. A landing that changes a workflow file is then refused by
              GitHub.
            </li>
            <li>
              <b>Where can this app be installed:</b> Any account, so people can install it on their own repositories.
            </li>
            <li>
              Create it, then <b>generate a private key</b> and a <b>client secret</b>, and enter them with the App ID and Client ID above.
            </li>
          </ol>
        </SettingsCard>
      </SettingsSection>
    </form>
  );
}
