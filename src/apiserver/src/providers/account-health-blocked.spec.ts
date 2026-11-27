import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, type RunnerEngineHealth } from '@orbit/shared';
import type { RoutingHealthEntry } from '../tasks/model-routing';
import type { AccountRunner } from './account';
import { subjectKey } from './account-health';
import { accountBlockOf, runnerWithHealth, withoutBlocked } from './account-health-blocked';
import {
  accountAfterUsageLimit,
  accountAfterUsageLimitAt,
  accountBeforeDispatch,
  accountSwitchNotice,
  automaticAccount,
  changedPlans,
} from './plan-usage-accounts';

/**
 * Automatic's account choice inside one engine reads account health (docs/routing-account-health-design.md §7.6): a
 * blocked account is passed over as a paused one is, so a runner with two Cursor accounts moves to the second; with
 * every account blocked the choice is made as it was before health. And a usage reading whose plan changed is what
 * makes a blocked account's trial due (§6.3).
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '3fa91c2e';
const NOW = new Date('2026-11-23T10:00:00Z');
const LATER = NOW.getTime() + 60 * 60_000;
const RESET = '2099-01-01T08:00:00Z';

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.cursor', auth: 'yes' },
      { id: SECOND, name: 'Second', home: `/root/.orbit/cursor-accounts/${SECOND}`, auth: 'yes' },
    ],
  },
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
      { id: SECOND, name: 'Second', home: `/root/.orbit/codex-accounts/${SECOND}`, codexHome: `/root/.orbit/codex-accounts/${SECOND}`, auth: 'yes' },
    ],
  },
];

const AUTOMATIC = { env: null, cursorAccount: null, codexAccount: null };
const NAMED = { engines: ENGINES, accountNames: null };

const entry = (
  engine: string,
  account: string,
  state: RoutingHealthEntry['state'] = 'blocked',
  extra: Partial<RoutingHealthEntry> = {},
): [string, RoutingHealthEntry[]] => {
  const subject = subjectKey({ type: 'runner', runnerId: RUNNER_ID, engine, account });
  return [subject, [{
    state, model: null, kind: 'ACCOUNT_ACTION_REQUIRED', said: 'Add a payment method to continue',
    since: NOW.getTime() - 60_000, last: NOW.getTime() - 60_000, until: LATER, trips: 1, subject, ...extra,
  }]];
};

/** The runner as the account helpers read it, with what health says of its accounts. */
const runner = (
  health: Array<[string, RoutingHealthEntry[]]> = [],
  extra: Partial<AccountRunner> = {},
): AccountRunner =>
  runnerWithHealth({ engines: ENGINES, defaultRemoved: [], accountPauses: null, planUsage: null, ...extra }, RUNNER_ID, new Map(health), NOW);

test('Automatic starts a new session on the second account while health blocks the first, as it would were the first paused', () => {
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner(), NOW), 'default', 'with nothing blocked, Default');
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default')]), NOW), SECOND);
  const paused = runner([], { accountPauses: { cursor: { default: new Date(LATER).toISOString() } } });
  assert.equal(automaticAccount('cursor', AUTOMATIC, paused, NOW), SECOND, 'the paused case it mirrors');
  // A cool-down and a trial another run holds take the account out too; a suspect one and a due trial do not.
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'cooldown', { kind: 'USAGE_LIMIT' })]), NOW), SECOND);
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'trial-running')]), NOW), SECOND);
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'suspect')]), NOW), 'default');
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'trial-due')]), NOW), 'default');
  // An entry about one model leaves the account in; so does a block on another engine's account, or another runner's.
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'blocked', { model: 'gpt-5' })]), NOW), 'default');
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('codex', 'default')]), NOW), 'default');
  const elsewhere = runnerWithHealth(
    { engines: ENGINES, defaultRemoved: [], accountPauses: null, planUsage: null },
    '22222222-2222-4222-8222-222222222222',
    new Map([entry('cursor', 'default')]),
    NOW,
  );
  assert.equal(automaticAccount('cursor', AUTOMATIC, elsewhere, NOW), 'default');
  // A block that has run out is no block.
  assert.equal(automaticAccount('cursor', AUTOMATIC, runner([entry('cursor', 'default', 'blocked', { until: NOW.getTime() })]), NOW), 'default');
});

test('with every account blocked, Automatic picks as it did before health', () => {
  const both = runner([entry('cursor', 'default'), entry('cursor', SECOND, 'blocked', { until: LATER + 60_000 })]);
  assert.equal(automaticAccount('cursor', AUTOMATIC, both, NOW), 'default');
  assert.equal(accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, both, NOW), null);
  // The second account signed out leaves nowhere healthy to go: the same.
  const signedOut = ENGINES.map((engine) => engine.engine !== 'cursor' ? engine : {
    ...engine, accounts: engine.accounts!.map((account) => account.id === SECOND ? { ...account, auth: 'no' as const } : account),
  });
  const alone = runner([entry('cursor', 'default')], { engines: signedOut });
  assert.equal(accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, alone, NOW), null);
});

test('a session on Automatic leaves a blocked account before its turn goes out, unless it or its workspace decides', () => {
  const blocked = runner([entry('cursor', 'default')]);
  assert.deepEqual(
    accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, blocked, NOW),
    { from: 'default', to: SECOND, blocked: 'needs-action' },
  );
  assert.deepEqual(
    accountBeforeDispatch('cursor', { account: null }, AUTOMATIC, blocked, NOW),
    { from: 'default', to: SECOND, blocked: 'needs-action' },
    'an older session that picked no account runs on Default, and moves the same',
  );
  // Picked by hand, or by its workspace: it stays, and the account's own refusal or trial answers.
  assert.equal(accountBeforeDispatch('cursor', { account: 'default', pinned: true }, AUTOMATIC, blocked, NOW), null);
  assert.equal(accountBeforeDispatch('cursor', { account: 'default' }, { env: null, cursorAccount: 'default' }, blocked, NOW), null);
  // On the healthy account, nothing moves; and a runner read without health moves nothing.
  assert.equal(accountBeforeDispatch('cursor', { account: SECOND }, AUTOMATIC, blocked, NOW), null);
  assert.equal(accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, runner(), NOW), null);
  // A pause is still said as the pause, ahead of a block.
  const both = runner([entry('cursor', 'default')], { accountPauses: { cursor: { default: new Date(LATER).toISOString() } } });
  assert.deepEqual(accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, both, NOW), { from: 'default', to: SECOND, paused: true });
  // Why it left, by what health says.
  assert.equal(
    accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, runner([entry('cursor', 'default', 'blocked', { kind: 'UNCLASSIFIED_ADMISSION' })]), NOW)?.blocked,
    'failing',
  );
  assert.equal(accountBeforeDispatch('cursor', { account: 'default' }, AUTOMATIC, runner([entry('cursor', 'default', 'trial-running')]), NOW)?.blocked, 'trial');
});

test("a usage limit's move never lands on a blocked account, and its retry waits for the block to end", () => {
  const defaultSpent = { codex: { provider: AgentProvider.CODEX, primary: { utilization: 100, resetsAt: RESET, windowDurationMins: 300 } } };
  const healthy = runner([], { planUsage: defaultSpent });
  assert.deepEqual(accountAfterUsageLimit('codex', { account: 'default' }, AUTOMATIC, healthy, NOW), { from: 'default', to: SECOND });
  assert.equal(accountAfterUsageLimitAt('codex', { account: 'default' }, AUTOMATIC, healthy, NOW)?.getTime(), NOW.getTime());
  const secondBlocked = runner([entry('codex', SECOND)], { planUsage: defaultSpent });
  assert.equal(accountAfterUsageLimit('codex', { account: 'default' }, AUTOMATIC, secondBlocked, NOW), null);
  assert.equal(accountAfterUsageLimitAt('codex', { account: 'default' }, AUTOMATIC, secondBlocked, NOW)?.getTime(), LATER);
});

test('the line a session moved off a blocked account carries says why in health’s words, never "paused"', () => {
  const said = (blocked: 'needs-action' | 'failing' | 'usage-limit' | 'trial') =>
    accountSwitchNotice('cursor', { from: 'default', to: SECOND, blocked }, NAMED);
  assert.equal(said('needs-action'), 'Switched to Second — Default needs action');
  assert.equal(said('failing'), 'Switched to Second — Default failed to start its last runs');
  assert.equal(said('trial'), 'Switched to Second — Default is being tried by another run');
  assert.equal(said('usage-limit'), 'Switched to Second — the usage limit on Default is reached');
  for (const reason of ['needs-action', 'failing', 'usage-limit', 'trial'] as const) assert.doesNotMatch(said(reason), /paused/);
});

test('only an entry on the whole account in a removing state blocks it, and a choice whose every member is out keeps them all', () => {
  const [, [blocked]] = entry('cursor', 'default');
  assert.deepEqual(accountBlockOf([blocked]), { until: LATER, reason: 'needs-action' });
  assert.deepEqual(accountBlockOf([{ ...blocked, state: 'cooldown', kind: 'USAGE_LIMIT' }]), { until: LATER, reason: 'usage-limit' });
  assert.equal(accountBlockOf([{ ...blocked, model: 'claude-opus-5-5' }]), null);
  assert.equal(accountBlockOf([{ ...blocked, state: 'suspect' }]), null);
  assert.equal(accountBlockOf([{ ...blocked, state: 'trial-due' }]), null);
  assert.equal(accountBlockOf(undefined), null);

  const members = [{ id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'c', ok: false }];
  const out = (ids: string[]) => (member: { id: string }) => ids.includes(member.id);
  const canRun = (member: { ok: boolean }) => member.ok;
  assert.deepEqual(withoutBlocked(members, out(['a']), canRun).map((m) => m.id), ['b', 'c']);
  assert.deepEqual(withoutBlocked(members, out(['a', 'b']), canRun).map((m) => m.id), ['a', 'b', 'c'], 'only one that cannot run is left');
  assert.deepEqual(withoutBlocked(members, out([]), canRun), members);
});

test('a usage reading whose plan differs from the last names the account whose trial is due; an unknown plan names none', () => {
  const cursor = (plan: string | undefined, second?: string) => ({
    cursor: {
      provider: AgentProvider.CURSOR, account: 'default', ...(plan ? { planName: plan } : {}),
      ...(second ? { accounts: { [SECOND]: { provider: AgentProvider.CURSOR, account: SECOND, planName: second } } } : {}),
    },
  });
  assert.deepEqual(changedPlans(cursor('Free'), cursor('Pro')), [{ engine: 'cursor', account: 'default' }]);
  assert.deepEqual(changedPlans(cursor('Pro', 'Free'), cursor('Pro', 'Pro')), [{ engine: 'cursor', account: SECOND }]);
  assert.deepEqual(changedPlans(cursor('Pro'), cursor('Pro')), [], 'the same plan');
  assert.deepEqual(changedPlans(cursor(undefined), cursor('Pro')), [], 'no plan known before');
  assert.deepEqual(changedPlans(cursor('Pro'), cursor(undefined)), [], 'none named now');
  assert.deepEqual(changedPlans(null, cursor('Pro')), [], 'a first reading');
  // Codex names it planType, in a nested snapshot or an older runner's lone one.
  const codex = (planType: string) => ({ codex: { provider: AgentProvider.CODEX, planType, primary: { utilization: 5, resetsAt: RESET } } });
  assert.deepEqual(changedPlans(codex('plus'), codex('pro')), [{ engine: 'codex', account: 'default' }]);
  assert.deepEqual(
    changedPlans({ provider: AgentProvider.CODEX, planType: 'plus' }, { provider: AgentProvider.CODEX, planType: 'pro' }),
    [{ engine: 'codex', account: 'default' }],
  );
});
