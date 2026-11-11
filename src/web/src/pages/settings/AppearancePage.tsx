import { SettingsCard, SettingsHeader, SettingsRow } from '../../components/settings';
import { Segmented } from '../../components/ui/Segmented';
import { useThemeMode, type ThemeMode } from '../../lib/theme';

/** Settings → Appearance: the theme, account-synced through the theme context. */
export function AppearanceSettingsPage() {
  const { mode, setMode } = useThemeMode();
  return (
    <div className="settings-page">
      <SettingsHeader title="Appearance" />
      <SettingsCard>
        <SettingsRow
          title="Theme"
          description="Synced to your account across devices."
          control={
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
          }
        />
      </SettingsCard>
    </div>
  );
}
