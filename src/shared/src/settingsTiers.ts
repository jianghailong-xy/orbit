import { PERSONAL_SETTINGS } from './settingsIndex';
import { DEFAULT_AGENT_LANGUAGE, DEFAULT_TRANSLATION_LANGUAGE } from './translation';

/**
 * Settings from a conversation (docs/settings-from-conversation-design.md §3): every preference key an agent may
 * propose, in one of three tiers. The apiserver's filing route, the runner's tool descriptions and the clients read
 * this one table. A key of `UpdatePreferencesDto` (src/apiserver/src/users/dto.ts) that is in no tier fails the
 * census in settingsTiers.spec.ts, so a new preference cannot be added without placing it here.
 *
 *   1  Personal               proposed, then a card
 *   2  Defaults for new work  proposed, then a card that says it applies to new sessions only
 *   3  Agent reach            only the narrowing direction (§3.2) may be proposed; widening is the owner's alone
 */
export type SettingTier = 1 | 2 | 3;

export const SETTING_TIER_KEYS = {
  1: [
    'theme',
    'translationEnabled',
    'translationLanguage',
    'translationAgentLanguage',
    'translationBilingual',
    'notifySessionFinished',
    'notifyAgentMessage',
    'recaps',
    'promptSuggestions',
    'promptOptimizer',
  ],
  // `optimizeFor` landed after the design's table was written (2026-11-19, account-wide Optimize For). Like
  // `modelRouting` it decides how new work is routed, and it gives agents no more reach, so it is tier 2.
  // `relaxBlockedPins` (docs/routing-account-health-design.md §7.5) decides where pinned work runs while its account
  // cannot: routing, like `modelRouting`, and inside the owner's SubAgent provider limits, so no more reach: tier 2.
  2: ['defaultModel', 'defaultModels', 'defaultEffort', 'modelRouting', 'optimizeFor', 'relaxBlockedPins'],
  // `cardFreeTaskCreates` landed after the table too (Settings › General, "Tasks a session files without asking"). It
  // decides how many tasks a session files without asking the owner, so it is agent reach: tier 3.
  3: ['enableOrchestration', 'defaultPermissionMode', 'subagentBlockedProviders', 'cardFreeTaskCreates'],
} as const satisfies Record<SettingTier, readonly string[]>;

export type TieredSettingKey = (typeof SETTING_TIER_KEYS)[SettingTier][number];

/** Each key's tier, read off SETTING_TIER_KEYS. */
export const SETTING_TIERS: Readonly<Record<TieredSettingKey, SettingTier>> = Object.fromEntries(
  ([1, 2, 3] as const).flatMap((tier) => SETTING_TIER_KEYS[tier].map((key) => [key, tier])),
) as Record<TieredSettingKey, SettingTier>;

export function isTieredSettingKey(key: string): key is TieredSettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_TIERS, key);
}

/** The tier of a key, or undefined for a key that is not in the table (and so cannot be proposed). */
export function settingTier(key: string): SettingTier | undefined {
  return isTieredSettingKey(key) ? SETTING_TIERS[key] : undefined;
}

/**
 * What each key reads as when the account never wrote it, as the server reads it where the setting acts. A proposal's
 * `from` is the stored value or this one, so asking for what is already in effect is a no-op, and a direction is
 * judged against the value that is really in force (an absent `enableOrchestration` is on).
 */
export const SETTING_DEFAULTS: Readonly<Record<TieredSettingKey, unknown>> = {
  theme: 'system',
  translationEnabled: false,
  translationLanguage: DEFAULT_TRANSLATION_LANGUAGE,
  translationAgentLanguage: DEFAULT_AGENT_LANGUAGE,
  translationBilingual: false,
  notifySessionFinished: true,
  notifyAgentMessage: true,
  recaps: true,
  promptSuggestions: true,
  promptOptimizer: true,
  defaultModel: null,
  defaultModels: {},
  defaultEffort: '',
  // On unless explicitly false, as the apiserver reads it (common/model-routing-switch.ts).
  modelRouting: true,
  optimizeFor: 'balance',
  // Off unless explicitly true, as the apiserver reads it (tasks/task-route-decision.ts).
  relaxBlockedPins: false,
  enableOrchestration: true,
  // The apiserver's DEFAULT_PERMISSION_MODE (common/permission-mode.ts).
  defaultPermissionMode: 'auto',
  subagentBlockedProviders: [],
  // The apiserver's DEFAULT_CARD_FREE_TASK_CREATES (runner-api/session-create-allowance.ts).
  cardFreeTaskCreates: 8,
};

/** A key's value in force: the stored one, or its default when the account never wrote it. */
export function settingValueInForce(key: TieredSettingKey, preferences: Readonly<Record<string, unknown>>): unknown {
  const stored = preferences[key];
  return stored === undefined || stored === null ? SETTING_DEFAULTS[key] : stored;
}

/** The two permission modes a proposal may move `defaultPermissionMode` to (§3.2). */
export const NARROWING_PERMISSION_MODES: readonly string[] = ['plan', 'default'];

/**
 * Whether changing `key` from `from` to `to` gives agents more reach (design §3.2). Only tier 3 has a direction; a
 * tier 1 or 2 change never widens.
 *
 *   enableOrchestration       true → false narrows; false → true widens
 *   subagentBlockedProviders  adding providers and removing none narrows; removing any provider widens
 *   defaultPermissionMode     a new value of plan or default narrows; any other new value widens
 *   cardFreeTaskCreates       the count in force after the change (null or absent is the default) greater than the
 *                             count before it widens; an equal or lower count, 0 included, narrows
 *
 * `defaultPermissionMode` is ranked by those two values on purpose, not by an order of all six modes: whether
 * `dontAsk` is stricter than `acceptEdits` depends on the engine and the allow-list.
 */
export function widensAgentReach(key: TieredSettingKey, from: unknown, to: unknown): boolean {
  switch (key) {
    case 'enableOrchestration':
      return to === true && from !== true;
    case 'subagentBlockedProviders': {
      const kept = new Set(Array.isArray(to) ? to : []);
      return (Array.isArray(from) ? from : []).some((provider) => !kept.has(provider));
    }
    case 'defaultPermissionMode':
      return !NARROWING_PERMISSION_MODES.includes(to as string);
    case 'cardFreeTaskCreates':
      return cardFreeTaskCreatesInForce(to) > cardFreeTaskCreatesInForce(from);
    default:
      return false;
  }
}

function cardFreeTaskCreatesInForce(value: unknown): number {
  return typeof value === 'number' ? value : (SETTING_DEFAULTS.cardFreeTaskCreates as number);
}

/**
 * Where each key is changed in Settings: the row's title and page, and its anchor there. The titles and pages are
 * PERSONAL_SETTINGS', where a key has a Personal row. `path` and `anchor` are null for a key with no row of its own
 * there: the composer's defaults, and the SubAgent providers list, which is on every Agent's settings.
 */
export interface SettingRow {
  title: string;
  path: string | null;
  anchor: string | null;
}

const row = (setting: { title: string; path: string; anchor: string }): SettingRow =>
  ({ title: setting.title, path: setting.path, anchor: setting.anchor });

export const SETTING_ROWS: Readonly<Record<TieredSettingKey, SettingRow>> = {
  theme: row(PERSONAL_SETTINGS.theme),
  translationEnabled: row(PERSONAL_SETTINGS.translationEnabled),
  translationLanguage: row(PERSONAL_SETTINGS.translationLanguage),
  translationAgentLanguage: row(PERSONAL_SETTINGS.agentLanguage),
  translationBilingual: row(PERSONAL_SETTINGS.translationBilingual),
  notifySessionFinished: row(PERSONAL_SETTINGS.notifySessionFinished),
  notifyAgentMessage: row(PERSONAL_SETTINGS.notifyAgentMessage),
  recaps: row(PERSONAL_SETTINGS.recaps),
  promptSuggestions: row(PERSONAL_SETTINGS.promptSuggestions),
  promptOptimizer: row(PERSONAL_SETTINGS.promptOptimizer),
  defaultModel: { title: 'Default model', path: null, anchor: null },
  defaultModels: { title: 'Default model per provider', path: null, anchor: null },
  defaultEffort: { title: 'Default effort', path: null, anchor: null },
  modelRouting: row(PERSONAL_SETTINGS.modelRouting),
  optimizeFor: row(PERSONAL_SETTINGS.optimizeFor),
  relaxBlockedPins: row(PERSONAL_SETTINGS.relaxBlockedPins),
  enableOrchestration: row(PERSONAL_SETTINGS.enableOrchestration),
  defaultPermissionMode: row(PERSONAL_SETTINGS.defaultPermissionMode),
  subagentBlockedProviders: { title: 'SubAgent providers', path: null, anchor: null },
  cardFreeTaskCreates: row(PERSONAL_SETTINGS.cardFreeTaskCreates),
};

/** The link a reply puts on a setting's name; clients open Settings on its row (design §6). */
export function settingLink(key: TieredSettingKey): string {
  return `orbit-settings:${key}`;
}

/** One refused key in a `403 SETTING_OWNER_ONLY` body (design §6). */
export interface SettingOwnerOnlyEntry {
  key: TieredSettingKey;
  title: string;
  path: string | null;
  link: string;
}

export const SETTING_OWNER_ONLY = 'SETTING_OWNER_ONLY';

/** The `403 SETTING_OWNER_ONLY` body for the keys a proposal would widen (design §6). */
export function settingOwnerOnlyBody(keys: readonly TieredSettingKey[]): {
  code: typeof SETTING_OWNER_ONLY;
  message: string;
  settings: SettingOwnerOnlyEntry[];
} {
  const settings = keys.map((key) => ({
    key,
    title: SETTING_ROWS[key].title,
    path: SETTING_ROWS[key].path,
    link: settingLink(key),
  }));
  return { code: SETTING_OWNER_ONLY, message: settingOwnerOnlyMessage(keys), settings };
}

function settingOwnerOnlyMessage(keys: readonly TieredSettingKey[]): string {
  const names = keys.map((key) => `"${SETTING_ROWS[key].title}"`);
  if (keys.length === 1) {
    return keys[0] === 'enableOrchestration'
      ? `${names[0]} gives agents more reach; only you can turn it on, in Settings.`
      : `This change to ${names[0]} gives agents more reach; only you can make it, in Settings.`;
  }
  return `These changes give agents more reach; only you can make them, in Settings: ${names.join(', ')}.`;
}

/** The card's title, which the server writes (design §5.1): "Change 1 setting?", "Change 2 settings?". */
export function settingsChangeTitle(count: number): string {
  return `Change ${count} setting${count === 1 ? '' : 's'}?`;
}
