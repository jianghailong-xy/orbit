import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_SETTINGS } from './settingsIndex';
import {
  SETTING_DEFAULTS,
  SETTING_ROWS,
  SETTING_TIERS,
  SETTING_TIER_KEYS,
  settingOwnerOnlyBody,
  settingTier,
  settingValueInForce,
  settingsChangeTitle,
  widensAgentReach,
  type TieredSettingKey,
} from './settingsTiers';

/** The property names `UpdatePreferencesDto` declares, read from the apiserver's source (design §9). */
function updatePreferencesDtoKeys(): string[] {
  const source = readFileSync(path.join(__dirname, '../../apiserver/src/users/dto.ts'), 'utf8');
  const start = source.indexOf('export class UpdatePreferencesDto {');
  expect(start, 'UpdatePreferencesDto is declared in src/apiserver/src/users/dto.ts').toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)[?!]?:/gm)].map((match) => match[1]!);
}

describe('settings tier census', () => {
  const tiered = ([1, 2, 3] as const).flatMap((tier) => [...SETTING_TIER_KEYS[tier]]);

  it('reads the DTO it guards', () => {
    expect(updatePreferencesDtoKeys()).toContain('theme');
    expect(updatePreferencesDtoKeys().length).toBeGreaterThanOrEqual(18);
  });

  it('puts every UpdatePreferencesDto key in a tier', () => {
    const untiered = updatePreferencesDtoKeys().filter((key) => settingTier(key) === undefined);
    expect(untiered, 'place each new preference in a tier of src/shared/src/settingsTiers.ts').toEqual([]);
  });

  it('puts no key in two tiers', () => {
    const twice = tiered.filter((key, index) => tiered.indexOf(key) !== index);
    expect(twice).toEqual([]);
  });

  it('names no key the DTO does not have', () => {
    const dto = new Set(updatePreferencesDtoKeys());
    expect(tiered.filter((key) => !dto.has(key))).toEqual([]);
  });

  it('has the table of design §3.1', () => {
    expect(SETTING_TIER_KEYS[3]).toEqual([
      'enableOrchestration',
      'defaultPermissionMode',
      'subagentBlockedProviders',
      'cardFreeTaskCreates',
    ]);
    expect(SETTING_TIERS.theme).toBe(1);
    expect(SETTING_TIERS.translationAgentLanguage).toBe(1);
    expect(SETTING_TIERS.defaultModels).toBe(2);
    expect(SETTING_TIERS.modelRouting).toBe(2);
    expect(SETTING_TIERS.optimizeFor).toBe(2);
    expect(SETTING_TIERS.enableOrchestration).toBe(3);
    expect(settingTier('name')).toBeUndefined();
    expect(settingTier('toString')).toBeUndefined();
  });

  it('gives every key a default and a row title', () => {
    for (const key of tiered) {
      expect(Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key), key).toBe(true);
      expect(SETTING_ROWS[key].title, key).toBeTruthy();
    }
  });
});

describe('direction rules (design §3.2)', () => {
  const rows: Array<[TieredSettingKey, unknown, unknown, boolean]> = [
    ['enableOrchestration', true, false, false],
    ['enableOrchestration', false, true, true],
    ['subagentBlockedProviders', [], ['codex'], false],
    ['subagentBlockedProviders', ['codex'], ['codex', 'kimi'], false],
    ['subagentBlockedProviders', ['codex', 'kimi'], ['kimi'], true],
    ['subagentBlockedProviders', ['codex'], ['kimi'], true],
    ['subagentBlockedProviders', ['codex'], [], true],
    ['defaultPermissionMode', 'auto', 'plan', false],
    ['defaultPermissionMode', 'bypassPermissions', 'default', false],
    ['defaultPermissionMode', 'plan', 'default', false],
    ['defaultPermissionMode', 'default', 'acceptEdits', true],
    ['defaultPermissionMode', 'plan', 'auto', true],
    ['defaultPermissionMode', 'acceptEdits', 'dontAsk', true],
    ['defaultPermissionMode', 'dontAsk', 'acceptEdits', true],
    ['defaultPermissionMode', 'auto', 'bypassPermissions', true],
    ['cardFreeTaskCreates', 8, 3, false],
    ['cardFreeTaskCreates', 8, 0, false],
    ['cardFreeTaskCreates', null, 0, false],
    ['cardFreeTaskCreates', 20, null, false],
    ['cardFreeTaskCreates', 3, 8, true],
    ['cardFreeTaskCreates', 0, 1, true],
    ['cardFreeTaskCreates', null, 9, true],
    ['cardFreeTaskCreates', 3, null, true],
  ];
  for (const [key, from, to, widens] of rows) {
    it(`${key} ${JSON.stringify(from)} → ${JSON.stringify(to)} ${widens ? 'widens' : 'narrows'}`, () => {
      expect(widensAgentReach(key, from, to)).toBe(widens);
    });
  }

  it('never widens a tier 1 or tier 2 key', () => {
    for (const key of [...SETTING_TIER_KEYS[1], ...SETTING_TIER_KEYS[2]]) {
      expect(widensAgentReach(key, false, true), key).toBe(false);
    }
  });

  it('judges an absent value by its default', () => {
    expect(settingValueInForce('enableOrchestration', {})).toBe(true);
    expect(settingValueInForce('defaultPermissionMode', {})).toBe('auto');
    expect(settingValueInForce('enableOrchestration', { enableOrchestration: false })).toBe(false);
    expect(settingValueInForce('subagentBlockedProviders', {})).toEqual([]);
    expect(settingValueInForce('cardFreeTaskCreates', {})).toBe(8);
    expect(settingValueInForce('cardFreeTaskCreates', { cardFreeTaskCreates: 0 })).toBe(0);
  });
});

describe('the SETTING_OWNER_ONLY body (design §6)', () => {
  it('names the refused key with its Settings row and link', () => {
    expect(settingOwnerOnlyBody(['enableOrchestration'])).toEqual({
      code: 'SETTING_OWNER_ONLY',
      message: '"Let sessions orchestrate" gives agents more reach; only you can turn it on, in Settings.',
      settings: [{
        key: 'enableOrchestration',
        title: 'Let sessions orchestrate',
        path: '/settings/general',
        link: 'orbit-settings:enableOrchestration',
      }],
    });
  });

  it('names every refused key', () => {
    const body = settingOwnerOnlyBody(['defaultPermissionMode', 'subagentBlockedProviders']);
    expect(body.settings.map((s) => [s.key, s.title, s.path])).toEqual([
      ['defaultPermissionMode', PERSONAL_SETTINGS.defaultPermissionMode.title, '/settings/general'],
      ['subagentBlockedProviders', 'SubAgent providers', null],
    ]);
    expect(body.message).toBe(
      'These changes give agents more reach; only you can make them, in Settings: "Default permission mode", "SubAgent providers".',
    );
  });
});

it('titles the card by its count', () => {
  expect(settingsChangeTitle(1)).toBe('Change 1 setting?');
  expect(settingsChangeTitle(2)).toBe('Change 2 settings?');
});
