import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Segmented, Select, Switch } from 'antd';
import { api } from '../api';
import { meQuery, type Me, type UserPreferences } from '../lib/queries';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import { useToast } from '../lib/toast';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../lib/agentDefaults';

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
// default pre-fills the runner's new-agent form and persists per account.
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

      <Card title="Agent defaults">
        <Field label="Default permission mode" hint="The mode a new agent starts in.">
          <Select
            style={{ width: 200 }}
            value={defaultMode}
            options={MODE_OPTIONS}
            onChange={(v) => save.mutate({ defaultPermissionMode: v })}
            loading={save.isPending}
          />
        </Field>
      </Card>
    </div>
  );
}
