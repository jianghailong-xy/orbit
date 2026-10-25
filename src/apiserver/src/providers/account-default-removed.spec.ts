import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNT_DIR_VAR,
  AgentProvider,
  accountToStartOn,
  planUsageBlockedUntil,
  type AccountEngine,
  type PlanUsage,
  type PlanUsageSnapshot,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { signedOutEngineRefusal } from '../sessions/engine-signin-preflight';
import { accountOnRunner, defaultRemovedOn, type AccountRunner } from './account';
import { resolveProviderExec } from './custom-provider';
import {
  accountAfterUsageLimit,
  accountAfterUsageLimitAt,
  accountBeforeDispatch,
  accountSwitchNotice,
  automaticAccount,
  onRemovedDefault,
  runAccount,
  sessionAccountPausedUntil,
  workspaceLeavesAccountToOrbit,
} from './plan-usage-accounts';

/**
 * A runner's Default its owner removed from Orbit (runner.default_removed) is used by no account reader
 * while the runner reports another account of that engine: Automatic's pick is among the accounts that
 * remain — the only one too — and every fallback that landed on Default lands on that pick; a session on
 * Default moves to it before its next turn, pinned or not; dispatch hands it that account's directory;
 * and the quota gate, the pause check and the sign-in preflight judge that same account. With no other
 * account reported, every answer is the one it was before Default could be removed.
 */

const NOW = new Date('2026-10-21T08:00:00Z');
// Resets far enough out that dispatch, which judges quota on the real clock, finds them ahead too.
const SOON = '2099-01-01T09:00:00.000Z';
const LATER = '2099-01-01T12:00:00.000Z';
const WEEK = '2099-01-07T08:00:00.000Z';
const WORK = '3fa91c2e';
const TEAM = '7b02d9e1';
const GONE = 'c0ffee42';
const home = (engine: string, id: string) => (id === 'default' ? `/root/.${engine}` : `/root/.orbit/${engine}-accounts/${id}`);

/** `engine` as a runner reports it: Default and `others`, each signed in unless `signedOut` names it. */
function report(engine: AccountEngine, others: string[] = [WORK], signedOut: string[] = []): RunnerEngineHealth {
  return {
    engine,
    installed: true,
    auth: signedOut.includes('default') ? 'no' : 'yes',
    accounts: ['default', ...others].map((id) => ({
      id,
      ...(id === WORK ? { name: 'Work' } : id === TEAM ? { name: 'Team' } : {}),
      home: home(engine, id),
      ...(engine === 'codex' ? { codexHome: home(engine, id) } : {}),
      auth: signedOut.includes(id) ? ('no' as const) : ('yes' as const),
    })),
  };
}

/** One window `used`% consumed, resetting at `resetsAt`. */
const window = (used: number, resetsAt: string) => ({ utilization: used, resetsAt, windowDurationMins: 300 });

/** Codex's snapshot: Default's own window, and each other account's under `accounts`. */
function codexUsage(defaultUsed: number, others: Record<string, [number, string]>): PlanUsage {
  const accounts: Record<string, PlanUsageSnapshot> = {};
  for (const [id, [used, resetsAt]] of Object.entries(others)) {
    accounts[id] = { provider: AgentProvider.CODEX, primary: window(used, resetsAt) };
  }
  return { codex: { provider: AgentProvider.CODEX, primary: window(defaultUsed, WEEK), accounts } } as PlanUsage;
}

/** A runner as the account helpers read it. */
function runner(
  engines: RunnerEngineHealth[],
  options: { removed?: string[]; planUsage?: unknown; pauses?: unknown } = {},
): AccountRunner & { accountNames: unknown } {
  return {
    engines,
    defaultRemoved: options.removed ?? ['codex'],
    accountPauses: options.pauses ?? null,
    planUsage: options.planUsage ?? null,
    accountNames: null,
  };
}

/** The env a built-in session of `engine` is dispatched with (resolveProviderExec). */
function dispatchEnv(
  engine: AccountEngine,
  on: AccountRunner,
  account: string | null,
  workspaceEnv: Record<string, string> | null = null,
): Record<string, string> | undefined {
  return resolveProviderExec({
    engine: engine as AgentProvider,
    declaredProvider: engine,
    declaredProviderBuiltin: true,
    customRow: null,
    sessionModel: engine === 'cursor' ? 'default[]' : null,
    workspaceEnv,
    [`${engine}Account`]: account,
    runner: on,
  }).env;
}

test('a new session on Automatic starts on the one account left, even one that is spent or has the less room', () => {
  // Default has all the room there is, Work's window is spent: with Default removed Work is still where
  // it starts — there is nowhere else.
  const usage = codexUsage(0, { [WORK]: [100, SOON] });
  const on = runner([report('codex')], { planUsage: usage });
  assert.equal(defaultRemovedOn('codex', on), true);
  assert.equal(automaticAccount('codex', { env: null }, on, NOW), WORK);
  assert.equal(automaticAccount('codex', null, on, NOW), WORK, 'a session with no workspace');
  // Before the removal the same runner starts it on Default, which has room.
  assert.equal(automaticAccount('codex', { env: null }, runner([report('codex')], { removed: [], planUsage: usage }), NOW), 'default');
});

test('a new session on Automatic starts on the remaining account Automatic ranks first, never on Default', () => {
  // Work resets first, so its quota is spent first; Team's resets later.
  const usage = codexUsage(0, { [WORK]: [40, SOON], [TEAM]: [10, LATER] });
  const on = runner([report('codex', [WORK, TEAM])], { planUsage: usage });
  assert.equal(automaticAccount('codex', { env: null }, on, NOW), WORK);
  // Work spent: Team.
  const workSpent = runner([report('codex', [WORK, TEAM])], { planUsage: codexUsage(0, { [WORK]: [100, SOON], [TEAM]: [10, LATER] }) });
  assert.equal(automaticAccount('codex', { env: null }, workSpent, NOW), TEAM);
  // Work signed out: Team.
  const workOut = runner([report('codex', [WORK, TEAM], [WORK])], { planUsage: usage });
  assert.equal(automaticAccount('codex', { env: null }, workOut, NOW), TEAM);
});

test('with every remaining account spent, or paused, the pick is the first to free up — never Default', () => {
  // Both spent, Team back first; Default, with room, is not a candidate.
  const spent = runner([report('codex', [WORK, TEAM])], { planUsage: codexUsage(0, { [WORK]: [100, LATER], [TEAM]: [100, SOON] }) });
  assert.equal(automaticAccount('codex', { env: null }, spent, NOW), TEAM);
  assert.equal(runAccount('codex', null, { codexAccount: null }, spent, NOW), TEAM);
  assert.equal(dispatchEnv('codex', spent, null)?.CODEX_HOME, home('codex', TEAM));
  // Both paused by hand, Work back first.
  const pauses = { codex: { [WORK]: SOON, [TEAM]: LATER } };
  const paused = runner([report('codex', [WORK, TEAM])], { pauses });
  assert.equal(automaticAccount('codex', { env: null }, paused, NOW), WORK);
  assert.deepEqual(
    sessionAccountPausedUntil({ provider: 'codex', providerBuiltin: true, codexAccount: 'default' }, null, paused, NOW),
    new Date(SOON),
    'the session waits for the account it is moved to',
  );
  // The only one left, and paused: that one, where the session waits.
  const onePaused = runner([report('codex')], { pauses: { codex: { [WORK]: LATER } } });
  assert.equal(automaticAccount('codex', { env: null }, onePaused, NOW), WORK);
  // Every remaining one signed out: the first of them, whose sign-in the session waits on.
  const signedOut = runner([report('codex', [WORK, TEAM], [WORK, TEAM])]);
  assert.equal(automaticAccount('codex', { env: null }, signedOut, NOW), WORK);
  // The same answers from the shared choice the New Session screen asks.
  const accounts = report('codex', [WORK, TEAM]).accounts;
  assert.equal(accountToStartOn('codex', accounts, codexUsage(0, { [WORK]: [100, LATER], [TEAM]: [100, SOON] }), NOW, { defaultRemoved: true }), TEAM);
  assert.equal(accountToStartOn('codex', accounts?.slice(0, 1), null, NOW, { defaultRemoved: true }), null, 'nothing remains');
});

test('every fallback that landed on Default lands on the pick, and dispatch hands over its directory', () => {
  const on = runner([report('codex')]);
  // No pick, a pick of Default, a slot the runner no longer reports.
  for (const pick of [null, undefined, 'default', GONE]) {
    assert.equal(runAccount('codex', null, { codexAccount: pick }, on, NOW), WORK, String(pick));
    assert.equal(accountOnRunner('codex', pick, on, null, NOW)?.id, WORK, String(pick));
    assert.deepEqual(dispatchEnv('codex', on, pick ?? null, { FOO: 'bar' }), { FOO: 'bar', CODEX_HOME: home('codex', WORK) }, String(pick));
  }
  // A workspace env that names Default's own directory is Default too.
  assert.equal(dispatchEnv('codex', on, null, { CODEX_HOME: '/root/.codex' })?.CODEX_HOME, home('codex', WORK));
  // A directory the workspace's env names is the user's own setting, and so is a key of its own.
  assert.deepEqual(dispatchEnv('codex', on, null, { CODEX_HOME: '/srv/elsewhere' }), { CODEX_HOME: '/srv/elsewhere' });
  assert.equal(runAccount('codex', { CODEX_HOME: '/srv/elsewhere' }, { codexAccount: null }, on, NOW), null);
  assert.deepEqual(dispatchEnv('codex', on, null, { CODEX_API_KEY: 'sk-test' }), { CODEX_API_KEY: 'sk-test' });
  assert.equal(runAccount('codex', { CODEX_API_KEY: 'sk-test' }, { codexAccount: null }, on, NOW), null);
  // An account it picked that the runner reports is where it runs, as ever.
  assert.equal(dispatchEnv('codex', on, WORK)?.CODEX_HOME, home('codex', WORK));
});

test('every engine that keeps accounts leaves its removed Default out the same way', () => {
  for (const engine of ['claude', 'codex', 'antigravity', 'kimi', 'cursor'] as const) {
    const on = runner([report(engine)], { removed: [engine] });
    assert.equal(automaticAccount(engine, { env: null }, on, NOW), WORK, engine);
    assert.equal(runAccount(engine, null, { [`${engine}Account`]: 'default' }, on, NOW), WORK, engine);
    assert.equal(dispatchEnv(engine, on, null)?.[ACCOUNT_DIR_VAR[engine]], home(engine, WORK), engine);
    // Removing one engine's Default leaves every other engine's in use.
    const otherRemoved = runner([report(engine)], { removed: [engine === 'codex' ? 'claude' : 'codex'] });
    assert.equal(dispatchEnv(engine, otherRemoved, null)?.[ACCOUNT_DIR_VAR[engine]], undefined, engine);
  }
});

test('the quota gate judges the account dispatch runs the session on, not Default', () => {
  const defaultSpent = codexUsage(100, { [WORK]: [20, SOON] });
  const workSpent = codexUsage(0, { [WORK]: [100, SOON] });
  for (const pick of [null, 'default']) {
    const account = (usage: PlanUsage) => runAccount('codex', null, { codexAccount: pick }, runner([report('codex')], { planUsage: usage }), NOW);
    assert.equal(planUsageBlockedUntil(defaultSpent, 'codex', NOW, account(defaultSpent)), null, "Default's spent window holds nothing back");
    assert.deepEqual(planUsageBlockedUntil(workSpent, 'codex', NOW, account(workSpent)), new Date(SOON), 'it waits for Work');
  }
});

test('a workspace that picked nothing, or Default, leaves the account to Orbit; one whose env names a directory does not', () => {
  const on = runner([report('codex')]);
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: null }, on), true);
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: null, codexAccount: 'default' }, on), true);
  assert.equal(automaticAccount('codex', { env: null, codexAccount: 'default' }, on, NOW), WORK);
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: null, codexAccount: WORK }, on), false);
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: { CODEX_HOME: '/srv/elsewhere' } }, on), false);
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: { CODEX_API_KEY: 'sk-test' } }, on), false);
  // A workspace set to Default while Default is in use decides, as it always did.
  assert.equal(workspaceLeavesAccountToOrbit('codex', { env: null, codexAccount: 'default' }, runner([report('codex')], { removed: [] })), false);
});

test('a session on Default moves to the pick before its next turn: picked by hand, pinned, set by its workspace, or with no account', () => {
  const on = runner([report('codex', [WORK, TEAM])], { planUsage: codexUsage(0, { [WORK]: [30, SOON], [TEAM]: [10, LATER] }) });
  const moved = { from: 'default', to: WORK, defaultRemoved: true };
  // Default picked by hand, and pinned there.
  assert.deepEqual(accountBeforeDispatch('codex', { account: 'default', pinned: true }, { env: null }, on, NOW), moved);
  assert.deepEqual(accountBeforeDispatch('codex', { account: 'default', pinned: false }, { env: null }, on, NOW), moved);
  // Following a workspace set to Default.
  assert.deepEqual(accountBeforeDispatch('codex', { account: null }, { env: null, codexAccount: 'default' }, on, NOW), moved);
  // A session from before accounts, with none: Default by the report.
  assert.deepEqual(accountBeforeDispatch('codex', { account: null }, { env: null }, on, NOW), moved);
  assert.deepEqual(accountBeforeDispatch('codex', { account: null }, null, on, NOW), moved);
  // On a slot the runner no longer reports, it ran on Default.
  assert.deepEqual(accountBeforeDispatch('codex', { account: GONE, pinned: true }, { env: null }, on, NOW), moved);
  // A usage limit met there — a turn that ran on Default before it was removed — moves it the same way.
  assert.deepEqual(accountAfterUsageLimit('codex', { account: 'default', pinned: true }, { env: null }, on, NOW), moved);
  // Not on Default: on Work, following a workspace set to Work, or in a directory its env names.
  assert.equal(accountBeforeDispatch('codex', { account: WORK, pinned: true }, { env: null }, on, NOW), null);
  assert.equal(accountBeforeDispatch('codex', { account: null }, { env: null, codexAccount: WORK }, on, NOW), null);
  assert.equal(accountBeforeDispatch('codex', { account: null }, { env: { CODEX_HOME: '/srv/elsewhere' } }, on, NOW), null);
  // The detectors the claim, the inbox and the switch read agree.
  const session = (codexAccount: string | null) => ({ provider: 'codex', providerBuiltin: true, codexAccount });
  assert.equal(onRemovedDefault(session('default'), { env: null }, on), true);
  assert.equal(onRemovedDefault(session(null), { env: null }, on), true);
  assert.equal(onRemovedDefault(session(null), { env: null, codexAccount: 'default' }, on), true);
  assert.equal(onRemovedDefault(session(WORK), { env: null }, on), false);
  assert.equal(onRemovedDefault({ ...session('default'), providerBuiltin: false }, { env: null }, on), false);
});

test('with every remaining account spent, a session on Default still moves — to the first to free up, where it waits', () => {
  const on = runner([report('codex', [WORK, TEAM])], { planUsage: codexUsage(0, { [WORK]: [100, LATER], [TEAM]: [100, SOON] }) });
  assert.deepEqual(accountBeforeDispatch('codex', { account: 'default' }, { env: null }, on, NOW), { from: 'default', to: TEAM, defaultRemoved: true });
  // Once there, it waits for Team's reset, or for Work's, whichever comes first — never for Default.
  assert.deepEqual(planUsageBlockedUntil(on.planUsage as PlanUsage, 'codex', NOW, runAccount('codex', null, { codexAccount: TEAM }, on, NOW)), new Date(SOON));
  assert.deepEqual(accountAfterUsageLimitAt('codex', { account: TEAM }, { env: null }, on, NOW), new Date(LATER));
  // All paused: the same.
  const paused = runner([report('codex', [WORK, TEAM])], { pauses: { codex: { [WORK]: LATER, [TEAM]: SOON } } });
  assert.deepEqual(accountBeforeDispatch('codex', { account: 'default' }, { env: null }, paused, NOW), { from: 'default', to: TEAM, defaultRemoved: true });
});

test('the transcript says why the session moved, by the name Default goes by', () => {
  const on = runner([report('codex')]);
  const move = { from: 'default', to: WORK, defaultRemoved: true };
  assert.equal(accountSwitchNotice('codex', move, on), 'Switched to Work — Default is no longer used by Orbit');
  assert.equal(
    accountSwitchNotice('codex', move, { ...on, accountNames: { codex: { default: 'Home' } } }),
    'Switched to Work — Home is no longer used by Orbit',
  );
});

test('the sign-in preflight judges the account the session will run on, not a removed Default', () => {
  const machine = { name: 'build-box', displayName: null, status: 'ONLINE', lastHeartbeatAt: new Date(), accountNames: null };
  const refusal = (engines: RunnerEngineHealth[], codexAccount: string | null, removed = ['codex']) =>
    signedOutEngineRefusal({
      runtime: 'codex',
      bringsOwnCredentials: false,
      accounts: { codexAccount },
      runner: { ...machine, engines, defaultRemoved: removed, accountPauses: null, planUsage: null },
    });
  // Default signed out on the machine, Work signed in: nothing to refuse, whatever the session named.
  for (const pick of [null, 'default', WORK]) assert.equal(refusal([report('codex', [WORK], ['default'])], pick), null, String(pick));
  // Work, where it runs, signed out: refused by Work's name, with the command that signs Work in.
  const message = refusal([report('codex', [WORK], [WORK])], 'default');
  assert.match(message ?? '', /^Codex account "Work" is signed out on runner "build-box"/);
  assert.match(message ?? '', /CODEX_HOME='\/root\/\.orbit\/codex-accounts\/3fa91c2e' codex login --device-auth/);
});

test('with no other account reported, every answer is the one it was before Default could be removed', () => {
  // The record names Codex, but the runner reports Default alone — or no accounts at all.
  for (const engines of [[report('codex', [])], [{ engine: 'codex', installed: true, auth: 'yes' } as RunnerEngineHealth]]) {
    const usage = codexUsage(100, {});
    const removed = runner(engines, { planUsage: usage });
    const before = runner(engines, { removed: [], planUsage: usage });
    assert.equal(defaultRemovedOn('codex', removed), false);
    for (const on of [removed, before]) {
      assert.equal(automaticAccount('codex', { env: null }, on, NOW), null);
      for (const pick of [null, 'default', GONE]) {
        assert.equal(runAccount('codex', null, { codexAccount: pick }, on, NOW), 'default');
        assert.equal(dispatchEnv('codex', on, pick, { FOO: 'bar' })?.CODEX_HOME, undefined);
        assert.equal(accountBeforeDispatch('codex', { account: pick, pinned: true }, { env: null }, on, NOW), null);
        assert.equal(onRemovedDefault({ provider: 'codex', providerBuiltin: true, codexAccount: pick }, { env: null }, on), false);
      }
      assert.equal(workspaceLeavesAccountToOrbit('codex', { env: null, codexAccount: 'default' }, on), false);
      assert.deepEqual(planUsageBlockedUntil(usage, 'codex', NOW, runAccount('codex', null, {}, on, NOW)), new Date(WEEK));
    }
  }
  // Default signed out with nothing else reported is refused as it always was.
  const message = signedOutEngineRefusal({
    runtime: 'codex',
    bringsOwnCredentials: false,
    accounts: { codexAccount: null },
    runner: {
      name: 'build-box', status: 'ONLINE', lastHeartbeatAt: new Date(),
      engines: [report('codex', [], ['default'])], defaultRemoved: ['codex'], accountPauses: null, planUsage: null,
    },
  });
  assert.match(message ?? '', /^Codex is signed out on runner "build-box"/);
});
