import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  isTieredSettingKey,
  SETTING_ROWS,
  SETTING_TIER_KEYS,
  SETTING_TIERS,
  settingLink,
  settingValueInForce,
  widensAgentReach,
  type SettingTier,
  type TieredSettingKey,
} from '@orbit/shared';
import { UpdatePreferencesDto } from '../users/dto';

/**
 * A settings proposal's rules with no database in them (docs/settings-from-conversation-design.md §3, §5.1): which
 * keys it names, whether their values are ones the PATCH would take, what each change is from and to, and which of
 * them only the owner may make. `OwnerRequestsService.proposeSettings` reads the account and files the card.
 */

/** One proposed change as the card and its payload hold it: the value in force when filed, and the new one. */
export interface SettingsChangeEntry {
  key: TieredSettingKey;
  from: unknown;
  to: unknown;
  tier: SettingTier;
}

/** A SETTINGS_CHANGE request's payload column. */
export interface SettingsChangePayload {
  changes: SettingsChangeEntry[];
}

/** A proposal that cannot be filed as sent; the route answers 400 with its message. */
export class SettingsProposalInvalid extends Error {}

/**
 * Step 1: every key is in the tier table and every value passes `UpdatePreferencesDto`'s rules, so a card never offers
 * a value the owner's PATCH would refuse. A key with no value is refused rather than read as a reset: a proposal names
 * what each setting becomes.
 */
export async function validateSettingsChanges(changes: Record<string, unknown>): Promise<Partial<Record<TieredSettingKey, unknown>>> {
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new SettingsProposalInvalid('changes names no setting');
  const unknown = keys.filter((key) => !isTieredSettingKey(key));
  if (unknown.length > 0) {
    throw new SettingsProposalInvalid(`not a setting a conversation can propose: ${unknown.join(', ')}`);
  }
  const empty = keys.filter((key) => changes[key] === null || changes[key] === undefined);
  if (empty.length > 0) throw new SettingsProposalInvalid(`give each setting a value: ${empty.join(', ')}`);
  const errors = await validate(plainToInstance(UpdatePreferencesDto, changes), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new SettingsProposalInvalid(
      errors.flatMap((error) => Object.values(error.constraints ?? {})).join('; ') || 'a value is not one this setting takes',
    );
  }
  const valid = { ...changes } as Partial<Record<TieredSettingKey, unknown>>;
  // As the PATCH stores it: one entry per provider.
  if (Array.isArray(valid.subagentBlockedProviders)) valid.subagentBlockedProviders = [...new Set(valid.subagentBlockedProviders)];
  return valid;
}

/** The same value, as a setting reads it: a map's key order and a provider list's order do not matter. */
export function sameSettingValue(key: TieredSettingKey, a: unknown, b: unknown): boolean {
  return canonical(key, a) === canonical(key, b);
}

function canonical(key: TieredSettingKey, value: unknown): string {
  if (key === 'subagentBlockedProviders' && Array.isArray(value)) return JSON.stringify([...new Set(value)].sort());
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(value ?? null);
}

/**
 * Step 2: each proposed key next to its value in force, with what is already in force dropped. `defaultModels` names
 * only the providers it changes, as the PATCH merges it, so its `to` is the whole map once merged — what the owner's
 * approval writes — and it is a no-op when every named provider already has that model. `proposed` has been through
 * `validateSettingsChanges`, and its `defaultModels` through `normalizeDefaultModels`.
 */
export function settingsChangeEntries(
  preferences: Readonly<Record<string, unknown>>,
  proposed: Partial<Record<TieredSettingKey, unknown>>,
): SettingsChangeEntry[] {
  const entries: SettingsChangeEntry[] = [];
  for (const key of Object.keys(proposed) as TieredSettingKey[]) {
    const from = settingValueInForce(key, preferences);
    const to = key === 'defaultModels'
      ? { ...(from as Record<string, string>), ...(proposed.defaultModels as Record<string, string>) }
      : proposed[key];
    if (sameSettingValue(key, from, to)) continue;
    entries.push({ key, from, to, tier: SETTING_TIERS[key] });
  }
  return entries;
}

/** Step 3: the keys only the owner may change this way (design §3.2). Any one refuses the whole proposal. */
export function wideningKeys(entries: readonly SettingsChangeEntry[]): TieredSettingKey[] {
  return entries.filter((entry) => widensAgentReach(entry.key, entry.from, entry.to)).map((entry) => entry.key);
}

/**
 * Step 4: whether a declined card asked for exactly these changes — the same keys with the same new values. `from` is
 * not compared: the owner declined the change, not the value it would have replaced.
 */
export function sameSettingsChanges(declined: unknown, entries: readonly SettingsChangeEntry[]): boolean {
  const changes = (declined as Partial<SettingsChangePayload> | null)?.changes;
  if (!Array.isArray(changes) || changes.length !== entries.length) return false;
  return entries.every((entry) => changes.some((was) => was?.key === entry.key && sameSettingValue(entry.key, was.to, entry.to)));
}

/** The refusal of a re-filed declined change, dated in UTC, with the owner's reason. */
export function settingsChangeDeclinedMessage(declinedAt: Date, reason: string | null): string {
  const date = declinedAt.toISOString().slice(0, 10);
  const line = `The owner declined this change on ${date}; ask the person instead of filing it again.`;
  return reason ? `${line} Their reason: ${reason}` : line;
}

/** One setting as `GET /runner/settings` reads it (design §7): its value in force, tier and Settings row. */
export interface SettingView {
  key: TieredSettingKey;
  tier: SettingTier;
  value: unknown;
  title: string;
  path: string | null;
  link: string;
}

/** Every key a conversation can propose, tier by tier, as `settings_get` answers it. */
export function settingsView(preferences: Readonly<Record<string, unknown>>): SettingView[] {
  return ([1, 2, 3] as const).flatMap((tier) => SETTING_TIER_KEYS[tier].map((key) => ({
    key,
    tier,
    value: settingValueInForce(key, preferences),
    title: SETTING_ROWS[key].title,
    path: SETTING_ROWS[key].path,
    link: settingLink(key),
  })));
}
