import { TRANSLATION_LANGUAGE_NAMES, TRANSLATION_LANGUAGES, type TranslationLanguage } from '@orbit/shared';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { translationLanguageOf } from '../../lib/translation';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../../lib/workspaceDefaults';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

/*
 * Each row's hint is the one line the board (docs/mocks/settings-redesign, board-2) shortens it to, kept
 * in the Settings index with the row's title; the full text it had before is the control's tooltip.
 */
export const GENERAL_HINTS = {
  defaultPermissionMode: {
    short: S.defaultPermissionMode.description,
    full: 'The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in.',
  },
  modelRouting: {
    short: S.modelRouting.description,
    full: "Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model and effort. Off: tasks run exactly as before.",
  },
  promptSuggestions: {
    short: S.promptSuggestions.description,
    full: "When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account.",
  },
  recaps: {
    short: S.recaps.description,
    full: 'Session lists show the one-line summary the server writes for each conversation, in place of its raw last reply, and the conversation ends with it. Off: the raw last reply, and no summary in the conversation.',
  },
  enableOrchestration: {
    short: S.enableOrchestration.description,
    full: 'Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused.',
  },
} as const;

const TRANSLATION_LANGUAGE_OPTIONS = TRANSLATION_LANGUAGES.map((value) => ({
  value,
  label: TRANSLATION_LANGUAGE_NAMES[value],
}));
const AGENT_LANGUAGE_OPTIONS = [{ value: 'en', label: 'English' }];

/**
 * Settings → General (board-2): how new sessions start, then whether sessions may orchestrate others.
 * The permission default is what a new session starts in when the composer names no mode (it used to live
 * per workspace — see common/permission-mode.ts for why the posture belongs to the run). Every row saves
 * the moment it changes.
 */
export function GeneralSettingsPage() {
  const { me, prefs, save } = usePreferences();
  const h = GENERAL_HINTS;
  // A server without a DeepSeek key cannot translate: Translation is drawn disabled with frame 2's
  // notice, whatever the preference says.
  const translationUnavailable = me !== undefined && me.translationAvailable !== true;
  return (
    <div className="settings-page">
      <SettingsHeader title="General" description="How new sessions start, account-wide." />

      <SettingsSection title="New sessions">
        <SettingsCard>
          <SettingsRow
            anchor={S.defaultPermissionMode.anchor}
            title={S.defaultPermissionMode.title}
            description={h.defaultPermissionMode.short}
            tooltip={h.defaultPermissionMode.full}
            control={
              <Select
                aria-label="Default permission mode"
                style={{ width: 200 }}
                value={prefs.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE}
                options={MODE_OPTIONS}
                onValueChange={(v) => v !== null && save.mutate({ defaultPermissionMode: v })}
                loading={save.isPending}
              />
            }
          />
          {/* Absent means OFF, unlike the switches below — only turning it on has to be written. */}
          <SettingsRow
            anchor={S.modelRouting.anchor}
            title={S.modelRouting.title}
            description={h.modelRouting.short}
            tooltip={h.modelRouting.full}
            control={
              <Switch
                aria-label="Smart model selection"
                checked={prefs.modelRouting === true}
                onCheckedChange={(v) => save.mutate({ modelRouting: v })}
                loading={save.isPending}
              />
            }
          />
          {/* Absent means on, like the switches below. The engine reads it when it starts, so a
              session already running keeps what it started with. */}
          <SettingsRow
            anchor={S.promptSuggestions.anchor}
            title={S.promptSuggestions.title}
            description={h.promptSuggestions.short}
            tooltip={h.promptSuggestions.full}
            control={
              <Switch
                aria-label="Suggested replies"
                checked={prefs.promptSuggestions ?? true}
                onCheckedChange={(v) => save.mutate({ promptSuggestions: v })}
                loading={save.isPending}
              />
            }
          />
          {/* Absent means on, like the switch above. Read by every client's session list, so turning
              it off holds on the phone and the Mac too — it is one account-wide answer. */}
          <SettingsRow
            anchor={S.recaps.anchor}
            title={S.recaps.title}
            description={h.recaps.short}
            tooltip={h.recaps.full}
            control={
              <Switch
                aria-label="Session recaps"
                checked={prefs.recaps ?? true}
                onCheckedChange={(v) => save.mutate({ recaps: v })}
                loading={save.isPending}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Settings › Translation (docs/mocks/session-translation, frames 1 and 2): one account-wide switch,
          absent = off, and the language the owner writes and reads in. Agents always work in English, so
          that row is shown and not offered. */}
      <SettingsSection title="Translation">
        <SettingsCard>
          <SettingsRow
            anchor={S.translationEnabled.anchor}
            title={S.translationEnabled.title}
            description={S.translationEnabled.description}
            control={
              <Switch
                aria-label="Translate conversations"
                checked={!translationUnavailable && prefs.translationEnabled === true}
                disabled={translationUnavailable}
                onCheckedChange={(v) => save.mutate({ translationEnabled: v })}
                loading={save.isPending}
              />
            }
          />
          {translationUnavailable && (
            <div className="settings-translation-notice" role="note">
              This server has no DeepSeek key, so it can't translate. Whoever runs it sets <code>DEEPSEEK_API_KEY</code> and
              restarts it.
            </div>
          )}
          <SettingsRow
            anchor={S.translationLanguage.anchor}
            title={S.translationLanguage.title}
            description={S.translationLanguage.description}
            control={
              <Select<TranslationLanguage>
                aria-label="Your language"
                style={{ width: 200 }}
                value={translationLanguageOf(me)}
                options={TRANSLATION_LANGUAGE_OPTIONS}
                disabled={translationUnavailable}
                onValueChange={(v) => v !== null && save.mutate({ translationLanguage: v })}
                loading={save.isPending}
              />
            }
          />
          <SettingsRow
            anchor={S.agentLanguage.anchor}
            title={S.agentLanguage.title}
            description={S.agentLanguage.description}
            control={
              <Select
                aria-label="Agents work in"
                style={{ width: 200 }}
                value="en"
                options={AGENT_LANGUAGE_OPTIONS}
                disabled
                onValueChange={() => {}}
              />
            }
          />
        </SettingsCard>
        <p className="settings-translation-footnote">
          Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a
          conversation stays as it was.
        </p>
      </SettingsSection>

      {/* One switch for the whole account, not one per workspace: the server reads it live on
          every claim, spawn and call, so turning it off takes the tools away everywhere at once.
          Absent means on — only turning it off is ever written. */}
      <SettingsSection title="Orchestration">
        <SettingsCard>
          <SettingsRow
            anchor={S.enableOrchestration.anchor}
            title={S.enableOrchestration.title}
            description={h.enableOrchestration.short}
            tooltip={h.enableOrchestration.full}
            control={
              <Switch
                aria-label="Let sessions orchestrate"
                checked={prefs.enableOrchestration ?? true}
                onCheckedChange={(v) => save.mutate({ enableOrchestration: v })}
                loading={save.isPending}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
