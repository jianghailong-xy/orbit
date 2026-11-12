import { SettingsCard, SettingsHeader, SettingsRow } from '../../components/settings';
import { Segmented } from '../../components/ui/Segmented';
import { useThemeMode, type ThemeMode } from '../../lib/theme';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

/** Settings → Appearance: the theme, account-synced through the theme context. */
export function AppearanceSettingsPage() {
  const { mode, setMode } = useThemeMode();
  return (
    <div className="settings-page">
      <SettingsHeader title="Appearance" />
      <SettingsCard>
        <SettingsRow
          anchor={S.theme.anchor}
          title={S.theme.title}
          description={S.theme.description}
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
