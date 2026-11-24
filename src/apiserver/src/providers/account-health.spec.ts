import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AccountHealthFailure,
  type AccountHealthRow,
  alertDue,
  blockMs,
  BREAKER_LADDER_MS,
  CAPACITY_COOLDOWN_MS,
  CLASSIFIED_LADDER_MS,
  failureScopeModel,
  healthView,
  type HealthFailureKind,
  stepOnFailure,
  subjectKey,
  SUSPECT_WINDOW_MS,
  TRIAL_CLAIM_STALE_MS,
  UNCLASSIFIED_ADMISSION,
  USAGE_LIMIT_COOLDOWN_MS,
} from './account-health';

/**
 * Account health rules (docs/routing-account-health-design.md §6.4 and §6.5, as amended in §11 A2): the two ladders on
 * one `trips` counter, the breaker's suspect step, the two cool-downs that never trip, any success resetting, the
 * per-session idempotency and TRANSPORT never striking. Pure: account-health.service.pg.spec.ts walks the same rules
 * through the real service on PostgreSQL.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date('2026-11-22T17:19:00.000Z');

/** §6.4's table as the design writes it, row by row: trip, classified block, breaker block. */
const LADDER_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1 * HOUR, 30 * MINUTE],
  [2, 2 * HOUR, 1 * HOUR],
  [3, 4 * HOUR, 2 * HOUR],
  [4, 8 * HOUR, 4 * HOUR],
  [5, 16 * HOUR, 8 * HOUR],
  [6, 24 * HOUR, 16 * HOUR],
  [7, 24 * HOUR, 24 * HOUR],
  [8, 24 * HOUR, 24 * HOUR],
];

let sessions = 0;
const session = () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, '0')}`;

function failure(kind: HealthFailureKind | null, extra: Partial<AccountHealthFailure> = {}): AccountHealthFailure {
  return { sessionId: session(), kind, admission: true, runnerOnline: true, ...extra };
}

/**
 * One account's live row, driven as AccountHealthService drives it: a failure applies stepOnFailure (an expired row
 * is replaced by a new one), and a success clears the row, so the next failure starts from nothing.
 */
class Account {
  row: AccountHealthRow | null = null;
  now = T0;

  fail(f: AccountHealthFailure): AccountHealthRow | null {
    const step = stepOnFailure(this.row, f, this.now);
    if (step.next) this.row = step.next;
    return this.row;
  }
  succeed(): void { this.row = null; }
  at(ms: number): this { this.now = new Date(ms); return this; }
  /** To the end of the current block, where the trial is due. */
  toTrial(): this { return this.at(this.row!.blockedUntil!.getTime()); }
  view() { return healthView(this.row, this.now); }
  blockLength(): number { return this.row!.blockedUntil!.getTime() - this.now.getTime(); }
}

test('the ladder table of §6.4, row by row to both 24 h caps', () => {
  assert.deepEqual([...CLASSIFIED_LADDER_MS], [1, 2, 4, 8, 16, 24].map((h) => h * HOUR));
  assert.deepEqual([...BREAKER_LADDER_MS], [0.5, 1, 2, 4, 8, 16, 24].map((h) => h * HOUR));
  for (const [trip, classified, breaker] of LADDER_TABLE) {
    assert.equal(blockMs('CLASSIFIED', trip), classified, `classified, trip ${trip}`);
    assert.equal(blockMs('BREAKER', trip), breaker, `breaker, trip ${trip}`);
    // At every step the breaker is at or below the classified ladder (§6.4).
    assert.ok(blockMs('BREAKER', trip) <= blockMs('CLASSIFIED', trip), `breaker ≤ classified at trip ${trip}`);
  }
  // Half up to trip 5, two thirds at trip 6, equal from trip 7.
  for (const trip of [1, 2, 3, 4, 5]) assert.equal(blockMs('BREAKER', trip) * 2, blockMs('CLASSIFIED', trip));
  assert.equal(blockMs('BREAKER', 6) * 3, blockMs('CLASSIFIED', 6) * 2);
  // "7 and later": one trial a day for as long as it keeps refusing.
  for (const trip of [9, 30, 365]) {
    assert.equal(blockMs('CLASSIFIED', trip), 24 * HOUR);
    assert.equal(blockMs('BREAKER', trip), 24 * HOUR);
  }
  assert.throws(() => blockMs('CLASSIFIED', 0), RangeError);
});

test('a classified refusal trips at once, and each refused trial climbs the classified ladder to its 24 h cap', () => {
  for (const kind of ['ACCOUNT_ACTION_REQUIRED', 'CREDENTIAL_REFUSED', 'ACCESS_DENIED'] as const) {
    const account = new Account();
    account.fail(failure(kind, { said: 'Add a payment method to continue' }));
    for (const [trip, classified] of LADDER_TABLE) {
      if (trip > 1) {
        account.toTrial();
        assert.equal(account.view(), 'trial-due', `${kind}: trial due before trip ${trip}`);
        account.fail(failure(kind));
      }
      assert.equal(account.row!.state, 'BLOCKED', `${kind} trip ${trip}`);
      assert.equal(account.row!.trips, trip, `${kind} trip ${trip}`);
      assert.equal(account.row!.kind, kind);
      assert.equal(account.blockLength(), classified, `${kind}: block at trip ${trip}`);
      assert.equal(account.view(), 'blocked');
    }
  }
});

test('the breaker: one strike makes the account suspect, the second trips, refused trials climb 30 min … 24 h', () => {
  const account = new Account();
  account.fail(failure(null));
  assert.equal(account.row!.state, 'SUSPECT');
  assert.equal(account.row!.strikes, 1);
  assert.equal(account.row!.trips, 0);
  assert.equal(account.view(), 'suspect');
  account.at(T0.getTime() + 10 * MINUTE).fail(failure(null));
  for (const [trip, , breaker] of LADDER_TABLE) {
    if (trip > 1) account.toTrial().fail(failure(null));
    assert.equal(account.row!.state, 'BLOCKED', `breaker trip ${trip}`);
    assert.equal(account.row!.kind, UNCLASSIFIED_ADMISSION);
    assert.equal(account.row!.trips, trip);
    assert.equal(account.row!.strikes, 0);
    assert.equal(account.blockLength(), breaker, `breaker: block at trip ${trip}`);
  }
});

test('a suspect account is healthy again after 60 minutes without another strike', () => {
  const account = new Account();
  account.fail(failure(null));
  assert.equal(account.at(T0.getTime() + SUSPECT_WINDOW_MS - 1).view(), 'suspect');
  assert.equal(account.at(T0.getTime() + SUSPECT_WINDOW_MS).view(), 'healthy');
  // A strike after that is the first of a new streak, not a trip.
  const step = stepOnFailure(account.row, failure(null), account.now);
  assert.equal(step.expirePrevious, true);
  assert.equal(step.next!.state, 'SUSPECT');
  assert.equal(step.next!.strikes, 1);
});

test('a breaker streak then a classified refusal continues on the classified column at the shared count', () => {
  const account = new Account();
  account.fail(failure(null));
  account.fail(failure(null)); // trip 1, 30 min
  account.toTrial().fail(failure(null)); // trip 2, 1 h
  account.toTrial().fail(failure(null)); // trip 3, 2 h
  assert.equal(account.row!.trips, 3);
  assert.equal(account.blockLength(), 2 * HOUR);
  account.toTrial().fail(failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }));
  assert.equal(account.row!.trips, 4);
  assert.equal(account.row!.kind, 'ACCOUNT_ACTION_REQUIRED');
  assert.equal(account.blockLength(), 8 * HOUR, 'trip 4 of the classified column');
  // And back: an unclassified refused trial reads the breaker column at the count it reached.
  account.toTrial().fail(failure(null));
  assert.equal(account.row!.trips, 5);
  assert.equal(account.blockLength(), 8 * HOUR, 'trip 5 of the breaker column');
});

test('a refusal inside a block is not another trip; only a refused trial is', () => {
  const account = new Account();
  account.fail(failure('CREDENTIAL_REFUSED'));
  const until = account.row!.blockedUntil!.getTime();
  account.at(T0.getTime() + 20 * MINUTE).fail(failure('CREDENTIAL_REFUSED'));
  assert.equal(account.row!.trips, 1);
  assert.equal(account.row!.blockedUntil!.getTime(), until);
  assert.equal(account.row!.lastAt.getTime(), T0.getTime() + 20 * MINUTE, 'the evidence moves');
  account.at(T0.getTime() + 25 * MINUTE).fail(failure(null));
  assert.equal(account.row!.trips, 1);
  assert.equal(account.row!.blockedUntil!.getTime(), until);
});

test('any success resets: the next refusal after it is trip 1 again', () => {
  const account = new Account();
  account.fail(failure('ACCOUNT_ACTION_REQUIRED'));
  account.toTrial().fail(failure('ACCOUNT_ACTION_REQUIRED'));
  account.toTrial().fail(failure('ACCOUNT_ACTION_REQUIRED'));
  assert.equal(account.row!.trips, 3);
  account.toTrial().succeed();
  assert.equal(account.view(), 'healthy');
  account.fail(failure('ACCOUNT_ACTION_REQUIRED'));
  assert.equal(account.row!.trips, 1);
  assert.equal(account.blockLength(), 1 * HOUR);
  // The breaker too: a success between two strikes means the second is a first strike again.
  const breaker = new Account();
  breaker.fail(failure(null));
  breaker.succeed();
  breaker.fail(failure(null));
  assert.equal(breaker.row!.state, 'SUSPECT');
  assert.equal(breaker.row!.strikes, 1);
});

test('idempotent per session: the same session\'s failure again changes nothing', () => {
  const account = new Account();
  const refused = failure(null);
  account.fail(refused);
  assert.deepEqual(stepOnFailure(account.row, { ...refused }, new Date(T0.getTime() + MINUTE)), { next: null, expirePrevious: false });
  const classified = failure('ACCOUNT_ACTION_REQUIRED');
  account.fail(classified);
  const before = { ...account.row! };
  account.toTrial();
  assert.equal(stepOnFailure(account.row, classified, account.now).next, null, 'a retried finalize is not a refused trial');
  assert.deepEqual(account.row, before);
});

test('TRANSPORT never strikes: not on a healthy account, not while suspect, not on a due trial', () => {
  const account = new Account();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(stepOnFailure(account.row, failure('TRANSPORT'), account.now).next, null);
  }
  account.fail(failure(null));
  assert.equal(stepOnFailure(account.row, failure('TRANSPORT'), account.now).next, null, 'suspect stays at one strike');
  account.fail(failure(null));
  account.toTrial();
  assert.equal(stepOnFailure(account.row, failure('TRANSPORT'), account.now).next, null, 'the trial is simply due again');
  assert.equal(failureScopeModel(failure('TRANSPORT')), null, 'it writes no row at all');
  // Nor does a failure that is not an admission failure, or one while the runner was offline.
  assert.equal(failureScopeModel(failure(null, { admission: false })), null);
  assert.equal(failureScopeModel(failure(null, { runnerOnline: false })), null);
  assert.equal(failureScopeModel(failure('REQUEST_REFUSED')), null);
});

test('CAPACITY cools one model on the account for 5 minutes and never trips', () => {
  const capacity = (extra: Partial<AccountHealthFailure> = {}) => failure('CAPACITY', { model: 'gpt-5.5-codex', ...extra });
  assert.equal(failureScopeModel(capacity()), 'gpt-5.5-codex', 'the model\'s own row, not the account\'s');
  assert.equal(failureScopeModel(failure('CAPACITY')), null, 'no model named: nothing to cool');
  const model = new Account();
  for (let i = 0; i < 20; i += 1) {
    model.at(T0.getTime() + i * 2 * MINUTE).fail(capacity());
    assert.equal(model.row!.state, 'COOLDOWN');
    assert.equal(model.row!.kind, 'CAPACITY');
    assert.equal(model.row!.trips, 0, 'never a trip');
    assert.equal(model.blockLength(), CAPACITY_COOLDOWN_MS, '5 minutes from the latest failure, never longer');
    assert.equal(model.view(), 'cooldown');
  }
  assert.equal(model.at(model.row!.blockedUntil!.getTime()).view(), 'healthy', 'no trial: simply a candidate again');
  // A capacity failure after the cool-down ran out starts a new one; nothing carried over.
  const step = stepOnFailure(model.row, capacity(), model.now);
  assert.equal(step.expirePrevious, true);
  assert.equal(step.next!.trips, 0);
  // The provider's own time is used when it names one.
  const named = new Date(T0.getTime() + 2 * MINUTE);
  assert.equal(stepOnFailure(null, capacity({ until: named }), T0).next!.blockedUntil!.getTime(), named.getTime());
});

test('a usage limit with no reading cools the account for 15 minutes or to the named reset, and never trips', () => {
  assert.equal(stepOnFailure(null, failure('USAGE_LIMIT', { usageReadingCovers: true }), T0).next, null, 'the reading is the better source');
  const step = stepOnFailure(null, failure('USAGE_LIMIT'), T0).next!;
  assert.equal(step.state, 'COOLDOWN');
  assert.equal(step.trips, 0);
  assert.equal(step.blockedUntil!.getTime() - T0.getTime(), USAGE_LIMIT_COOLDOWN_MS);
  // On a blocked account the ladder is kept and the next trial waits for the reset too.
  const account = new Account();
  account.fail(failure('ACCOUNT_ACTION_REQUIRED'));
  account.toTrial();
  const reset = new Date(account.now.getTime() + 3 * HOUR);
  account.fail(failure('USAGE_LIMIT', { until: reset }));
  assert.equal(account.row!.state, 'BLOCKED');
  assert.equal(account.row!.trips, 1);
  assert.equal(account.row!.blockedUntil!.getTime(), reset.getTime());
});

test('a trial claim holds while its run is running, or for 15 minutes; then a run that never started frees it', () => {
  const account = new Account();
  account.fail(failure('ACCOUNT_ACTION_REQUIRED'));
  account.toTrial();
  const claimedAt = account.now;
  account.row = { ...account.row!, trialSessionId: session(), trialClaimedAt: claimedAt };
  assert.equal(account.view(), 'trial-running');
  account.at(claimedAt.getTime() + TRIAL_CLAIM_STALE_MS);
  assert.equal(healthView(account.row, account.now, false), 'trial-due');
  assert.equal(healthView(account.row, account.now, true), 'trial-running');
});

test('the subject keys of §6.1', () => {
  assert.equal(subjectKey({ type: 'runner', runnerId: 'r1', engine: 'cursor', account: 'default' }), 'runner:r1:cursor:default');
  assert.equal(subjectKey({ type: 'provider', providerId: 'p1' }), 'provider:p1');
  assert.equal(subjectKey({ type: 'pool-login', poolId: 'pool1', accountId: 'acct' }), 'pool-login:pool1:acct');
  // ACCESS_DENIED writes the model's row only when the adapter says it is about one model.
  assert.equal(failureScopeModel(failure('ACCESS_DENIED', { model: 'opus', scope: 'model' })), 'opus');
  assert.equal(failureScopeModel(failure('ACCESS_DENIED', { model: 'opus' })), '');
});

/**
 * §8 and §10 phase 3: when a write owes the owner an `account-needs-action` push. Driven as the service drives it: the
 * row's `notifiedKind` is whatever the last alert stamped, and a cleared row starts the next streak with none.
 */
class AlertingAccount extends Account {
  notified: string | null = null;
  alerts: string[] = [];

  failAndCount(f: AccountHealthFailure): void {
    const step = stepOnFailure(this.row, f, this.now);
    if (!step.next) return;
    // A row that ran out is replaced by a new live row: a new streak, nothing alerted for it yet.
    if (!this.row || step.expirePrevious) this.notified = null;
    this.row = step.next;
    if (alertDue(step.next, this.notified)) {
      this.notified = step.next.kind;
      this.alerts.push(step.next.kind);
    }
  }

  clear(): void {
    this.row = null;
    this.notified = null;
  }
}

test('alert: a classified refusal pushes at trip 1 and not at later trips or daily trials', () => {
  const a = new AlertingAccount();
  a.failAndCount(failure('ACCOUNT_ACTION_REQUIRED', { said: 'Add a payment method to continue' }));
  assert.deepEqual(a.alerts, ['ACCOUNT_ACTION_REQUIRED']);
  // A fresh failure inside the block is evidence, not a trip.
  a.now = new Date(a.now.getTime() + 10 * MINUTE);
  a.failAndCount(failure('ACCOUNT_ACTION_REQUIRED'));
  // Trials: every one to the 24 h cap and then the daily ones.
  for (let trip = 2; trip <= 10; trip += 1) {
    a.now = new Date(a.row!.blockedUntil!.getTime());
    a.failAndCount(failure('ACCOUNT_ACTION_REQUIRED', { said: 'different wording inside the same kind' }));
    assert.equal(a.row!.trips, trip);
  }
  assert.equal(a.alerts.length, 1, 'one alert for the whole streak');
});

test('alert: the breaker pushes at its third trip only', () => {
  const a = new AlertingAccount();
  a.failAndCount(failure(null));
  assert.deepEqual(a.alerts, [], 'a first strike makes the account suspect and says nothing');
  a.failAndCount(failure(null));
  assert.equal(a.row!.trips, 1);
  for (const trips of [2, 3, 4, 5, 6, 7]) {
    a.now = new Date(a.row!.blockedUntil!.getTime());
    a.failAndCount(failure(null));
    assert.equal(a.row!.trips, trips);
    assert.equal(a.alerts.length, trips >= 3 ? 1 : 0, `after trip ${trips}`);
  }
});

test('alert: a new streak after a success alerts again at its own alert point', () => {
  const a = new AlertingAccount();
  a.failAndCount(failure('CREDENTIAL_REFUSED'));
  a.clear();
  a.failAndCount(failure('CREDENTIAL_REFUSED'));
  assert.deepEqual(a.alerts, ['CREDENTIAL_REFUSED', 'CREDENTIAL_REFUSED']);
  a.clear();
  // The breaker's new streak waits for its own third trip.
  a.failAndCount(failure(null));
  a.failAndCount(failure(null));
  assert.equal(a.alerts.length, 2);
  for (let i = 0; i < 2; i += 1) {
    a.now = new Date(a.row!.blockedUntil!.getTime());
    a.failAndCount(failure(null));
  }
  assert.equal(a.alerts.length, 3);
  assert.equal(a.alerts[2], UNCLASSIFIED_ADMISSION);
});

test('alert: a changed classified kind alerts once; unclassified after classified does not', () => {
  const a = new AlertingAccount();
  a.failAndCount(failure('ACCOUNT_ACTION_REQUIRED'));
  a.now = new Date(a.row!.blockedUntil!.getTime());
  a.failAndCount(failure('CREDENTIAL_REFUSED'));
  assert.deepEqual(a.alerts, ['ACCOUNT_ACTION_REQUIRED', 'CREDENTIAL_REFUSED']);
  a.now = new Date(a.row!.blockedUntil!.getTime());
  a.failAndCount(failure('CREDENTIAL_REFUSED'));
  assert.equal(a.alerts.length, 2, 'the same kind again is silent');
  // A classified streak turning unclassified: three breaker-kind trips in a row on the same row say nothing.
  for (let i = 0; i < 3; i += 1) {
    a.now = new Date(a.row!.blockedUntil!.getTime());
    a.failAndCount(failure(null));
  }
  assert.equal(a.alerts.length, 2);
});

test('alert: the breaker then a classified refusal alerts for the new kind; cool-downs never alert', () => {
  const a = new AlertingAccount();
  a.failAndCount(failure(null));
  a.failAndCount(failure(null));
  for (let i = 0; i < 2; i += 1) {
    a.now = new Date(a.row!.blockedUntil!.getTime());
    a.failAndCount(failure(null));
  }
  assert.deepEqual(a.alerts, [UNCLASSIFIED_ADMISSION]);
  a.now = new Date(a.row!.blockedUntil!.getTime());
  a.failAndCount(failure('ACCOUNT_ACTION_REQUIRED'));
  assert.deepEqual(a.alerts, [UNCLASSIFIED_ADMISSION, 'ACCOUNT_ACTION_REQUIRED']);

  const b = new AlertingAccount();
  b.failAndCount(failure('CAPACITY', { model: 'm' }));
  b.failAndCount(failure('USAGE_LIMIT'));
  assert.deepEqual(b.alerts, []);
});
