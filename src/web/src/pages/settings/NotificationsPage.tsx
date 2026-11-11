import { SettingsCard, SettingsHeader, SettingsRow } from '../../components/settings';
import { Switch } from '../../components/ui/Switch';
import { usePreferences } from './preferences';

/** Settings → Notifications: which of a session's moments alert your devices. Each switch saves when changed. */
export function NotificationsSettingsPage() {
  const { prefs, save } = usePreferences();
  return (
    <div className="settings-page">
      <SettingsHeader title="Notifications" />
      <SettingsCard>
        <SettingsRow
          title="When a session finishes"
          description="Alert your devices when a run finishes on its own or fails for good."
          control={
            <Switch
              aria-label="When a session finishes"
              checked={prefs.notifySessionFinished ?? true}
              onCheckedChange={(v) => save.mutate({ notifySessionFinished: v })}
              loading={save.isPending}
            />
          }
        />
        <SettingsRow
          title="When an agent asks for you"
          description="Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute."
          control={
            <Switch
              aria-label="When an agent asks for you"
              checked={prefs.notifyAgentMessage ?? true}
              onCheckedChange={(v) => save.mutate({ notifyAgentMessage: v })}
              loading={save.isPending}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
