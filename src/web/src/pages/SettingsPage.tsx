import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Segmented, Select, Switch } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { meQuery, type Me, type UserPreferences } from '../lib/queries';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import { useToast } from '../lib/toast';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../lib/workspaceDefaults';

// One labelled row: title + hint on the left, the control on the right.
function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
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

  const save = useMutation({
    mutationFn: (patch: UserPreferences) =>
      api<Me>('/users/me/preferences', { method: 'PATCH', body: patch }),
    onSuccess: (updated) => {
      qc.setQueryData(meQuery().queryKey, updated);
      message.success('Saved');
    },
    onError: (e: Error) => message.error(e.message || 'Failed to save'),
  });

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="page-title">Settings</h1>

      {/* The same order as Settings on iOS: how sessions start, then the alerts and the look, then
          what the account has shared. iOS lays these out as one list (SettingsHome in OrbitKit). */}
      <Card title="Session defaults" style={{ marginBottom: 16 }}>
        <Field
          label="Default permission mode"
          hint="The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in."
        >
          <Select
            style={{ width: 200 }}
            value={defaultMode}
            options={MODE_OPTIONS}
            onChange={(v) => save.mutate({ defaultPermissionMode: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>

      {/* One switch for the whole account, not one per workspace: the server reads it live on
          every claim, spawn and call, so turning it off takes the tools away everywhere at once.
          Absent means on — only turning it off is ever written. */}
      <Card title="Session orchestration" style={{ marginBottom: 16 }}>
        <Field
          label="Let sessions orchestrate"
          hint="Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused."
        >
          <Switch
            checked={prefs.enableOrchestration ?? true}
            onChange={(v) => save.mutate({ enableOrchestration: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>
      <Card title="Notifications" style={{ marginBottom: 16 }}>
        <Field
          label="When a session finishes"
          hint="Alert your devices when a run finishes on its own or fails for good."
        >
          <Switch
            checked={prefs.notifySessionFinished ?? true}
            onChange={(v) => save.mutate({ notifySessionFinished: v })}
            loading={save.isPending}
          />
        </Field>
        <Field
          label="When an agent asks for you"
          hint="Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute."
        >
          <Switch
            checked={prefs.notifyAgentMessage ?? true}
            onChange={(v) => save.mutate({ notifyAgentMessage: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>

      <Card title="Appearance" style={{ marginBottom: 16 }}>
        <Field label="Theme" hint="Synced to your account across devices.">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as ThemeMode)}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
        </Field>
      </Card>

      <Card title="Sharing">
        <Field
          label="Shared links"
          hint="Everything you’ve made viewable by link: what each one includes, how often it was opened, and a way to turn it off."
        >
          <Button onClick={() => navigate('/settings/shared-links')}>Manage</Button>
        </Field>
      </Card>

    </div>
  );
}
