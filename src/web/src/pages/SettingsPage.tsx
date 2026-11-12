import { TRANSLATION_LANGUAGE_NAMES, TRANSLATION_LANGUAGES, type TranslationLanguage } from '@orbit/shared';
import { useEffect, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Segmented } from '../components/ui/Segmented';
import { Select } from '../components/ui/Select';
import { Switch } from '../components/ui/Switch';
import type { Runner } from '../components/TasksSidePanel';
import { isLoginPool } from '../lib/codexLogin';
import { routeId } from '../lib/idCodec';
import { providerPoolsQuery, type ProviderPool } from '../lib/providerPools';
import { meQuery, runnersQuery, storageUsageQuery, workspacesQuery, type Me, type StorageUsage, type UserPreferences } from '../lib/queries';
import { noCliSignedIn, type AttentionWorkspace } from '../lib/runnerAttention';
import { accountPoolList, poolAccessQuery, sharedPoolsQuery } from '../lib/sharedPools';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import { useToast } from '../lib/toast';
import { translationLanguageOf } from '../lib/translation';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../lib/workspaceDefaults';
import { formatFileSize } from '../lib/worktreeFile';
import { FEISHU_PLATFORM_NAMES, feishuIntegrationQuery } from './FeishuIntegrationPage';

// One labelled row: title + hint on the left, the control on the right.
function Field({ label, hint, children }: { label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 0',
      }}
    >
      <div>
        <div>{label}</div>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{hint}</div>
      </div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

/**
 * What the phone's Settings row for Machines & models says (SettingsHome.infrastructureValue in OrbitKit):
 * how many things on the page need a person — a machine offline, a machine online where no coding CLI is
 * signed in and nothing runs on a key instead (runnerAttention's noCliSignedIn, which its page says too),
 * an account pool no session can start on; an engine signed out beside one signed in is not one — or,
 * with none, how many of the machines are online.
 */
function machinesValue(
  runners: Runner[],
  pools: ProviderPool[],
  workspaces: ReadonlyArray<AttentionWorkspace & { runnerId?: string | null }>,
): { text: string; needsYou: boolean } {
  const online = runners.filter((runner) => runner.online);
  const runsNothing = online.filter((runner) =>
    noCliSignedIn(runner, workspaces.filter((workspace) => workspace.runnerId === runner.id)),
  );
  const needsYou =
    runners.length - online.length + runsNothing.length + pools.filter((pool) => pool.unavailable).length;
  if (needsYou > 0) return { text: needsYou === 1 ? '1 needs you' : `${needsYou} need you`, needsYou: true };
  return { text: runners.length === 0 ? 'None' : `${online.length} of ${runners.length} online`, needsYou: false };
}

/**
 * The way into Machines & models (docs/mocks/machines-and-models, 02), laid out as Sharing and Access tokens
 * are: what the page holds and the line it opens with on the left, Manage on the right — and under that
 * line what the phone's row says, once the machines, their workspaces and the pools have been read.
 */
function MachinesAndModels() {
  const navigate = useNavigate();
  const runners = useQuery(runnersQuery());
  const workspaces = useQuery(workspacesQuery());
  const pools = useQuery(providerPoolsQuery());
  const shared = useQuery(sharedPoolsQuery());
  const access = useQueries({ queries: (pools.data ?? []).filter(isLoginPool).map((pool) => poolAccessQuery(pool.id)) });
  const accessOf = new Map(access.flatMap((read) => (read.data ? [[routeId(read.data.id), read.data] as const] : [])));
  const value =
    runners.data && !workspaces.isPending && !pools.isPending && !shared.isPending
      ? machinesValue(
          runners.data as Runner[],
          accountPoolList(pools.data ?? [], shared.data ?? [], accessOf),
          workspaces.data ?? [],
        )
      : null;
  return (
    <Card title="Machines & models" style={{ marginBottom: 16 }}>
      <Field
        label="Machines, API keys and account pools"
        hint={
          <>
            Where your agents run, and whose model quota they spend.
            {value && (
              <div
                className="settings-machines-value"
                style={{ marginTop: 4, fontSize: 13, color: value.needsYou ? 'var(--warning)' : 'var(--text-2)' }}
              >
                {value.text}
              </div>
            )}
          </>
        }
      >
        <Button onClick={() => navigate('/infrastructure')}>Manage</Button>
      </Field>
    </Card>
  );
}

/** A week as its Monday reads, in the zone the server counted it in. */
function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A heading and the rows under it, each a name and a size. Nothing at all when there are no rows. */
function UsageRows({ title, rows }: { title: string; rows: { key: string; name: string; size: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ padding: '10px 0' }}>
      <div>{title}</div>
      {rows.map(({ key, name, size }) => (
        <div
          key={key}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ flex: 'none' }}>{size}</span>
        </div>
      ))}
    </div>
  );
}

/** How much a file count and a size come to, the quota beside the size where there is one. */
function storedValue({ totalBytes, fileCount, quotaBytes }: StorageUsage): string {
  const size = quotaBytes === null ? formatFileSize(totalBytes) : `${formatFileSize(totalBytes)} of ${formatFileSize(quotaBytes)}`;
  return `${size} · ${fileCount.toLocaleString('en-US')} ${fileCount === 1 ? 'file' : 'files'}`;
}

/** What this account keeps in Orbit Files: read when the page opens, and only here. */
function StorageCard() {
  const { data: usage, isError } = useQuery(storageUsageQuery());
  const full = usage && usage.quotaBytes !== null && usage.totalBytes >= usage.quotaBytes;
  return (
    <Card title="Storage" style={{ marginBottom: 16 }}>
      <Field
        label="Stored files"
        hint={
          <>
            Each file counts once, however many sessions use it. Files agents upload expire after 14 days unless evidence keeps them.
            {full && (
              <div className="settings-storage-full" style={{ marginTop: 4, fontSize: 13, color: 'var(--warning)' }}>
                Your storage is full, so new uploads are refused. Older uploads free up room as they expire.
              </div>
            )}
          </>
        }
      >
        <div className="settings-storage-value" style={{ color: 'var(--text-2)' }}>
          {usage ? storedValue(usage) : isError ? 'Could not read this' : '…'}
        </div>
      </Field>
      {usage && (
        <>
          <UsageRows
            title="Largest projects"
            rows={usage.projects.map(({ projectId, title, bytes }) => ({ key: projectId, name: title, size: formatFileSize(bytes) }))}
          />
          <UsageRows
            title="Largest tasks"
            rows={usage.tasks.map(({ taskId, title, bytes }) => ({ key: taskId, name: title, size: formatFileSize(bytes) }))}
          />
          <UsageRows
            title="Added each week"
            rows={[...usage.weeks].reverse().map(({ weekStart, bytes }) => ({
              key: weekStart,
              name: `Week of ${weekLabel(weekStart)}`,
              size: formatFileSize(bytes),
            }))}
          />
        </>
      )}
    </Card>
  );
}

/**
 * The way into the account's own Feishu or Lark app (docs/feishu-bot-design.md §4.1), laid out as Sharing and
 * Access tokens are, with what the page holds under its line: the app's platform and App ID, or that there is none.
 */
function IntegrationsCard() {
  const navigate = useNavigate();
  const { data } = useQuery(feishuIntegrationQuery());
  const value = !data
    ? null
    : !data.allowed
      ? { text: 'Turned off by an administrator', warn: true }
      : !data.app
        ? { text: 'Not connected', warn: false }
        : data.app.secretUnreadable
          ? { text: `${data.app.appId} needs its App Secret again`, warn: true }
          : { text: `${FEISHU_PLATFORM_NAMES[data.app.platform]} · ${data.app.appId}${data.app.enabled ? '' : ' · Off'}`, warn: false };
  return (
    <Card title="Integrations" style={{ marginTop: 16 }}>
      <Field
        label="Feishu"
        hint={
          <>
            A Feishu or Lark app of your own, connected to Orbit as its bot.
            {value && (
              <div
                className="settings-feishu-value"
                style={{ marginTop: 4, fontSize: 13, color: value.warn ? 'var(--warning)' : 'var(--text-2)' }}
              >
                {value.text}
              </div>
            )}
          </>
        }
      >
        <Button onClick={() => navigate('/settings/integrations/feishu')}>Manage</Button>
      </Field>
    </Card>
  );
}

const TRANSLATION_LANGUAGE_OPTIONS = TRANSLATION_LANGUAGES.map((value) => ({
  value,
  label: TRANSLATION_LANGUAGE_NAMES[value],
}));
const AGENT_LANGUAGE_OPTIONS = [{ value: 'en', label: 'English' }];

/**
 * Settings › Translation (docs/mocks/session-translation, frames 1 and 2): one account-wide switch,
 * absent = off, and the language the owner writes and reads in. Agents always work in English, so
 * that row is shown and not offered. A server without a DeepSeek key cannot translate: everything is
 * drawn disabled with frame 2's notice, whatever the preference says.
 */
function TranslationCard({
  me,
  prefs,
  save,
  saving,
}: {
  me: Me | undefined;
  prefs: UserPreferences;
  save: (patch: UserPreferences) => void;
  saving: boolean;
}) {
  const unavailable = me !== undefined && me.translationAvailable !== true;
  const language = translationLanguageOf(me);
  return (
    <div id="translation">
      <Card title="Translation" style={{ marginBottom: 16 }}>
        <Field
          label="Translate conversations"
          hint="Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
        >
          <Switch
            aria-label="Translate conversations"
            checked={!unavailable && prefs.translationEnabled === true}
            disabled={unavailable}
            onCheckedChange={(v) => save({ translationEnabled: v })}
            loading={saving}
          />
        </Field>
        {unavailable && (
          <div className="settings-translation-notice" role="note">
            This server has no DeepSeek key, so it can't translate. Whoever runs it sets <code>DEEPSEEK_API_KEY</code> and
            restarts it.
          </div>
        )}
        <Field label="Your language" hint="What you write in, and what replies are shown in.">
          <Select<TranslationLanguage>
            aria-label="Your language"
            style={{ width: 200 }}
            value={language}
            options={TRANSLATION_LANGUAGE_OPTIONS}
            disabled={unavailable}
            onValueChange={(v) => v !== null && save({ translationLanguage: v })}
            loading={saving}
          />
        </Field>
        <Field label="Agents work in" hint="What the agent receives and answers in.">
          <Select aria-label="Agents work in" style={{ width: 200 }} value="en" options={AGENT_LANGUAGE_OPTIONS} disabled onValueChange={() => {}} />
        </Field>
        <div style={{ paddingTop: 4, color: 'var(--text-3)', fontSize: 12 }}>
          Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a
          conversation stays as it was.
        </div>
      </Card>
    </div>
  );
}

// Personal preferences. Appearance is account-synced via the theme context; the permission
// default is what a new session starts in when the composer names no mode (it used to live per
// workspace — see common/permission-mode.ts for why the posture belongs to the run).
export function SettingsPage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { mode, setMode } = useThemeMode();
  const me = useQuery(meQuery());
  const prefs: UserPreferences = me.data?.preferences ?? {};

  const defaultMode = prefs.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;

  // The composer's translation tag opens Settings › Translation: bring the card into view.
  const { hash } = useLocation();
  const loaded = me.data !== undefined;
  useEffect(() => {
    if (hash === '#translation' && loaded) document.getElementById('translation')?.scrollIntoView?.({ block: 'start' });
  }, [hash, loaded]);

  const save = useMutation({
    mutationFn: (patch: UserPreferences) =>
      api<Me>('/users/me/preferences', { method: 'PATCH', body: patch }),
    onSuccess: (updated) => {
      qc.setQueryData(meQuery().queryKey, updated);
      message.success('Setting saved');
    },
    onError: (e: Error) => message.error("Couldn't save the setting", e.message),
  });

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="page-title">Settings</h1>

      {/* How sessions start, then where agents run, then the alerts and the look, then what the account
          has shared. The phones open with Machines & models instead, and keep the session cards on a page
          of their own (SettingsHome and SessionSettings in OrbitKit, docs/mocks/ios-settings-order). */}
      <Card title="Session defaults" style={{ marginBottom: 16 }}>
        <Field
          label="Default permission mode"
          hint="The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in."
        >
          <Select
            aria-label="Default permission mode"
            style={{ width: 200 }}
            value={defaultMode}
            options={MODE_OPTIONS}
            onValueChange={(v) => v !== null && save.mutate({ defaultPermissionMode: v })}
            loading={save.isPending}
          />
        </Field>
        {/* Absent means OFF, unlike the switches below — only turning it on has to be written. */}
        <Field
          label="Smart model selection"
          hint="Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model and effort. Off: tasks run exactly as before."
        >
          <Switch
            aria-label="Smart model selection"
            checked={prefs.modelRouting === true}
            onCheckedChange={(v) => save.mutate({ modelRouting: v })}
            loading={save.isPending}
          />
        </Field>
        {/* Absent means on, like the switches below. The engine reads it when it starts, so a
            session already running keeps what it started with. */}
        <Field
          label="Suggested replies"
          hint="When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account."
        >
          <Switch
            aria-label="Suggested replies"
            checked={prefs.promptSuggestions ?? true}
            onCheckedChange={(v) => save.mutate({ promptSuggestions: v })}
            loading={save.isPending}
          />
        </Field>
        {/* Absent means on, like the switch above. Read by every client's session list, so turning
            it off holds on the phone and the Mac too — it is one account-wide answer. */}
        <Field
          label="Session recaps"
          hint="Session lists show the one-line summary the server writes for each conversation, in place of its raw last reply, and the conversation ends with it. Off: the raw last reply, and no summary in the conversation."
        >
          <Switch
            aria-label="Session recaps"
            checked={prefs.recaps ?? true}
            onCheckedChange={(v) => save.mutate({ recaps: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>

      <TranslationCard me={me.data} prefs={prefs} save={(patch) => save.mutate(patch)} saving={save.isPending} />

      {/* One switch for the whole account, not one per workspace: the server reads it live on
          every claim, spawn and call, so turning it off takes the tools away everywhere at once.
          Absent means on — only turning it off is ever written. */}
      <Card title="Session orchestration" style={{ marginBottom: 16 }}>
        <Field
          label="Let sessions orchestrate"
          hint="Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused."
        >
          <Switch
            aria-label="Let sessions orchestrate"
            checked={prefs.enableOrchestration ?? true}
            onCheckedChange={(v) => save.mutate({ enableOrchestration: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>
      <MachinesAndModels />
      <Card title="Notifications" style={{ marginBottom: 16 }}>
        <Field
          label="When a session finishes"
          hint="Alert your devices when a run finishes on its own or fails for good."
        >
          <Switch
            aria-label="When a session finishes"
            checked={prefs.notifySessionFinished ?? true}
            onCheckedChange={(v) => save.mutate({ notifySessionFinished: v })}
            loading={save.isPending}
          />
        </Field>
        <Field
          label="When an agent asks for you"
          hint="Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute."
        >
          <Switch
            aria-label="When an agent asks for you"
            checked={prefs.notifyAgentMessage ?? true}
            onCheckedChange={(v) => save.mutate({ notifyAgentMessage: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>

      <Card title="Appearance" style={{ marginBottom: 16 }}>
        <Field label="Theme" hint="Synced to your account across devices.">
          <Segmented<ThemeMode>
            aria-label="Theme"
            value={mode}
            onValueChange={setMode}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
        </Field>
      </Card>

      <StorageCard />

      <Card title="Sharing">
        <Field
          label="Shared links"
          hint="Everything you’ve made viewable by link: what each one includes, how often it was opened, and a way to turn it off."
        >
          <Button onClick={() => navigate('/settings/shared-links')}>Manage</Button>
        </Field>
      </Card>

      <Card title="Access tokens" style={{ marginTop: 16 }}>
        <Field
          label="Personal access tokens"
          hint="Let scripts and the orbit CLI use the Orbit API as you: what each token can reach, when it was last used, and a way to revoke it."
        >
          <Button onClick={() => navigate('/settings/access-tokens')}>Manage</Button>
        </Field>
      </Card>

      <IntegrationsCard />

    </div>
  );
}
