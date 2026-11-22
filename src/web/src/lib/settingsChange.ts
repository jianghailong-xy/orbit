import {
  PERSONAL_SETTINGS,
  SETTING_ROWS,
  TRANSLATION_LANGUAGE_NAMES,
  isTieredSettingKey,
  type SettingTier,
  type TieredSettingKey,
} from '@orbit/shared';
import { MODEL_ROUTING_PAGE, PERSONAL_PAGES } from '../pages/settings/settingsIndex';
import { MODE_OPTIONS } from './workspaceDefaults';

/**
 * Settings from a conversation on the web (docs/settings-from-conversation-design.md §6, §8): the words a
 * SETTINGS_CHANGE card, an `orbit-settings:` link card and a changed Settings row are drawn with, and the rules with
 * no component in them — where a setting is in Settings, and how a value reads there.
 */

export const SETTINGS_CHANGE_COPY = {
  heading: (count: number) => `⚙️ Confirm: change ${count} setting${count === 1 ? '' : 's'}?`,
  newSessionsOnly: 'Applies to new sessions only.',
  agentSays: (why: string) => `The agent says: ${why}`,
  foot: 'Only these change. You can change them back in Settings.',
  save: 'Save changes',
  chat: '💬 Chat about this',
  declinePlaceholder: 'What should the agent know? It reads this.',
  decline: 'Decline',
  keep: 'Keep it',
  changed: (count: number) => `✓ Changed ${count} setting${count === 1 ? '' : 's'}`,
  undo: 'Undo',
  undone: 'Undone',
  declined: 'Declined',
  stale: 'This setting changed since it was proposed.',
  openInSettings: 'Open in Settings',
  turnedOn: 'Turned on from',
  turnedOff: 'Turned off from',
  setFrom: 'Set from',
  aConversation: 'a conversation',
} as const;

/** One change on a card, as the request's payload holds it (apiserver owner-requests/settings-change.ts). */
export interface SettingsChangeEntry {
  key: TieredSettingKey;
  from: unknown;
  to: unknown;
  tier: SettingTier;
}

/** The changes a SETTINGS_CHANGE request carries, in the order filed. Entries naming no known key are left out. */
export function settingsChangesOf(payload: unknown): SettingsChangeEntry[] {
  const changes = (payload as { changes?: unknown } | null | undefined)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter(
    (entry): entry is SettingsChangeEntry =>
      !!entry && typeof entry === 'object' && isTieredSettingKey((entry as { key?: unknown }).key as string),
  );
}

/** The section of its page each General row is drawn under (GeneralPage.tsx); a page with no sections has none. */
const SECTIONS: Readonly<Record<string, string>> = {
  defaultPermissionMode: 'New sessions',
  promptSuggestions: 'New sessions',
  promptOptimizer: 'New sessions',
  recaps: 'New sessions',
  translationEnabled: 'Translation',
  translationLanguage: 'Translation',
  agentLanguage: 'Translation',
  translationBilingual: 'Translation',
  enableOrchestration: 'Orchestration',
  cardFreeTaskCreates: 'Orchestration',
};

/** A Settings row, found by its anchor or by the preference key it writes. */
export interface SettingPlace {
  key: TieredSettingKey | null;
  anchor: string;
  title: string;
  path: string;
}

/**
 * The row an `orbit-settings:` link or a key names: its title, the page it is on and its anchor there. Either
 * spelling is taken — the server links by key (`orbit-settings:translationAgentLanguage`), a row's anchor may differ
 * (`agentLanguage`). Null for a name with no row in Settings.
 */
export function settingPlace(name: string): SettingPlace | null {
  if (isTieredSettingKey(name)) {
    const row = SETTING_ROWS[name];
    return row.path && row.anchor ? { key: name, anchor: row.anchor, title: row.title, path: row.path } : null;
  }
  const setting = (PERSONAL_SETTINGS as Record<string, { anchor: string; path: string; title: string }>)[name];
  if (!setting) return null;
  return { key: settingKeyOfAnchor(setting.anchor), anchor: setting.anchor, title: setting.title, path: setting.path };
}

/** The preference key a Settings row writes, or null for a row that writes none. */
export function settingKeyOfAnchor(anchor: string): TieredSettingKey | null {
  for (const [key, row] of Object.entries(SETTING_ROWS)) if (row.anchor === anchor) return key as TieredSettingKey;
  return null;
}

/** `Settings › General › Translation`: where a row is, as the card and the link card name it. */
export function settingPathLabel(place: Pick<SettingPlace, 'anchor' | 'path'>): string {
  const page = [...PERSONAL_PAGES, MODEL_ROUTING_PAGE].find((p) => p.path === place.path)?.label;
  return ['Settings', page, SECTIONS[place.anchor]].filter(Boolean).join(' › ');
}

/** A key's place in Settings as the card names it, or null for a key with no Settings row (the composer's defaults). */
export function keyPathLabel(key: TieredSettingKey): string | null {
  const row = SETTING_ROWS[key];
  return row.path && row.anchor ? settingPathLabel({ anchor: row.anchor, path: row.path }) : null;
}

const THEME_LABELS: Readonly<Record<string, string>> = { system: 'System', light: 'Light', dark: 'Dark' };
export const OPTIMIZE_LABELS: Readonly<Record<string, string>> = { cost: 'Cost', balance: 'Balance', intelligence: 'Intelligence' };

/** A value as the Settings page shows it: `Chinese (Simplified)`, not `zh-Hans`; `On`, not `true`. */
export function settingValueLabel(key: TieredSettingKey, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  switch (key) {
    case 'translationLanguage':
    case 'translationAgentLanguage':
      return TRANSLATION_LANGUAGE_NAMES[value as keyof typeof TRANSLATION_LANGUAGE_NAMES] ?? String(value);
    case 'theme':
      return THEME_LABELS[value as string] ?? String(value);
    case 'optimizeFor':
      return OPTIMIZE_LABELS[value as string] ?? String(value);
    case 'defaultPermissionMode':
      return MODE_OPTIONS.find((option) => option.value === value)?.label ?? String(value);
    case 'defaultEffort':
      return value ? String(value) : 'Engine default';
    case 'defaultModel':
      return value ? String(value) : 'None';
    case 'defaultModels': {
      const entries = Object.entries((value ?? {}) as Record<string, string>);
      return entries.length > 0 ? entries.map(([provider, model]) => `${provider}: ${model}`).join(', ') : 'None';
    }
    case 'subagentBlockedProviders':
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'None';
    default:
      return value === null || value === undefined ? 'Default' : String(value);
  }
}

/** One setting's mark from `GET /users/me` (design §5.3): the conversation it was changed from, when, and what it was. */
export interface SettingChangedBy {
  sessionId: string;
  requestId: string;
  at: string;
  from: unknown;
  sessionTitle: string | null;
}

/** The first words of a changed row's line: a switch was turned on or off; any other value was set. */
export function changedByLead(mark: Pick<SettingChangedBy, 'from'>): string {
  if (typeof mark.from !== 'boolean') return SETTINGS_CHANGE_COPY.setFrom;
  return mark.from ? SETTINGS_CHANGE_COPY.turnedOff : SETTINGS_CHANGE_COPY.turnedOn;
}
