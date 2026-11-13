import { SettingsCard, SettingsHeader, SettingsRow } from '../../components/settings';
import { Switch } from '../../components/ui/Switch';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

/** Settings → Notifications: which of a session's moments alert your devices. Each switch saves when changed. */
export function NotificationsSettingsPage() {
  const { prefs, save } = usePreferences();
  return (
    <div className="settings-page">
      <SettingsHeader title="Notifications" />
      <SettingsCard>
        <SettingsRow
          anchor={S.notifySessionFinished.anchor}
          title={S.notifySessionFinished.title}
          description={S.notifySessionFinished.description}
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
          anchor={S.notifyAgentMessage.anchor}
          title={S.notifyAgentMessage.title}
          description={S.notifyAgentMessage.description}
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
