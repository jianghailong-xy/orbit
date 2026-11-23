import { TRANSLATION_LANGUAGE_NAMES, TRANSLATION_LANGUAGES, type TranslationLanguage } from '@orbit/shared';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { NumberInput } from '../../components/ui/NumberInput';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { agentLanguageOf, translationLanguageOf } from '../../lib/translation';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../../lib/workspaceDefaults';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S, translationEnabledDescription } from './settingsIndex';

/*
 * Each row's hint is the one line the board (docs/mocks/settings-redesign, board-2) shortens it to, kept
 * in the Settings index with the row's title; the full text it had before is the control's tooltip.
 */
export const GENERAL_HINTS = {
  defaultPermissionMode: {
    short: S.defaultPermissionMode.description,
    full: 'The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in.',
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
    full: 'Sessions in every workspace can start and manage other sessions, and manage your agents and runners, through the orbit MCP tools and CLI: create, change and delete agents, install engines on runners and delete them. Off → those tools are hidden and refused.',
  },
  cardFreeTaskCreates: {
    short: S.cardFreeTaskCreates.description,
    full: "A session's first tasks are created without a confirmation card; the one after, and every one after that, waits for you. Every task the session created counts, including ones you approved. A session in a narrower mode than your default always asks. 8 unless you set another number, up to 50.",
  },
} as const;

const TRANSLATION_LANGUAGE_OPTIONS = TRANSLATION_LANGUAGES.map((value) => ({
  value,
  label: TRANSLATION_LANGUAGE_NAMES[value],
}));

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
  // The same for the prompt optimizer (board docs/mocks/prompt-optimizer, frame 1b).
  const optimizerUnavailable = me !== undefined && me.promptOptimizerAvailable !== true;
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
          {/* Absent means ON; only an explicit false turns it off (owner's decision of 2026-11-16). Without the server's
              DeepSeek key it is drawn disabled with frame 1b's notice, whatever the preference says. */}
          <SettingsRow
            anchor={S.promptOptimizer.anchor}
            title={S.promptOptimizer.title}
            description={S.promptOptimizer.description}
            control={
              <Switch
                aria-label="Prompt optimizer"
                checked={!optimizerUnavailable && prefs.promptOptimizer !== false}
                disabled={optimizerUnavailable}
                onCheckedChange={(v) => save.mutate({ promptOptimizer: v })}
                loading={save.isPending}
              />
            }
          />
          {optimizerUnavailable && (
            <div className="settings-translation-notice" role="note">
              This server has no DeepSeek key (<code>DEEPSEEK_API_KEY</code>), so it cannot optimize prompts.
            </div>
          )}
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
          absent = off, the language the owner writes and reads in, and the language agents work in (absent =
          English). Both pickers offer the one shared list. */}
      <SettingsSection title="Translation">
        <SettingsCard>
          <SettingsRow
            anchor={S.translationEnabled.anchor}
            title={S.translationEnabled.title}
            description={translationEnabledDescription(TRANSLATION_LANGUAGE_NAMES[agentLanguageOf(me)])}
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
              <Select<TranslationLanguage>
                aria-label="Agents work in"
                style={{ width: 200 }}
                value={agentLanguageOf(me)}
                options={TRANSLATION_LANGUAGE_OPTIONS}
                disabled={translationUnavailable}
                onValueChange={(v) => v !== null && save.mutate({ translationAgentLanguage: v })}
                loading={save.isPending}
              />
            }
          />
          {/* "Show both languages" (docs/mocks/session-translation/02-bilingual.png, mark A): only while
              translation is on; absent = off. */}
          {!translationUnavailable && prefs.translationEnabled === true && (
            <SettingsRow
              anchor={S.translationBilingual.anchor}
              title={S.translationBilingual.title}
              control={
                <Switch
                  aria-label="Show both languages"
                  checked={prefs.translationBilingual === true}
                  onCheckedChange={(v) => save.mutate({ translationBilingual: v })}
                  loading={save.isPending}
                />
              }
            />
          )}
        </SettingsCard>
        <p className="settings-translation-footnote">
          With both languages on, each translated message also shows the words the agent read or wrote, in the language agents work in. Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a
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
          {/* docs/mocks/card-free-task-creates: absent reads as the server's default, 8; 0 cards every create. */}
          <SettingsRow
            anchor={S.cardFreeTaskCreates.anchor}
            title={S.cardFreeTaskCreates.title}
            description={h.cardFreeTaskCreates.short}
            tooltip={h.cardFreeTaskCreates.full}
            control={
              <NumberInput
                aria-label="Tasks a session files without asking"
                style={{ width: 96 }}
                value={prefs.cardFreeTaskCreates ?? 8}
                min={0}
                max={50}
                step={1}
                precision={0}
                onValueChange={(v) => v !== null && v !== (prefs.cardFreeTaskCreates ?? 8) && save.mutate({ cardFreeTaskCreates: v })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
