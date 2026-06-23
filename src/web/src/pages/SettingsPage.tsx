import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Card, Segmented, Select } from 'antd';
import { api } from '../api';
import { meQuery, type Me, type UserPreferences } from '../lib/queries';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import {
  MODEL_OPTIONS,
  MODE_OPTIONS,
  AUTO_CAPABLE_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
} from '../lib/agentDefaults';

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

// Personal preferences. Appearance is account-synced via the theme context; the
// "Agent defaults" pre-fill the runner's new-agent form and persist per account.
export function SettingsPage() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const { mode, setMode } = useThemeMode();
  const me = useQuery(meQuery());
  const prefs: UserPreferences = me.data?.preferences ?? {};

  const defaultModel = prefs.defaultModel ?? DEFAULT_MODEL;
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

  // Auto mode needs a recent model; if the chosen default model can't run Auto, drop
  // the default mode off Auto in the same patch (mirrors the new-agent form).
  const onModelChange = (m: string) => {
    const patch: UserPreferences = { defaultModel: m };
    if (defaultMode === 'auto' && !AUTO_CAPABLE_MODELS.has(m)) patch.defaultPermissionMode = 'default';
    save.mutate(patch);
  };

  const modeOptions = MODE_OPTIONS.filter(
    (o) => o.value !== 'auto' || AUTO_CAPABLE_MODELS.has(defaultModel),
  );

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

      <Card title="Agent defaults">
        <Field label="Default model" hint="Pre-selected when you create a new agent.">
          <Select
            style={{ width: 200 }}
            value={defaultModel}
            options={MODEL_OPTIONS}
            onChange={onModelChange}
            loading={save.isPending}
          />
        </Field>
        <Field label="Default permission mode" hint="The mode a new agent starts in.">
          <Select
            style={{ width: 200 }}
            value={defaultMode}
            options={modeOptions}
            onChange={(v) => save.mutate({ defaultPermissionMode: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>
    </div>
  );
}
