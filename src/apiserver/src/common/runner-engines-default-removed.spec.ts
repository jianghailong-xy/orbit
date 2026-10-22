import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spentPlanUsage, type PlanUsage, type RunnerEngineAccount } from '@orbit/shared';
import { antigravityState } from './antigravity-readiness';
import { namedRunnerEngines, usedPlanUsage, usedRunnerEngines } from './runner-engines';

// A runner's engines as Orbit serves and uses them (usedRunnerEngines). A Default the owner removed
// from Orbit (`runner.default_removed`, RunnersService.removeAccount) is left out of its engine while
// the runner reports another account of it, the engine is marked with it, and whatever sums up the
// engine's sign-in speaks for the accounts that remain — so a client that predates the marker never
// calls the engine signed out over a Default nobody uses. The runner list reading the column on
// PostgreSQL is runner-default-served.pg.spec.ts.

const DEFAULT: RunnerEngineAccount = {
  id: 'default',
  home: '/home/ada/.codex',
  codexHome: '/home/ada/.codex',
  // Signed out on the machine: what a client older than the marker would raise an alarm over.
  auth: 'no',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const WORK: RunnerEngineAccount = {
  id: '3fa91c2e',
  name: 'Work',
  home: '/home/ada/.orbit/codex-accounts/3fa91c2e',
  codexHome: '/home/ada/.orbit/codex-accounts/3fa91c2e',
  auth: 'yes',
  fingerprintPrefix: 'cxa1_0b05070e',
};
const HOME: RunnerEngineAccount = {
  id: '5d2e8b10',
  name: 'Home',
  home: '/home/ada/.orbit/codex-accounts/5d2e8b10',
  codexHome: '/home/ada/.orbit/codex-accounts/5d2e8b10',
  auth: 'yes',
};

/** Codex as a runner reports it: the engine's own answer is Default's, the CLI's in the machine's
 *  environment. */
const codex = (accounts: RunnerEngineAccount[] | undefined) => ({
  engine: 'codex',
  installed: true,
  version: 'codex-cli 0.156.0',
  auth: accounts?.find((account) => account.id === 'default')?.auth ?? 'yes',
  ...(accounts ? { accounts } : {}),
});
const CLAUDE = {
  engine: 'claude',
  installed: true,
  version: '2.1.287 (Claude Code)',
  auth: 'yes',
  accounts: [
    { id: 'default', home: '/home/ada/.claude', auth: 'yes' },
    { id: '77aa0c3d', name: 'Team', home: '/home/ada/.orbit/claude-accounts/77aa0c3d', auth: 'yes' },
  ],
};

/** A runner row as the runner list selects it. */
const row = (engines: unknown, defaultRemoved: unknown = [], over: Record<string, unknown> = {}) => ({
  engines,
  accountNames: null,
  accountPauses: null,
  defaultRemoved,
  ...over,
});

test('with nothing removed, every engine reads exactly as namedRunnerEngines reads it', () => {
  const engines = [CLAUDE, codex([DEFAULT, WORK])];
  const usage = { codex: { provider: 'codex', primary: { utilization: 40 } } };
  // The empty list is what every runner has. The rest is what a row could hold that names no engine
  // keeping accounts, or what a test double without the column reads as.
  for (const removed of [[], undefined, null, 'codex', { codex: true }, ['opencode', 'dsh', 'CODEX', '', 42]]) {
    const r = row(engines, removed);
    assert.deepEqual(usedRunnerEngines(r), namedRunnerEngines(r), `default_removed ${JSON.stringify(removed)}`);
    assert.equal(usedPlanUsage(usage, usedRunnerEngines(r)), usage, 'the stored quota, as stored');
  }
  assert.equal(usedRunnerEngines(row(null, ['codex'])), null, 'a runner that never reported stays unreported');
});

test('removed while two other accounts are reported: Default is left out, and the engine is marked with it', () => {
  const [claude, served] = usedRunnerEngines(row([CLAUDE, codex([DEFAULT, WORK, HOME])], ['codex']))!;
  assert.deepEqual(served, {
    engine: 'codex',
    installed: true,
    version: 'codex-cli 0.156.0',
    // Default says no; the two accounts Orbit uses say yes.
    auth: 'yes',
    accounts: [WORK, HOME],
    removedDefault: { home: '/home/ada/.codex', fingerprintPrefix: 'cxa1_9f3a41c7' },
  });
  // Another engine's Default is its own.
  assert.deepEqual(claude, namedRunnerEngines(row([CLAUDE]))![0]);
});

test('removed while one other account is reported: the engine is that account, as it was Default alone', () => {
  const signedOut = { ...WORK, auth: 'no' as const };
  const [served] = usedRunnerEngines(row([codex([{ ...DEFAULT, auth: 'yes' }, signedOut])], ['codex']))!;
  assert.deepEqual(served, {
    engine: 'codex',
    installed: true,
    version: 'codex-cli 0.156.0',
    // Default is signed in on the machine, but Orbit does not use it: the engine is as signed out as
    // the one account it does use.
    auth: 'no',
    accounts: [signedOut],
    removedDefault: { home: '/home/ada/.codex', fingerprintPrefix: 'cxa1_9f3a41c7' },
  });
});

test('the engine reads signed in while any account that remains is, and signed out only once every one is', () => {
  const account = (auth: RunnerEngineAccount['auth'], index: number): RunnerEngineAccount => ({
    id: `0000000${index}`,
    home: `/home/ada/.orbit/codex-accounts/0000000${index}`,
    auth,
  });
  const cases: Array<[RunnerEngineAccount['auth'][], RunnerEngineAccount['auth']]> = [
    [['yes'], 'yes'],
    [['no'], 'no'],
    [['unknown'], 'unknown'],
    [['no', 'yes'], 'yes'],
    [['unknown', 'yes'], 'yes'],
    [['no', 'unknown'], 'unknown'],
    [['no', 'no'], 'no'],
  ];
  for (const [remaining, auth] of cases) {
    // Whatever Default itself says, which is the engine's answer on the machine.
    for (const own of ['yes', 'no', 'unknown'] as const) {
      const accounts = [{ ...DEFAULT, auth: own }, ...remaining.map(account)];
      const [served] = usedRunnerEngines(row([codex(accounts)], ['codex']))!;
      assert.equal(served.auth, auth, `Default ${own}, remaining ${remaining.join(', ')}`);
    }
  }
});

test("Kimi's site is that of the account its sign-in is read from", () => {
  const kimi = (accounts: RunnerEngineAccount[]) => ({
    engine: 'kimi',
    installed: true,
    auth: 'yes',
    kimiRegion: 'mainland-cn',
    accounts: [{ id: 'default', home: '/home/ada/.kimi', auth: 'yes', kimiRegion: 'mainland-cn' }, ...accounts],
  });
  const out: RunnerEngineAccount = { id: '1a2b3c4d', home: '/home/ada/.orbit/kimi-accounts/1a2b3c4d', auth: 'no', kimiRegion: 'mainland-cn' };
  const signedIn: RunnerEngineAccount = { id: '5e6f7a8b', home: '/home/ada/.orbit/kimi-accounts/5e6f7a8b', auth: 'yes', kimiRegion: 'global' };
  const [served] = usedRunnerEngines(row([kimi([out, signedIn])], ['kimi']))!;
  assert.equal(served.auth, 'yes');
  assert.equal(served.kimiRegion, 'global');
  // An account that has never signed in is on no site, and the engine then names none — not Default's.
  const fresh: RunnerEngineAccount = { id: '9f9f9f9f', home: '/home/ada/.orbit/kimi-accounts/9f9f9f9f', auth: 'no' };
  const [unsigned] = usedRunnerEngines(row([kimi([fresh])], ['kimi']))!;
  assert.equal('kimiRegion' in unsigned, false);
});

test("Antigravity reads as the Google accounts that remain, never as the machine's Gemini key", () => {
  // A runner whose own credential is the GEMINI_API_KEY in its environment: the engine says yes on the
  // key, and Default's Google sign-in says no (docs/antigravity-runtime-contract.md §16.11).
  const google: RunnerEngineAccount = { id: '9c8b7a6d', name: 'Google', home: '/home/ada/.orbit/antigravity-accounts/9c8b7a6d', auth: 'yes' };
  const buckets = [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75 }];
  const reading = { provider: 'antigravity', fetchedAt: '2026-10-21T08:00:00.000Z', buckets };
  const antigravity = (account: RunnerEngineAccount, planUsage?: unknown) => ({
    engine: 'antigravity',
    installed: true,
    version: '1.4.3',
    auth: 'yes',
    authSource: 'env_key',
    accounts: [{ id: 'default', home: '/home/ada/.orbit/antigravity/google', auth: 'no' }, account],
    ...(planUsage ? { planUsage } : {}),
  });
  const engines = [antigravity(google, { provider: 'antigravity', accounts: { [google.id]: reading } })];
  const [served] = usedRunnerEngines(row(engines, ['antigravity']))!;
  assert.deepEqual(served, {
    engine: 'antigravity',
    installed: true,
    version: '1.4.3',
    auth: 'yes',
    authSource: 'google',
    accounts: [google],
    // Its one account's quota is the engine's own, as Default's was.
    planUsage: { ...reading, accounts: { [google.id]: reading } },
    removedDefault: { home: '/home/ada/.orbit/antigravity/google' },
  });
  // That account signed out, the engine is signed out: the key was Default's, and so is no credential
  // Orbit runs on.
  const [lapsed] = usedRunnerEngines(row([antigravity({ ...google, auth: 'no' })], ['antigravity']))!;
  assert.equal(lapsed.auth, 'no');
  assert.equal(lapsed.authSource, 'google');
  assert.equal('planUsage' in lapsed, false);
  assert.equal(antigravityState({ engines: [antigravity({ ...google, auth: 'no' })] }).envKeyAvailable, true, 'as reported');
  const state = antigravityState({ engines: [lapsed] });
  assert.equal(state.envKeyAvailable, false);
  assert.equal(state.authSource, 'google');
});

test("the runner's quota loses Default's part with it, and the one account that remains has the engine's", () => {
  const spent = { utilization: 100, resetsAt: '2026-10-28T00:00:00.000Z' };
  const room = { utilization: 12, resetsAt: '2026-10-21T20:00:00.000Z' };
  const work = { provider: 'codex', primary: room, fetchedAt: '2026-10-21T08:00:00.000Z' };
  const claude = { provider: 'claude', fiveHour: { utilization: 30 } };
  const usage = {
    codex: {
      provider: 'codex',
      primary: spent,
      secondary: spent,
      planType: 'plus',
      accounts: { [WORK.id]: work },
      fetchedAt: '2026-10-21T07:00:00.000Z',
    },
    claude,
    fetchedAt: '2026-10-21T08:00:00.000Z',
  };
  const one = usedRunnerEngines(row([CLAUDE, codex([DEFAULT, WORK])], ['codex']));
  const served = usedPlanUsage(usage, one);
  assert.deepEqual(served, {
    codex: { ...work, accounts: { [WORK.id]: work } },
    claude,
    fetchedAt: '2026-10-21T08:00:00.000Z',
  });
  // An account's own reading is what it was, for every reader that reads one by its id.
  assert.deepEqual(spentPlanUsage(served as PlanUsage, 'codex', WORK.id), spentPlanUsage(usage as PlanUsage, 'codex', WORK.id));
  // Two remaining: the engine has none of its own, and each account keeps its entry.
  const two = usedRunnerEngines(row([CLAUDE, codex([DEFAULT, WORK, HOME])], ['codex']));
  assert.deepEqual(usedPlanUsage(usage, two), {
    codex: { provider: 'codex', accounts: { [WORK.id]: work } },
    claude,
    fetchedAt: '2026-10-21T08:00:00.000Z',
  });
  // A lone Codex snapshot is the payload itself.
  const flat = { provider: 'codex', primary: spent, accounts: { [WORK.id]: work } };
  const alone = usedRunnerEngines(row([codex([DEFAULT, WORK])], ['codex']));
  assert.deepEqual(usedPlanUsage(flat, alone), { ...work, accounts: { [WORK.id]: work } });
  // Nothing read for the account that remains: no quota for the engine, rather than Default's.
  assert.deepEqual(usedPlanUsage({ codex: { provider: 'codex', primary: spent }, claude }, one), {
    codex: { provider: 'codex' },
    claude,
  });
  assert.deepEqual(usedPlanUsage({ provider: 'codex', primary: spent }, alone), { provider: 'codex' });
  // Claude's Default removed instead: Codex's snapshot is not Claude's to change.
  const claudeOnly = usedRunnerEngines(row([CLAUDE, codex([DEFAULT, WORK])], ['claude']));
  assert.deepEqual(usedPlanUsage(usage, claudeOnly), {
    codex: usage.codex,
    claude: { provider: 'claude' },
    fetchedAt: '2026-10-21T08:00:00.000Z',
  });
  // What is not a quota at all is passed on as stored.
  for (const stored of [null, undefined, 'x', [1]]) assert.equal(usedPlanUsage(stored, one), stored);
});

test('brought back, or with no other account reported, Default is listed and used exactly as reported', () => {
  const engines = [CLAUDE, codex([DEFAULT, WORK])];
  const before = usedRunnerEngines(row(engines));
  assert.notDeepEqual(usedRunnerEngines(row(engines, ['codex'])), before);
  // Brought back: the record is empty again, and so is every difference.
  assert.deepEqual(usedRunnerEngines(row(engines, [])), before);
  // The other account gone from the report while the record stays: Default is the one account Orbit
  // has there, listed and in use with its own sign-in, and nothing marks it.
  const alone = row([CLAUDE, codex([DEFAULT])], ['codex']);
  assert.deepEqual(usedRunnerEngines(alone), namedRunnerEngines(alone));
  const usage = { codex: { provider: 'codex', primary: { utilization: 5 } } };
  assert.equal(usedPlanUsage(usage, usedRunnerEngines(alone)), usage);
  // Another account added later finds the record waiting: Default is left out again.
  assert.deepEqual(usedRunnerEngines(row([CLAUDE, codex([DEFAULT, HOME])], ['codex']))![1].accounts, [HOME]);
  // A runner too old to list accounts, and a report with no Default in it to leave out.
  for (const reported of [codex(undefined), codex([WORK])]) {
    const r = row([reported], ['codex']);
    assert.deepEqual(usedRunnerEngines(r), namedRunnerEngines(r));
  }
});

test('the marker names Default as Orbit calls it, and the accounts that remain keep their names and pauses', () => {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const r = row([codex([DEFAULT, WORK, HOME])], ['codex'], {
    accountNames: { codex: { default: 'Machine login', [WORK.id]: 'Clients' } },
    accountPauses: { codex: { [HOME.id]: until, default: until } },
  });
  const [served] = usedRunnerEngines(r)!;
  assert.deepEqual(served.accounts, [{ ...WORK, name: 'Clients' }, { ...HOME, pausedUntil: until }]);
  assert.deepEqual(served.removedDefault, { home: '/home/ada/.codex', name: 'Machine login', fingerprintPrefix: 'cxa1_9f3a41c7' });
  // Never renamed, and no fingerprint read: its directory alone.
  const { fingerprintPrefix: _fingerprint, ...unread } = DEFAULT;
  assert.deepEqual(usedRunnerEngines(row([codex([unread, WORK])], ['codex']))![0].removedDefault, { home: '/home/ada/.codex' });
});

test('every engine that keeps accounts leaves its Default out the same way, and only its own', () => {
  const engines = (['claude', 'codex', 'antigravity', 'kimi', 'cursor'] as const).map((engine) => ({
    engine,
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: `/home/ada/.${engine}`, auth: 'yes' },
      { id: 'abcdef01', home: `/home/ada/.orbit/${engine}-accounts/abcdef01`, auth: 'yes' },
    ],
  }));
  for (const removed of ['claude', 'codex', 'antigravity', 'kimi', 'cursor']) {
    for (const entry of usedRunnerEngines(row(engines, [removed]))!) {
      const left = entry.engine === removed;
      assert.deepEqual(entry.accounts?.map((account) => account.id), left ? ['abcdef01'] : ['default', 'abcdef01'], `${removed}: ${entry.engine}`);
      assert.deepEqual(entry.removedDefault, left ? { home: `/home/ada/.${removed}` } : undefined, `${removed}: ${entry.engine}`);
    }
  }
});

test('it reads the row and writes nothing back, so every reader of the same row gets the same answer', () => {
  const r = row([CLAUDE, codex([DEFAULT, WORK])], ['codex'], { accountNames: { codex: { default: 'Main' } } });
  const usage = { codex: { provider: 'codex', primary: { utilization: 1 }, accounts: { [WORK.id]: { provider: 'codex' } } } };
  const before = structuredClone({ r, usage });
  const once = usedRunnerEngines(r);
  usedPlanUsage(usage, once);
  assert.deepEqual({ r, usage }, before);
  assert.deepEqual(usedRunnerEngines(r), once);
});
