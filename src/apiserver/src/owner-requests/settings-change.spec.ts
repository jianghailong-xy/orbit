import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTING_DEFAULTS, settingOwnerOnlyBody } from '@orbit/shared';
import { DEFAULT_PERMISSION_MODE } from '../common/permission-mode';
import { DEFAULT_CARD_FREE_TASK_CREATES } from '../runner-api/session-create-allowance';
import { ownerRequestAlert, ownerRequestPushCategory } from './owner-request';
import {
  SettingsProposalInvalid,
  sameSettingsChanges,
  settingsChangeDeclinedMessage,
  settingsChangeEntries,
  validateSettingsChanges,
  wideningKeys,
} from './settings-change';

/** What the route decides for a proposal against these preferences: the changes it would file, or the keys it refuses. */
async function judge(preferences: Record<string, unknown>, changes: Record<string, unknown>) {
  const entries = settingsChangeEntries(preferences, await validateSettingsChanges(changes));
  return { entries, refused: wideningKeys(entries) };
}

test('the shared default permission mode is the server’s floor', () => {
  assert.equal(SETTING_DEFAULTS.defaultPermissionMode, DEFAULT_PERMISSION_MODE);
});

test('enableOrchestration: turning it off may be proposed, turning it on is the owner’s', async () => {
  const off = await judge({}, { enableOrchestration: false });
  assert.deepEqual(off.entries, [{ key: 'enableOrchestration', from: true, to: false, tier: 3 }]);
  assert.deepEqual(off.refused, []);
  const on = await judge({ enableOrchestration: false }, { enableOrchestration: true });
  assert.deepEqual(on.entries, [{ key: 'enableOrchestration', from: false, to: true, tier: 3 }]);
  assert.deepEqual(on.refused, ['enableOrchestration']);
});

test('subagentBlockedProviders: adding providers may be proposed, removing any is the owner’s', async () => {
  const add = await judge({ subagentBlockedProviders: ['codex'] }, { subagentBlockedProviders: ['codex', 'kimi', 'kimi'] });
  assert.deepEqual(add.entries, [{ key: 'subagentBlockedProviders', from: ['codex'], to: ['codex', 'kimi'], tier: 3 }]);
  assert.deepEqual(add.refused, []);
  const fromNone = await judge({}, { subagentBlockedProviders: ['codex'] });
  assert.deepEqual(fromNone.refused, []);
  const remove = await judge({ subagentBlockedProviders: ['codex', 'kimi'] }, { subagentBlockedProviders: ['kimi'] });
  assert.deepEqual(remove.refused, ['subagentBlockedProviders']);
  const swap = await judge({ subagentBlockedProviders: ['codex'] }, { subagentBlockedProviders: ['kimi'] });
  assert.deepEqual(swap.refused, ['subagentBlockedProviders'], 'adding one while removing another still widens');
});

test('defaultPermissionMode: plan or default may be proposed, any other mode is the owner’s', async () => {
  for (const to of ['plan', 'default']) {
    const { entries, refused } = await judge({}, { defaultPermissionMode: to });
    assert.deepEqual(entries, [{ key: 'defaultPermissionMode', from: 'auto', to, tier: 3 }]);
    assert.deepEqual(refused, [], to);
  }
  for (const to of ['acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']) {
    const { refused } = await judge({ defaultPermissionMode: 'plan' }, { defaultPermissionMode: to });
    assert.deepEqual(refused, ['defaultPermissionMode'], to);
  }
});

test('the shared default of cardFreeTaskCreates is the server’s', () => {
  assert.equal(SETTING_DEFAULTS.cardFreeTaskCreates, DEFAULT_CARD_FREE_TASK_CREATES);
});

test('cardFreeTaskCreates: lowering it, to 0 too, may be proposed, raising it is the owner’s', async () => {
  const lower = await judge({}, { cardFreeTaskCreates: 0 });
  assert.deepEqual(lower.entries, [{ key: 'cardFreeTaskCreates', from: 8, to: 0, tier: 3 }]);
  assert.deepEqual(lower.refused, []);
  assert.deepEqual((await judge({ cardFreeTaskCreates: 20 }, { cardFreeTaskCreates: 5 })).refused, []);
  const raise = await judge({ cardFreeTaskCreates: 3 }, { cardFreeTaskCreates: 8 });
  assert.deepEqual(raise.entries, [{ key: 'cardFreeTaskCreates', from: 3, to: 8, tier: 3 }]);
  assert.deepEqual(raise.refused, ['cardFreeTaskCreates']);
  assert.deepEqual((await judge({}, { cardFreeTaskCreates: 9 })).refused, ['cardFreeTaskCreates']);
  assert.deepEqual((await judge({}, { cardFreeTaskCreates: 8 })).entries, []);
});

test('a mixed proposal is judged per key and refused whole when any key widens', async () => {
  const narrowing = await judge(
    { theme: 'dark' },
    { theme: 'light', translationEnabled: true, defaultEffort: 'high', enableOrchestration: false, defaultPermissionMode: 'plan' },
  );
  assert.deepEqual(narrowing.entries.map((e) => [e.key, e.tier]), [
    ['theme', 1], ['translationEnabled', 1], ['defaultEffort', 2], ['enableOrchestration', 3], ['defaultPermissionMode', 3],
  ]);
  assert.deepEqual(narrowing.refused, []);

  const widening = await judge(
    { enableOrchestration: false, subagentBlockedProviders: ['codex'] },
    { theme: 'light', enableOrchestration: true, subagentBlockedProviders: [], defaultPermissionMode: 'default' },
  );
  assert.deepEqual(widening.refused, ['enableOrchestration', 'subagentBlockedProviders']);
  const body = settingOwnerOnlyBody(widening.refused);
  assert.equal(body.code, 'SETTING_OWNER_ONLY');
  assert.deepEqual(body.settings.map((s) => s.link), ['orbit-settings:enableOrchestration', 'orbit-settings:subagentBlockedProviders']);
});

test('a change to what is already in force is dropped, an absent value read as its default', async () => {
  const { entries } = await judge(
    { theme: 'dark', subagentBlockedProviders: ['kimi', 'codex'] },
    { theme: 'dark', enableOrchestration: true, recaps: true, subagentBlockedProviders: ['codex', 'kimi'], promptOptimizer: false },
  );
  assert.deepEqual(entries, [{ key: 'promptOptimizer', from: true, to: false, tier: 1 }]);
});

test('defaultModels merges the providers it names into the map in force', async () => {
  const prefs = { defaultModels: { 'claude:claude': 'opus', 'codex:codex': 'gpt' } };
  const { entries } = await judge(prefs, { defaultModels: { 'codex:codex': 'gpt-mini' } });
  assert.deepEqual(entries, [{
    key: 'defaultModels',
    from: { 'claude:claude': 'opus', 'codex:codex': 'gpt' },
    to: { 'claude:claude': 'opus', 'codex:codex': 'gpt-mini' },
    tier: 2,
  }]);
  assert.deepEqual((await judge(prefs, { defaultModels: { 'claude:claude': 'opus' } })).entries, []);
});

test('values are held to the PATCH’s rules, and only tiered keys may be named', async () => {
  const refused = async (changes: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(validateSettingsChanges(changes), (e) => e instanceof SettingsProposalInvalid && pattern.test(e.message));
  await refused({}, /names no setting/);
  await refused({ name: 'Mallory' }, /not a setting.*name/);
  await refused({ theme: 'purple' }, /theme/);
  await refused({ defaultPermissionMode: 'yolo' }, /defaultPermissionMode/);
  await refused({ translationLanguage: 'xx' }, /translationLanguage/);
  await refused({ enableOrchestration: 'yes' }, /enableOrchestration/);
  await refused({ defaultModels: { claude: 1 } }, /defaultModels/);
  await refused({ subagentBlockedProviders: 'codex' }, /subagentBlockedProviders/);
  await refused({ theme: null }, /give each setting a value: theme/);
  assert.deepEqual(await validateSettingsChanges({ optimizeFor: 'cost' }), { optimizeFor: 'cost' });
});

test('a declined card blocks exactly the same keys and new values', async () => {
  const { entries } = await judge({}, { translationEnabled: true, translationLanguage: 'ja' });
  const declined = { changes: [
    { key: 'translationLanguage', from: 'en', to: 'ja', tier: 1 },
    { key: 'translationEnabled', from: false, to: true, tier: 1 },
  ] };
  assert.equal(sameSettingsChanges(declined, entries), true, 'from is not compared, order is not');
  assert.equal(sameSettingsChanges({ changes: [declined.changes[1]] }, entries), false, 'fewer keys');
  assert.equal(sameSettingsChanges({ changes: [declined.changes[1], { ...declined.changes[0], to: 'ko' }] }, entries), false);
  assert.equal(sameSettingsChanges(null, entries), false);
  assert.equal(
    settingsChangeDeclinedMessage(new Date('2026-11-19T23:00:00Z'), 'Not now.'),
    'The owner declined this change on 2026-11-19; ask the person instead of filing it again. Their reason: Not now.',
  );
});

test('the card is alerted as a settings confirmation', () => {
  assert.deepEqual(ownerRequestAlert('SETTINGS_CHANGE', 'Change 2 settings?'), { title: 'Confirm settings', body: 'Change 2 settings?' });
  assert.equal(ownerRequestPushCategory('SETTINGS_CHANGE'), 'ORBIT_OWNER_REQUEST_SETTINGS_CHANGE');
});
