import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOGIN_ENGINES,
  PLAN_USAGE_BUCKETS_MAX,
  REPORTED_ENGINES,
  engineKeepsAccounts,
  isInstallEngine,
  isLoginEngine,
  isReportedEngine,
  sanitizeRunnerEngines,
} from './runner-engines';

test('engine health is normalized to the engines a runner reports, in display order', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      { engine: 'kimi', installed: false, auth: 'no' },
      { engine: 'claude', installed: true, version: '  2.1.4 ', auth: 'yes' },
    ]),
    [
      { engine: 'claude', installed: true, version: '2.1.4', auth: 'yes' },
      { engine: 'kimi', installed: false, auth: 'no' },
    ],
  );
});

test('anything that is not a recognizable entry is dropped, not repaired', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      null,
      'claude',
      // Not one of ours. `opencode` used to sit here, back when only sign-in engines were
      // reported — it is a real engine on the machine and is now carried like the rest.
      { engine: 'aider', installed: true, auth: 'yes' },
      { installed: true, auth: 'yes' },
      { engine: 'codex', installed: true, auth: 'yes' },
      // A second report for the same engine loses to the first.
      { engine: 'codex', installed: false, auth: 'no' },
    ]),
    [{ engine: 'codex', installed: true, auth: 'yes' }],
  );
});

test('only the CLI\'s own yes/no counts — everything else is unknown', () => {
  assert.deepEqual(
    sanitizeRunnerEngines([
      { engine: 'claude', installed: true, auth: 'probably' },
      { engine: 'codex', installed: true },
      { engine: 'kimi', installed: 'yes', auth: 'yes' },
    ]),
    [
      { engine: 'claude', installed: true, auth: 'unknown' },
      { engine: 'codex', installed: true, auth: 'unknown' },
      // A non-boolean `installed` is not installed: this drives an Install button, so the
      // permissive reading is the safe one.
      { engine: 'kimi', installed: false, auth: 'yes' },
    ],
  );
});

test('nothing usable reads as "not reported", which is not the same as "nothing installed"', () => {
  assert.equal(sanitizeRunnerEngines(null), null);
  assert.equal(sanitizeRunnerEngines([]), null);
  assert.equal(sanitizeRunnerEngines([{ engine: 'nope' }]), null);
  assert.equal(sanitizeRunnerEngines({ claude: true }), null);
});

test('an update record is carried through, with its times normalized to ISO', () => {
  const [claude] = sanitizeRunnerEngines([
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      update: {
        status: 'failed',
        at: '2026-08-04T09:00:00Z',
        okAt: '2026-07-30T09:00:00Z',
        message: '  npm error code EACCES  ',
      },
    },
  ])!;
  assert.deepEqual(claude.update, {
    status: 'failed',
    at: '2026-08-04T09:00:00.000Z',
    // The one field that must survive a failure: it separates "erroring today" from "never worked".
    okAt: '2026-07-30T09:00:00.000Z',
    message: 'npm error code EACCES',
  });
});

test('a malformed update is dropped whole, leaving the engine itself intact', () => {
  const bad = (update: unknown) =>
    sanitizeRunnerEngines([{ engine: 'codex', installed: true, auth: 'yes', update }])![0];

  // Each of these would otherwise render as a confident claim about someone's machine.
  assert.equal(bad({ status: 'maybe', at: '2026-08-04T09:00:00Z' }).update, undefined);
  assert.equal(bad({ status: 'ok' }).update, undefined, 'a time-less record cannot be aged');
  assert.equal(bad({ status: 'ok', at: 'last tuesday' }).update, undefined);
  assert.equal(bad('ok').update, undefined);
  assert.equal(bad(null).update, undefined);
  // The engine's own health still stands — a bad update record is not a bad engine report.
  assert.equal(bad(null).auth, 'yes');
});

test('an unparseable okAt is dropped without taking the record with it', () => {
  const [kimi] = sanitizeRunnerEngines([
    {
      engine: 'kimi',
      installed: true,
      auth: 'yes',
      update: { status: 'ok', at: '2026-08-04T09:00:00Z', okAt: 'never' },
    },
  ])!;
  assert.deepEqual(kimi.update, { status: 'ok', at: '2026-08-04T09:00:00.000Z' });
});

test('a runaway message is truncated rather than stored whole', () => {
  const [claude] = sanitizeRunnerEngines([
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      update: { status: 'failed', at: '2026-08-04T09:00:00Z', message: 'x'.repeat(5000) },
    },
  ])!;
  assert.equal(claude.update?.message?.length, 400);
});

test('the drift fields survive the trip, normalized the same way the times are', () => {
  const [claude] = sanitizeRunnerEngines([
    {
      engine: 'claude',
      installed: true,
      auth: 'no',
      update: {
        status: 'failed',
        at: '2026-08-12T14:46:49Z',
        okAt: '2026-08-10T16:08:38Z',
        updatedAt: '2026-08-08T17:31:00Z',
        latest: '  2.1.228 ',
        behindSince: '2026-08-11T20:41:00Z',
        message: '2.1.226 → 2.1.228: `claude update` was still running after 5m1s and was stopped.',
      },
    },
  ])!;
  assert.deepEqual(claude.update, {
    status: 'failed',
    at: '2026-08-12T14:46:49.000Z',
    okAt: '2026-08-10T16:08:38.000Z',
    // The reading the alarm is built on: a clean okAt two days ago said nothing about a machine
    // that had in fact been unable to fetch anything since 2.1.227 shipped.
    updatedAt: '2026-08-08T17:31:00.000Z',
    latest: '2.1.228',
    behindSince: '2026-08-11T20:41:00.000Z',
    message: '2.1.226 → 2.1.228: `claude update` was still running after 5m1s and was stopped.',
  });
});

test('both halves of the split status are accepted, and so is the one they replaced', () => {
  const status = (value: string) =>
    sanitizeRunnerEngines([{ engine: 'codex', installed: true, auth: 'yes', update: { status: value, at: '2026-08-04T09:00:00Z' } }])![0]
      .update?.status;

  assert.equal(status('updated'), 'updated');
  assert.equal(status('checked'), 'checked');
  // Runners that haven't picked up the split yet still report `ok`. Dropping it would blank the
  // update column on every machine mid-rollout, which reads as "Orbit stopped updating this".
  assert.equal(status('ok'), 'ok');
  assert.equal(status('fetched'), undefined);
});

test('OpenCode is reported like any other engine, and sign-in stays a narrower question', () => {
  const engines = sanitizeRunnerEngines([
    { engine: 'opencode', installed: true, auth: 'unknown', version: '1.18.16' },
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.228' },
  ])!;
  // Dropped here, the runner's own update summary described an engine the control plane had no
  // record of — the pass updates four CLIs and named all four.
  assert.deepEqual(
    engines.map((e) => e.engine),
    ['claude', 'opencode'],
    'reported in REPORTED_ENGINES order, sign-in engines first',
  );
  // Being reportable is not being signable-in: that gate is isLoginEngine's, where the relay
  // needs it, and it has not moved.
  assert.equal(isLoginEngine('opencode'), false);
  assert.equal(isReportedEngine('opencode'), true);
  // Anything outside both sets is still dropped rather than half-read.
  assert.equal(sanitizeRunnerEngines([{ engine: 'aider', installed: true, auth: 'yes' }]), null);
});

test('Antigravity keeps its display order when dsh is reported, and accounts like Claude and Codex', () => {
  const engines = sanitizeRunnerEngines([
    { engine: 'antigravity', installed: true, auth: 'unknown', version: ' 1.2.15 ' },
    { engine: 'opencode', installed: true, auth: 'unknown', version: '1.18.16' },
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.228' },
  ])!;
  assert.deepEqual(
    engines.map((e) => e.engine),
    ['claude', 'opencode', 'antigravity'],
    'reported in REPORTED_ENGINES order, which did not move when Antigravity became signable',
  );
  assert.deepEqual(engines[2], {
    engine: 'antigravity',
    installed: true,
    version: '1.2.15',
    auth: 'unknown',
  });
  // It signs in Google accounts through the relay, one Gemini directory each, the way Claude and
  // Codex keep theirs — and has an install action, which every sign-in engine has.
  assert.equal(isLoginEngine('antigravity'), true);
  assert.equal(engineKeepsAccounts('antigravity'), true);
  assert.equal(isInstallEngine('antigravity'), true);
  assert.equal(isReportedEngine('antigravity'), true);
  assert.deepEqual(LOGIN_ENGINES, ['claude', 'codex', 'kimi', 'antigravity']);
  assert.deepEqual(REPORTED_ENGINES, ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'dsh']);
  // Reportable and installable, never signable-in: the install relay needs a command, the sign-in
  // relay a flow, and OpenCode only has the former.
  assert.equal(isInstallEngine('opencode'), true);
  assert.equal(isLoginEngine('opencode'), false);
});

/** The `/usage` buckets as step 1's runner reports them (docs/antigravity-runtime-contract.md §16.6). */
const GOOGLE_USAGE = {
  provider: 'antigravity',
  fetchedAt: '2026-10-04T02:00:00Z',
  buckets: [
    { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9999245405197144, resetTime: '2026-10-10T17:31:03Z' },
    { id: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: '2026-10-03T22:31:03Z' },
    { id: '3p-weekly', window: 'weekly', remainingFraction: 1 },
  ],
};

test('Antigravity carries which credential it runs on, and its Google quota', () => {
  const [google] = sanitizeRunnerEngines([
    { engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google', planUsage: GOOGLE_USAGE },
  ])!;
  assert.deepEqual(google, {
    engine: 'antigravity',
    installed: true,
    auth: 'yes',
    authSource: 'google',
    planUsage: {
      provider: 'antigravity',
      fetchedAt: '2026-10-04T02:00:00.000Z',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9999245405197144, resetTime: '2026-10-10T17:31:03.000Z' },
        // A spent bucket is an answer, not a missing one.
        { id: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: '2026-10-03T22:31:03.000Z' },
        { id: '3p-weekly', window: 'weekly', remainingFraction: 1 },
      ],
    },
  });

  const [envKey] = sanitizeRunnerEngines([{ engine: 'antigravity', installed: true, auth: 'yes', authSource: 'env_key' }])!;
  assert.deepEqual(envKey, { engine: 'antigravity', installed: true, auth: 'yes', authSource: 'env_key' });
  // Neither: the runner names no source at all.
  const [neither] = sanitizeRunnerEngines([{ engine: 'antigravity', installed: true, auth: 'no' }])!;
  assert.deepEqual(neither, { engine: 'antigravity', installed: true, auth: 'no' });
});

test("Antigravity carries each added account's quota beside Default's, and Default's only while its own sign-in answers", () => {
  const work = { provider: 'antigravity', fetchedAt: '2026-10-04T03:00:00Z', buckets: [{ id: 'gemini-5h', window: '5h', remainingFraction: 0.04 }] };
  const accounts = [
    { id: 'default', home: '/root/.orbit/antigravity/google', auth: 'yes' },
    { id: '5c2e91a0', name: 'Work', home: '/root/.orbit/antigravity-accounts/5c2e91a0', auth: 'yes' },
  ];
  const [both] = sanitizeRunnerEngines([{
    engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google', accounts,
    planUsage: { ...GOOGLE_USAGE, accounts: { '5c2e91a0': work, default: work, '../etc': work, 'ffffffff': { buckets: [{ id: 'x' }] } } },
  }])!;
  assert.deepEqual(both.accounts?.map((account) => account.id), ['default', '5c2e91a0']);
  assert.equal(both.planUsage?.buckets?.length, 3);
  // Only an added account's own, by its id; one with nothing readable in it is no entry at all.
  assert.deepEqual(both.planUsage?.accounts, {
    '5c2e91a0': { provider: 'antigravity', fetchedAt: '2026-10-04T03:00:00.000Z', buckets: [{ id: 'gemini-5h', window: '5h', remainingFraction: 0.04 }] },
  });
  // A runner on its GEMINI_API_KEY has no Google quota of Default's to report — but Work's still is.
  const [envKey] = sanitizeRunnerEngines([{
    engine: 'antigravity', installed: true, auth: 'yes', authSource: 'env_key', accounts,
    planUsage: { ...GOOGLE_USAGE, accounts: { '5c2e91a0': work } },
  }])!;
  assert.equal(envKey.planUsage?.buckets, undefined);
  assert.deepEqual(Object.keys(envKey.planUsage?.accounts ?? {}), ['5c2e91a0']);
});

test('a source or quota Antigravity cannot mean is dropped, and no other engine carries either', () => {
  const read = (entry: Record<string, unknown>) => sanitizeRunnerEngines([entry])![0];
  // Only the two sources the contract names.
  assert.equal(read({ engine: 'antigravity', installed: true, auth: 'yes', authSource: 'oauth' }).authSource, undefined);
  assert.equal(read({ engine: 'antigravity', installed: true, auth: 'yes', authSource: { kind: 'google' } }).authSource, undefined);
  // A quota is the Google sign-in's own read: never beside an env key, a sign-out or an unknown.
  for (const [auth, authSource] of [['yes', 'env_key'], ['no', 'google'], ['unknown', 'google'], ['yes', undefined]]) {
    assert.equal(
      read({ engine: 'antigravity', installed: true, auth, authSource, planUsage: GOOGLE_USAGE }).planUsage,
      undefined,
      `${auth}/${authSource}`,
    );
  }
  // Another engine's row is not where either lives.
  assert.deepEqual(read({ engine: 'claude', installed: true, auth: 'yes', authSource: 'google', planUsage: GOOGLE_USAGE }), {
    engine: 'claude',
    installed: true,
    auth: 'yes',
  });
  // A quota with no bucket left to show is no quota.
  for (const planUsage of [null, 'weekly', [GOOGLE_USAGE], { buckets: [] }, { buckets: 'all' }, { fetchedAt: '2026-10-04T02:00:00Z' }]) {
    assert.equal(read({ engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google', planUsage }).planUsage, undefined);
  }
});

test('the Google quota keeps the four bucket fields and nothing that could name the account', () => {
  const [entry] = sanitizeRunnerEngines([
    {
      engine: 'antigravity',
      installed: true,
      auth: 'yes',
      authSource: 'google',
      // Fields the contract never sends. A runner that sent them anyway gets none of them stored.
      email: 'owner@example.com',
      accessToken: 'ya29.not-a-real-token',
      refreshToken: '1//not-a-real-token',
      idToken: 'eyJhbGciOiJub25lIn0.e30.',
      planUsage: {
        ...GOOGLE_USAGE,
        email: 'owner@example.com',
        account: 'owner@example.com',
        token: 'ya29.not-a-real-token',
        groups: [{ name: 'Gemini Models', description: 'Models within this group: Gemini Flash' }],
        buckets: [
          {
            id: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.5,
            resetTime: 'not a time',
            name: 'Weekly Limit Remaining',
            description: 'You have used some of your weekly limit.',
            email: 'owner@example.com',
            accessToken: 'ya29.not-a-real-token',
          },
          // An id or window that is not agy's own kind of identifier is not a bucket.
          { id: 'owner@example.com', window: 'weekly', remainingFraction: 0.5 },
          { id: 'gemini-5h', window: 'ya29.' + 'x'.repeat(80), remainingFraction: 0.5 },
          { id: 'eyJhbGciOiJub25lIn0.e30.', window: '5h', remainingFraction: 0.5 },
          // A fraction outside 0–1, or not a number, is not one agy reported.
          { id: 'over', window: '5h', remainingFraction: 1.5 },
          { id: 'under', window: '5h', remainingFraction: -0.1 },
          { id: 'text', window: '5h', remainingFraction: '0.5' },
          // A second report for the same bucket loses to the first.
          { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1 },
        ],
      },
    },
  ])!;
  assert.deepEqual(entry, {
    engine: 'antigravity',
    installed: true,
    auth: 'yes',
    authSource: 'google',
    planUsage: {
      provider: 'antigravity',
      fetchedAt: '2026-10-04T02:00:00.000Z',
      buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }],
    },
  });
  const served = JSON.stringify(entry);
  for (const leak of ['@', 'ya29.', '1//', 'eyJ', 'Token', 'email', 'description', 'Weekly Limit']) {
    assert.equal(served.includes(leak), false, `${leak} reached the stored health`);
  }
});

test('a runaway quota report is bounded', () => {
  const buckets = Array.from({ length: PLAN_USAGE_BUCKETS_MAX + 5 }, (_, i) => ({ id: `b${i}`, window: 'weekly', remainingFraction: 1 }));
  const [entry] = sanitizeRunnerEngines([
    { engine: 'antigravity', installed: true, auth: 'yes', authSource: 'google', planUsage: { buckets } },
  ])!;
  assert.equal(entry.planUsage?.buckets?.length, PLAN_USAGE_BUCKETS_MAX);
  assert.equal(entry.planUsage?.fetchedAt, undefined, 'an unparseable or missing time is left out, not invented');
});
