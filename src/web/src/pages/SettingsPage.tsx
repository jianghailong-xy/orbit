import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Popconfirm, Segmented, Select, Space, Switch } from 'antd';
import { api } from '../api';
import { meQuery, workspacesQuery, type Me, type UserPreferences } from '../lib/queries';
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

  // Counted, not guessed: the account default only governs agents made from now on, so the one
  // thing this page has to answer honestly is how many existing agents actually hold the grant.
  const workspaces = useQuery(workspacesQuery());
  const agents: { enableOrchestration?: boolean }[] = workspaces.data ?? [];
  const orchestrating = agents.filter((a) => a.enableOrchestration).length;

  // Writes every agent's own switch in one call. Deliberately not a master switch: each agent
  // keeps its own grant afterwards, so one can still be revoked without disarming the rest.
  const applyToAll = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ updated: number }>('/workspaces/orchestration', { method: 'POST', body: { enabled } }),
    onSuccess: (r, enabled) => {
      void qc.invalidateQueries({ queryKey: workspacesQuery().queryKey });
      message.success(
        `${enabled ? 'Enabled' : 'Disabled'} on ${r.updated} agent${r.updated === 1 ? '' : 's'}.`,
      );
    },
    onError: (e: Error) => message.error(e.message || 'Failed to apply'),
  });

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="page-title">Settings</h1>

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
      </Card>

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

      {/* Orchestration is granted per agent — the authorizer reads that agent's own switch on
          every claim and every spawn, so it stays revocable one agent at a time. What lives here
          is the paperwork: a default for agents you make next, and a way to set them all at once
          instead of opening every agent's editor in turn. */}
      <Card title="Session orchestration">
        <Field
          label="Grant it to new agents"
          hint="An agent you create from now on starts able to spawn and manage other sessions via the orbit MCP session tools. Existing agents are untouched."
        >
          <Switch
            checked={prefs.defaultEnableOrchestration ?? false}
            onChange={(v) => save.mutate({ defaultEnableOrchestration: v })}
            loading={save.isPending}
          />
        </Field>
        <Field
          label="Apply to existing agents"
          hint={
            workspaces.isLoading
              ? 'Loading your agents…'
              : `${orchestrating} of ${agents.length} can orchestrate now. Each keeps its own switch afterwards.`
          }
        >
          <Space>
            <Popconfirm
              title={`Let all ${agents.length} agents orchestrate?`}
              description="Every agent's sessions will be able to spawn and drive other sessions. Grant this only if you trust what each of them runs."
              okText="Turn on for all"
              onConfirm={() => applyToAll.mutate(true)}
            >
              <Button disabled={agents.length === 0} loading={applyToAll.isPending}>
                Turn on for all
              </Button>
            </Popconfirm>
            {/* No confirm on the way out: this is the account's kill switch, and a switch you
                have to argue with is one you cannot reach in a hurry. */}
            <Button
              danger
              disabled={orchestrating === 0}
              loading={applyToAll.isPending}
              onClick={() => applyToAll.mutate(false)}
            >
              Turn off for all
            </Button>
          </Space>
        </Field>
      </Card>
    </div>
  );
}
