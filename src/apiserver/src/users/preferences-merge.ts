import { isTieredSettingKey, type TieredSettingKey } from '@orbit/shared';

/**
 * How a set of preference values is written into `User.preferences`, shared by the owner's
 * `PATCH /users/me/preferences` and the owner's approval of a SETTINGS_CHANGE card
 * (`POST /owner-requests/:id/apply-settings`, docs/settings-from-conversation-design.md §5.2): each key given is
 * shallow-merged, so omitted keys keep their value; `defaultModels` merges its provider entries, keeping choices for
 * other providers; `subagentBlockedProviders` is stored with one entry per provider; a null `cardFreeTaskCreates`
 * removes the key, its default. `values` has been validated with
 * `UpdatePreferencesDto`'s rules and its `defaultModels` normalised (`normalizeDefaultModels`).
 */
export function mergePreferences(
  current: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
): { merged: Record<string, unknown>; written: TieredSettingKey[] } {
  const merged = { ...current };
  const written: TieredSettingKey[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || !isTieredSettingKey(key)) continue;
    if (key === 'defaultModels') {
      merged.defaultModels = { ...((merged.defaultModels ?? {}) as Record<string, string>), ...(value as Record<string, string>) };
    } else if (key === 'cardFreeTaskCreates' && value === null) {
      // null goes back to the default (runner-api/session-create-allowance.ts), which is an absent key.
      delete merged.cardFreeTaskCreates;
    } else if (key === 'subagentBlockedProviders') {
      merged.subagentBlockedProviders = [...new Set(value as string[])];
    } else {
      merged[key] = value;
    }
    written.push(key);
  }
  return { merged, written };
}

/** The key of `User.preferences` that marks a setting changed from a conversation (design §5.3). */
export const CHANGED_BY = 'changedBy';

/** One setting's mark: the session whose card the owner approved, that card, when, and the value it replaced. */
export interface SettingChangedBy {
  sessionId: string;
  requestId: string;
  at: string;
  from: unknown;
}

/** The marks in `preferences`, or an empty map. */
export function changedByOf(preferences: Readonly<Record<string, unknown>>): Record<string, SettingChangedBy> {
  const marks = preferences[CHANGED_BY];
  return marks && typeof marks === 'object' && !Array.isArray(marks) ? { ...(marks as Record<string, SettingChangedBy>) } : {};
}

/**
 * `preferences` with the marks of `keys` replaced: `marks[key]` set for each key it names, removed for each it does
 * not. No marks left removes `changedBy` itself.
 */
export function withChangedBy(
  preferences: Record<string, unknown>,
  keys: readonly string[],
  mark?: (key: string) => SettingChangedBy,
): Record<string, unknown> {
  const marks = changedByOf(preferences);
  for (const key of keys) {
    if (mark) marks[key] = mark(key);
    else delete marks[key];
  }
  const next = { ...preferences };
  if (Object.keys(marks).length > 0) next[CHANGED_BY] = marks;
  else delete next[CHANGED_BY];
  return next;
}
