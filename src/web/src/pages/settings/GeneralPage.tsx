import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { DEFAULT_PERMISSION_MODE, MODE_OPTIONS } from '../../lib/workspaceDefaults';
import { usePreferences } from './preferences';

/*
 * Each row's hint is the one line the board (docs/mocks/settings-redesign, board-2) shortens it to; the
 * full text it had before is the control's tooltip.
 */
export const GENERAL_HINTS = {
  defaultPermissionMode: {
    short: 'The mode a new session starts in, unless the composer picks another.',
    full: 'The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in.',
  },
  modelRouting: {
    short: 'Coordinators suggest a tier for each task; Agents you turn this on for run on that tier.',
    full: "Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model and effort. Off: tasks run exactly as before.",
  },
  promptSuggestions: {
    short: "When a Claude turn ends, the empty message box offers what you'd probably type next.",
    full: "When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account.",
  },
  recaps: {
    short: 'Session lists show a one-line summary of each conversation instead of its raw last reply.',
    full: 'Session lists show the one-line summary the server writes for each conversation, in place of its raw last reply, and the conversation ends with it. Off: the raw last reply, and no summary in the conversation.',
  },
  enableOrchestration: {
    short: 'Sessions in every workspace can spawn and manage other sessions via the orbit MCP tools.',
    full: 'Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused.',
  },
} as const;

/**
 * Settings → General (board-2): how new sessions start, then whether sessions may orchestrate others.
 * The permission default is what a new session starts in when the composer names no mode (it used to live
 * per workspace — see common/permission-mode.ts for why the posture belongs to the run). Every row saves
 * the moment it changes.
 */
export function GeneralSettingsPage() {
  const { prefs, save } = usePreferences();
  const h = GENERAL_HINTS;
  return (
    <div className="settings-page">
      <SettingsHeader title="General" description="How new sessions start, account-wide." />

      <SettingsSection title="New sessions">
        <SettingsCard>
          <SettingsRow
            title="Default permission mode"
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
            title="Smart model selection"
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
            title="Suggested replies"
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
            title="Session recaps"
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

      {/* One switch for the whole account, not one per workspace: the server reads it live on
          every claim, spawn and call, so turning it off takes the tools away everywhere at once.
          Absent means on — only turning it off is ever written. */}
      <SettingsSection title="Orchestration">
        <SettingsCard>
          <SettingsRow
            title="Let sessions orchestrate"
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
