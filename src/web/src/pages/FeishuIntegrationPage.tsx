import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import {
  FEISHU_APP_CALLBACKS,
  FEISHU_APP_EVENTS,
  FEISHU_APP_SCOPES,
  FEISHU_OPEN_PLATFORM_ORIGINS,
  FEISHU_PLATFORMS,
  type FeishuAppChange,
  type FeishuAppConnect,
  type FeishuAppSettings,
  type FeishuChatChange,
  type FeishuChatRoute,
  type FeishuConnectCode,
  type FeishuIntegration,
  type FeishuPlatform,
  type FeishuTestMessageResult,
} from '@orbit/shared';
import { api } from '../api';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button, LinkButton } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Popconfirm } from '../components/ui/Popconfirm';
import { Radio, RadioGroup } from '../components/ui/Radio';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import '../components/ui/Card.css';
import { SettingsHeader } from '../components/settings';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import { workspacesQuery } from '../lib/queries';
import { feishuChatsQuery, modeLabel } from './FeishuConnectGroupPage';

/** `GET /integrations/feishu` (docs/feishu-bot-design.md §4.1, §10): never the App Secret, only whether one is saved and readable. */
export const feishuIntegrationQuery = () =>
  queryOptions({
    queryKey: ['integrations', 'feishu'] as const,
    queryFn: () => api<FeishuIntegration>('/integrations/feishu'),
  });

export const FEISHU_PLATFORM_NAMES: Readonly<Record<FeishuPlatform, string>> = { FEISHU: 'Feishu', LARK: 'Lark' };

/** The open platform's host, as each platform's choice names it. */
const hostOf = (platform: FeishuPlatform) => new URL(FEISHU_OPEN_PLATFORM_ORIGINS[platform]).host;

/** Where a platform's apps are made: its developer console. */
const consoleOf = (platform: FeishuPlatform) => `${FEISHU_OPEN_PLATFORM_ORIGINS[platform]}/app`;

/** What each permission the app needs lets it do (§4.2), in the order the steps list them. */
export const FEISHU_SCOPE_PURPOSES: Readonly<Record<(typeof FEISHU_APP_SCOPES)[number], string>> = {
  'im:message:send_as_bot': 'Send messages as the app',
  'im:message.p2p_msg:readonly': 'Read the direct messages people send the bot',
  'im:message.group_at_msg:readonly': 'Read group messages that @mention the bot',
  'im:chat:readonly': 'Read group information',
  'contact:user.base:readonly': "Read people's basic information, to show their names",
};

/** §6.4: what the detail switch says, off (the default) and on. Feishu keeps whatever a card carries. */
export const MESSAGE_DETAIL_HINT =
  "Off by default: alerts carry only the session or project title, the kind of event and a tool's name. "
  + "On, they also carry tool inputs, recaps, failure reasons, the agent's messages and questions, and owner item text, "
  + "and all of it is stored on Feishu's servers.";

/** §7.2, decision 1: what the approvals switch says. "Always allow" stays in Orbit either way. */
export const APPROVALS_IN_FEISHU_HINT =
  "On, a tool approval's card has Allow once and Deny, answered by you only. "
  + '"Always allow", questions, and Orbit\'s own confirmation cards are answered in Orbit. Off, cards only open Orbit.';

/** §7.3: what the default workspace is for. */
export const DEFAULT_WORKSPACE_HINT =
  'A new direct message to the bot starts a session here. With none chosen, the bot asks you to choose one in Feishu.';

export const NOT_ALLOWED_NOTICE = 'An administrator has turned off Feishu bots on this Orbit server.';
/** Said when the saved secret no longer decrypts (§4.1): the app stays, but Orbit cannot act as it until the secret is entered again. */
export const SECRET_UNREADABLE_NOTICE =
  'The saved App Secret can no longer be decrypted, usually because PROVIDER_SECRET_KEY changed on this server. '
  + 'Orbit cannot reach Feishu as this app until you enter the App Secret again.';
/** §3.2: an app's events go to one of its long connections at random, so it serves one consumer. */
export const ONE_CONSUMER_NOTE =
  "Use this app for Orbit alone. Feishu hands each of an app's events to one of its long connections at random, "
  + 'so another tool or another Orbit server connected to the same app would take some of them.';

/** A name to type into the developer console exactly as written, with a button that copies it. */
function CopyName({ name, onCopy }: { name: string; onCopy: (name: string) => void }) {
  return (
    <span className="feishu-copy">
      <code>{name}</code>
      <Button size="small" aria-label={`Copy ${name}`} onClick={() => onCopy(name)}>
        Copy
      </Button>
    </span>
  );
}

/** How many Orbit servers hold the app's long connection now (§4.4): each server connects every app on its own. */
export function connectionText(app: FeishuAppSettings): string {
  if (!app.enabled) return 'Off';
  if (app.connectedReplicas === 0) return 'Not connected';
  return app.connectedReplicas === 1 ? 'Connected on 1 Orbit server' : `Connected on ${app.connectedReplicas} Orbit servers`;
}

/** The app as it stands: its platform and App ID, whether its secret is saved, its switch, and its removal. */
function AppSummary({
  app, allowed, onReplace,
}: { app: FeishuAppSettings; allowed: boolean; onReplace: () => void }) {
  const qc = useQueryClient();
  const message = useToast();
  const switchId = useId();
  const detailId = useId();
  const approvalsId = useId();
  const workspaceId = useId();
  const workspaces = useQuery(workspacesQuery());
  const change = useMutation({
    mutationFn: (body: FeishuAppChange) => api<FeishuIntegration>('/integrations/feishu', { method: 'PATCH', body }),
    onSuccess: (integration) => qc.setQueryData(feishuIntegrationQuery().queryKey, integration),
    onError: (e: Error) => message.error("Couldn't change the app", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api<FeishuIntegration>('/integrations/feishu', { method: 'DELETE' }),
    onSuccess: (integration) => {
      qc.setQueryData(feishuIntegrationQuery().queryKey, integration);
      message.success('Feishu app removed');
    },
    onError: (e: Error) => message.error("Couldn't remove the app", e.message),
  });
  const badge = app.secretUnreadable
    ? <Badge tone="warning">Needs its App Secret</Badge>
    : !app.enabled
      ? <Badge>Off</Badge>
      : <Badge tone="success">Saved</Badge>;
  return (
    <section className="orbit-card feishu-card" aria-label="Your app">
      <div className="orbit-card-head">
        <h2 className="orbit-card-title">Your app</h2>
        {badge}
      </div>
      <div className="orbit-card-body feishu-fields">
        {app.secretUnreadable && <div className="admin-signin-warning" role="alert">{SECRET_UNREADABLE_NOTICE}</div>}
        {app.lastError && (
          <Alert type="error" title="Feishu reported a problem with this app" description={app.lastError} />
        )}
        <dl className="feishu-facts">
          <dt>Platform</dt>
          <dd>
            {FEISHU_PLATFORM_NAMES[app.platform]} <span className="feishu-hint">({hostOf(app.platform)})</span>
          </dd>
          <dt>App ID</dt>
          <dd>
            <code className="feishu-app-id">{app.appId}</code>
          </dd>
          <dt>App Secret</dt>
          <dd className="feishu-hint">
            {app.secretUnreadable ? 'Saved, but no longer readable' : 'Saved. It is never shown again.'}
          </dd>
          <dt>Connection</dt>
          <dd>{connectionText(app)}</dd>
          {app.botName && (
            <>
              <dt>Bot</dt>
              <dd>{app.botName}</dd>
            </>
          )}
          <dt>Last event</dt>
          <dd className="feishu-hint">{app.lastEventAt ? new Date(app.lastEventAt).toLocaleString() : 'None received yet'}</dd>
        </dl>
        <div className="admin-signin-row">
          <div>
            <div className="admin-signin-label" id={switchId}>
              Use this app
            </div>
            <div className="admin-signin-hint">Off, Orbit keeps the app but neither connects it nor sends anything through it.</div>
          </div>
          <Switch
            aria-labelledby={switchId}
            checked={app.enabled}
            loading={change.isPending && change.variables?.enabled !== undefined}
            onCheckedChange={(enabled) => change.mutate({ enabled })}
          />
        </div>
        <div className="admin-signin-row">
          <div>
            <div className="admin-signin-label" id={detailId}>
              Include details in alerts
            </div>
            <div className="admin-signin-hint">{MESSAGE_DETAIL_HINT}</div>
          </div>
          <Switch
            aria-labelledby={detailId}
            checked={app.messageDetail === 'FULL'}
            loading={change.isPending && change.variables?.messageDetail !== undefined}
            onCheckedChange={(on) => change.mutate({ messageDetail: on ? 'FULL' : 'TITLES_ONLY' })}
          />
        </div>
        <div className="admin-signin-row">
          <div>
            <div className="admin-signin-label" id={approvalsId}>
              Answer approvals in Feishu
            </div>
            <div className="admin-signin-hint">{APPROVALS_IN_FEISHU_HINT}</div>
          </div>
          <Switch
            aria-labelledby={approvalsId}
            checked={app.approvalsInFeishu}
            loading={change.isPending && change.variables?.approvalsInFeishu !== undefined}
            onCheckedChange={(approvalsInFeishu) => change.mutate({ approvalsInFeishu })}
          />
        </div>
        <div className="admin-signin-row">
          <div>
            <div className="admin-signin-label" id={workspaceId}>
              Default workspace
            </div>
            <div className="admin-signin-hint">{DEFAULT_WORKSPACE_HINT}</div>
          </div>
          <Select
            aria-labelledby={workspaceId}
            style={{ minWidth: 200 }}
            placeholder="None"
            clearable
            clearLabel="No default workspace"
            loading={workspaces.isPending || (change.isPending && change.variables?.defaultWorkspaceId !== undefined)}
            value={app.defaultWorkspaceId}
            onValueChange={(defaultWorkspaceId) => change.mutate({ defaultWorkspaceId })}
            options={(workspaces.data ?? []).map((w: { id: string; name: string }) => ({ value: w.id, label: w.name }))}
          />
        </div>
        <div className="feishu-actions">
          <Button onClick={onReplace} disabled={!allowed}>
            Replace credentials
          </Button>
          <Popconfirm
            title="Remove this Feishu app from Orbit?"
            description="Orbit forgets its App ID and App Secret. The app itself stays in your Feishu developer console."
            confirmText="Remove app"
            danger
            onConfirm={() => remove.mutateAsync()}
            trigger={
              <Button danger loading={remove.isPending}>
                Remove app
              </Button>
            }
          />
        </div>
      </div>
    </section>
  );
}

export const CONNECT_ACCOUNT = 'Connect your Feishu account';
export const OPEN_BOT = 'Open the bot in Feishu';
export const SEND_TEST = 'Send me a test message';
export const DISCONNECT_OWNER = 'Disconnect';
/** §5.1: what the owner's identity is for, and who can take it. */
export const OWNER_HINT =
  'Orbit sends your alerts to this Feishu account, and only takes direct messages and card answers from it. '
  + 'Whoever sends the bot a code you generate here becomes the owner, so keep the code to yourself.';

/**
 * Who the app's owner is (docs/feishu-bot-design.md §5): the Feishu account Orbit sends alerts to. Connect your Feishu
 * account generates a one-time code (8 characters, 10 minutes) to send the bot in a direct message; while one is shown,
 * the page reads the app again every few seconds, so the owner's name appears as soon as the bot has the code.
 * Disconnect clears it; the app stays connected. Send me a test message checks the whole way to the owner's chat.
 */
function OwnerSection({ app }: { app: FeishuAppSettings }) {
  const qc = useQueryClient();
  const message = useToast();
  const [code, setCode] = useState<FeishuConnectCode | null>(null);
  const owner = app.ownerOpenId;
  // The code was answered while someone else, or nobody, was the owner: a new owner means it was used.
  const [ownerAtCode, setOwnerAtCode] = useState<string | null>(null);
  const waiting = code !== null && owner === ownerAtCode && Date.parse(code.expiresAt) > Date.now();
  useQuery({ ...feishuIntegrationQuery(), refetchInterval: waiting ? 3_000 : false, enabled: waiting });
  const shown = code !== null && owner === ownerAtCode ? code : null;
  const generate = useMutation({
    mutationFn: () => api<FeishuConnectCode>('/integrations/feishu/connect-codes', { method: 'POST' }),
    onSuccess: (answer) => {
      setOwnerAtCode(owner);
      setCode(answer);
    },
    onError: (e: Error) => message.error("Couldn't generate a code", e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api<FeishuIntegration>('/integrations/feishu/owner', { method: 'DELETE' }),
    onSuccess: (integration) => {
      qc.setQueryData(feishuIntegrationQuery().queryKey, integration);
      setCode(null);
      message.success('Feishu account disconnected', 'Orbit stops sending alerts to Feishu until you connect an account again.');
    },
    onError: (e: Error) => message.error("Couldn't disconnect", e.message),
  });
  const test = useMutation({
    mutationFn: () => api<FeishuTestMessageResult>('/integrations/feishu/test', { method: 'POST' }),
    onSuccess: () => message.success('Test message sent', 'Look for it in your direct messages with the bot.'),
    onError: (e: Error) => message.error("Couldn't send the test message", e.message),
  });
  const copy = async (text: string) => {
    if (await copyText(text)) message.success('Code copied');
    else message.error("Couldn't copy the code", 'Select it and copy it by hand.');
  };
  return (
    <section className="orbit-card feishu-card" aria-label="Your Feishu account">
      <div className="orbit-card-head">
        <h2 className="orbit-card-title">Your Feishu account</h2>
        {owner ? <Badge tone="success">Connected</Badge> : <Badge>Not connected</Badge>}
      </div>
      <div className="orbit-card-body feishu-fields">
        <p className="feishu-owner-state">
          {owner ? (
            <>
              Connected as <strong className="feishu-owner-name">{app.ownerName ?? 'a Feishu user whose name Orbit could not read'}</strong>.
            </>
          ) : (
            'No Feishu account is connected yet, so Orbit has nobody to send alerts to.'
          )}
        </p>
        <p className="feishu-hint">{OWNER_HINT}</p>
        {shown && (
          <div className="feishu-code" aria-label="Your code">
            <div className="feishu-code-row">
              <code className="feishu-code-value">{shown.code}</code>
              <Button size="small" onClick={() => void copy(shown.code)}>
                Copy
              </Button>
            </div>
            <p className="feishu-hint">
              Send this code to the bot in a direct message, not in a group. It works once, until{' '}
              {new Date(shown.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            </p>
            <div>
              <LinkButton variant="primary" href={shown.applink} target="_blank" rel="noreferrer">
                {OPEN_BOT}
              </LinkButton>
            </div>
          </div>
        )}
        <div className="feishu-actions">
          {owner && (
            <Popconfirm
              title="Disconnect your Feishu account?"
              description="Orbit stops sending alerts to Feishu. The app stays connected, and you can connect an account again with a new code."
              confirmText={DISCONNECT_OWNER}
              danger
              onConfirm={() => disconnect.mutateAsync()}
              trigger={
                <Button danger loading={disconnect.isPending}>
                  {DISCONNECT_OWNER}
                </Button>
              }
            />
          )}
          <Button disabled={!owner} loading={test.isPending} title={owner ? undefined : 'Connect your Feishu account first'} onClick={() => test.mutate()}>
            {SEND_TEST}
          </Button>
          <Button variant={owner ? 'default' : 'primary'} loading={generate.isPending} onClick={() => generate.mutate()}>
            {owner ? (shown ? 'Generate another code' : 'Connect a different account') : shown ? 'Generate another code' : CONNECT_ACCOUNT}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Why a connected group is off, in a sentence. */
const OFF_REASON: Readonly<Record<string, string>> = {
  BOT_REMOVED: 'The bot was removed from the group. Add it back and send "@bot connect" there to connect it again.',
  OWNER: 'Switched off: mentions in the group start nothing.',
};

/** One connected group: where its sessions open and how, with its switch and its removal. */
function GroupRow({ route, workspaceName }: { route: FeishuChatRoute; workspaceName: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const switchId = useId();
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations', 'feishu', 'chats'] });
  const change = useMutation({
    mutationFn: (body: FeishuChatChange) => api<FeishuChatRoute>(`/integrations/feishu/chats/${route.id}`, { method: 'PATCH', body }),
    onSuccess: () => void refresh(),
    onError: (e: Error) => message.error("Couldn't change the group", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api<{ removed: true }>(`/integrations/feishu/chats/${route.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void refresh();
      message.success('Group removed');
    },
    onError: (e: Error) => message.error("Couldn't remove the group", e.message),
  });
  const name = route.chatName ?? 'Unnamed group';
  const who = route.allowedOpenIds.length === 0
    ? 'Everyone in the group'
    : `${route.allowedOpenIds.length} ${route.allowedOpenIds.length === 1 ? 'person' : 'people'} and you`;
  return (
    <li className="feishu-group" aria-label={name}>
      <div className="admin-signin-row">
        <div>
          <div className="admin-signin-label" id={switchId}>
            {name}
          </div>
          <div className="admin-signin-hint">
            {workspaceName} · {modeLabel(route.permissionMode)} mode · {who} · up to {route.maxConcurrentSessions} at a time,{' '}
            {route.sessionsPerDay} a day
          </div>
          {!route.enabled && route.disabledReason && <div className="admin-signin-hint">{OFF_REASON[route.disabledReason]}</div>}
        </div>
        <div className="feishu-group-actions">
          <Switch
            aria-labelledby={switchId}
            checked={route.enabled}
            disabled={!route.enabled && route.disabledReason === 'BOT_REMOVED'}
            loading={change.isPending}
            onCheckedChange={(enabled) => change.mutate({ enabled })}
          />
          <Popconfirm
            title={`Remove ${name} from Orbit?`}
            description="Mentions in the group start nothing until it is connected again. Sessions it already started stay."
            confirmText="Remove group"
            danger
            onConfirm={() => remove.mutateAsync()}
            trigger={
              <Button size="small" danger loading={remove.isPending}>
                Remove
              </Button>
            }
          />
        </div>
      </div>
    </li>
  );
}

/** §8.1: the groups connected to Orbit. A group is connected from Feishu — the owner sends `@bot connect` in it. */
function GroupsSection() {
  const chats = useQuery(feishuChatsQuery());
  const workspaces = useQuery(workspacesQuery());
  const nameOf = (id: string) => ((workspaces.data ?? []) as Array<{ id: string; name: string }>).find((w) => w.id === id)?.name ?? 'A workspace';
  return (
    <section className="orbit-card feishu-card" aria-label="Groups">
      <div className="orbit-card-head">
        <h2 className="orbit-card-title">Groups</h2>
      </div>
      <div className="orbit-card-body feishu-fields">
        <p className="feishu-hint">
          To connect a group, add the bot to it and send &quot;@bot connect&quot; there. The bot answers with a link to
          choose the workspace, the permission mode and who can start sessions. Only groups inside your organization can be
          connected.
        </p>
        {chats.isPending && <Spinner />}
        {chats.isError && <Alert type="error" title="Couldn't load the groups" description={chats.error.message} />}
        {chats.isSuccess && chats.data.routes.length === 0 && <p className="feishu-hint">No groups are connected.</p>}
        {chats.isSuccess && chats.data.routes.length > 0 && (
          <ul className="feishu-groups">
            {chats.data.routes.map((route) => (
              <GroupRow key={route.id} route={route} workspaceName={nameOf(route.workspaceId)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The App ID and App Secret form: a new app, or new credentials for the one connected. Feishu checks them before anything is saved. */
function CredentialsForm({
  app, allowed, onDone,
}: { app: FeishuAppSettings | null; allowed: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const message = useToast();
  const [platform, setPlatform] = useState<FeishuPlatform>(app?.platform ?? 'FEISHU');
  const [appId, setAppId] = useState(app?.appId ?? '');
  const [secret, setSecret] = useState('');
  const ids = { title: useId(), platform: useId(), appId: useId(), secret: useId() };
  const save = useMutation({
    mutationFn: (body: FeishuAppConnect) => api<FeishuIntegration>('/integrations/feishu', { method: 'PUT', body }),
    onSuccess: (integration) => {
      qc.setQueryData(feishuIntegrationQuery().queryKey, integration);
      setSecret('');
      message.success('Feishu app saved', 'Feishu accepted the App ID and App Secret.');
      onDone?.();
    },
  });
  const edit = (apply: () => void) => {
    apply();
    if (save.isError) save.reset();
  };
  const ready = allowed && appId.trim() !== '' && secret.trim() !== '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || save.isPending) return;
    save.mutate({ platform, appId: appId.trim(), appSecret: secret.trim() });
  };
  return (
    <form className="orbit-card feishu-card" onSubmit={submit} aria-labelledby={ids.title}>
      <div className="orbit-card-head">
        <h2 className="orbit-card-title" id={ids.title}>
          {app ? 'Replace credentials' : 'Connect your app'}
        </h2>
      </div>
      <div className="orbit-card-body feishu-fields">
        <div className="admin-signin-field">
          <div className="admin-signin-label" id={ids.platform}>
            Platform
          </div>
          <RadioGroup<FeishuPlatform>
            aria-labelledby={ids.platform}
            className="feishu-platforms"
            value={platform}
            disabled={!allowed}
            onValueChange={(value) => edit(() => setPlatform(value))}
          >
            {FEISHU_PLATFORMS.map((value) => (
              <Radio key={value} value={value}>
                <span className="admin-signin-choice">{FEISHU_PLATFORM_NAMES[value]}</span>
                <span className="admin-signin-hint">{hostOf(value)}</span>
              </Radio>
            ))}
          </RadioGroup>
        </div>
        <div className="admin-signin-field">
          <label className="admin-signin-label" htmlFor={ids.appId}>
            App ID
          </label>
          <Input
            id={ids.appId}
            value={appId}
            placeholder="cli_a1b2c3d4e5f6g7h8"
            autoComplete="off"
            spellCheck={false}
            disabled={!allowed}
            onChange={(e) => edit(() => setAppId(e.target.value))}
          />
        </div>
        <div className="admin-signin-field">
          <label className="admin-signin-label" htmlFor={ids.secret}>
            App Secret
          </label>
          <Input
            id={ids.secret}
            type="password"
            value={secret}
            placeholder={app ? 'Enter the App Secret again' : 'Paste the App Secret'}
            autoComplete="new-password"
            spellCheck={false}
            disabled={!allowed}
            onChange={(e) => edit(() => setSecret(e.target.value))}
          />
          <div className="admin-signin-hint">
            Orbit asks Feishu whether these credentials work before saving them, keeps the secret encrypted, and never shows it again.
          </div>
        </div>
        {save.isError && (
          <Alert type="error" title="Couldn't save the app" description={save.error.message} className="feishu-save-error" />
        )}
        <div className="feishu-actions">
          {onDone && (
            <Button onClick={onDone} disabled={save.isPending}>
              Cancel
            </Button>
          )}
          <Button variant="primary" type="submit" disabled={!ready} loading={save.isPending}>
            {app ? 'Save' : 'Connect'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** §4.2: what to do in Feishu's developer console, in the order that works. */
function SetupSteps() {
  const message = useToast();
  const copy = async (name: string) => {
    if (await copyText(name)) message.success(`Copied ${name}`);
    else message.error(`Couldn't copy ${name}`, 'Select it and copy it by hand.');
  };
  return (
    <section className="orbit-card feishu-card" aria-label="Set up the app in Feishu">
      <div className="orbit-card-head">
        <h2 className="orbit-card-title">Set up the app in Feishu</h2>
      </div>
      <div className="orbit-card-body">
        <ol className="feishu-steps">
          <li>
            <div className="admin-signin-label">Create a custom app</div>
            <p>
              In the developer console of{' '}
              <a href={consoleOf('FEISHU')} target="_blank" rel="noreferrer">
                Feishu
              </a>{' '}
              or{' '}
              <a href={consoleOf('LARK')} target="_blank" rel="noreferrer">
                Lark
              </a>
              , create a custom app for your organization and add the Bot feature to it. In a company workspace,
              publishing an app usually needs an administrator&apos;s approval.
            </p>
          </li>
          <li>
            <div className="admin-signin-label">Grant it these permissions</div>
            <ul className="feishu-names">
              {FEISHU_APP_SCOPES.map((scope) => (
                <li key={scope}>
                  <CopyName name={scope} onCopy={(n) => void copy(n)} />
                  <span className="feishu-hint">{FEISHU_SCOPE_PURPOSES[scope]}</span>
                </li>
              ))}
            </ul>
            <p className="feishu-hint">
              Don&apos;t grant reading every message in a group: only messages that @mention the bot reach Orbit.
            </p>
          </li>
          <li>
            <div className="admin-signin-label">Enter its App ID and App Secret in Orbit first</div>
            <p>
              Copy them from the app&apos;s credentials page into the form on this page and save, then wait until Orbit
              shows the app as connected.
            </p>
          </li>
          <li>
            <div className="admin-signin-label">Switch to the long connection</div>
            <p>
              Back in the console, set both events and callbacks to be received through the long connection
              (persistent connection), then subscribe to these events:
            </p>
            <ul className="feishu-names">
              {FEISHU_APP_EVENTS.map((event) => (
                <li key={event}>
                  <CopyName name={event} onCopy={(n) => void copy(n)} />
                </li>
              ))}
            </ul>
            <p>and to this callback:</p>
            <ul className="feishu-names">
              {FEISHU_APP_CALLBACKS.map((callback) => (
                <li key={callback}>
                  <CopyName name={callback} onCopy={(n) => void copy(n)} />
                </li>
              ))}
            </ul>
            <p className="feishu-hint">
              The console only saves the long connection once Orbit is connected to the app, which is why the
              credentials go into Orbit first.
            </p>
          </li>
          <li>
            <div className="admin-signin-label">Publish it</div>
            <p>
              Set who can use the app (at least you, and the members of any group you will use it in) and publish a
              version.
            </p>
          </li>
        </ol>
        <p className="feishu-hint">{ONE_CONSUMER_NOTE}</p>
      </div>
    </section>
  );
}

/**
 * Settings → Integrations → Feishu (docs/feishu-bot-design.md §4.1, §4.2): the account's own Feishu or Lark app.
 * The App Secret goes in and never comes back: Orbit saves it only once Feishu has traded the pair for a token, and
 * a refusal shows Feishu's own reason. Below the app, the steps in Feishu's developer console, in the order that works:
 * the console accepts the long connection only once Orbit holds the credentials.
 */
export function FeishuIntegrationPage() {
  const integration = useQuery(feishuIntegrationQuery());
  const [replacing, setReplacing] = useState(false);

  if (integration.isPending) {
    return (
      <div className="settings-page feishu-page">
        <Spinner />
      </div>
    );
  }
  if (integration.isError) {
    return (
      <div className="settings-page feishu-page">
        <SettingsHeader title="Feishu" />
        <Alert
          type="error"
          title="Couldn't load your Feishu settings"
          description={integration.error.message}
          action={<Button size="small" onClick={() => void integration.refetch()}>Retry</Button>}
        />
      </div>
    );
  }
  const { allowed, app } = integration.data;
  return (
    <div className="settings-page feishu-page">
      <SettingsHeader
        title="Feishu"
        description="Connect a Feishu or Lark app of your own to Orbit as its bot. Orbit reaches Feishu over a long connection it opens itself, so this server needs no public address."
      />
      {!allowed && (
        <Alert
          type="warning"
          title={NOT_ALLOWED_NOTICE}
          description={app ? 'Your app stays saved, but Orbit does not connect it.' : 'You can connect an app once it is turned back on.'}
          className="feishu-not-allowed"
        />
      )}
      {app && <AppSummary app={app} allowed={allowed} onReplace={() => setReplacing(true)} />}
      {app && allowed && <OwnerSection app={app} />}
      {app && allowed && <GroupsSection />}
      {(!app || replacing) && (
        <CredentialsForm key={app ? `${app.platform}:${app.appId}` : 'new'} app={app} allowed={allowed} onDone={app ? () => setReplacing(false) : undefined} />
      )}
      <SetupSteps />
    </div>
  );
}
