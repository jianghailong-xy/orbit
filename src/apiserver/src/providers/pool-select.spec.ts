import { AssertionError, strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { parseSubscriptionUsage } from './plan-usage';
import {
  choosePoolMember,
  poolFallbackNotice,
  poolResumesAt,
  poolSwitchNotice,
  selectPoolMember,
  type PoolCandidate,
  type PoolSelection,
} from './pool-select';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const AN_HOUR_AGO = '2026-09-14T11:00:00.000Z';
const IN_AN_HOUR = '2026-09-14T13:00:00.000Z';
const IN_TWO_HOURS = '2026-09-14T14:00:00.000Z';
const IN_THREE_DAYS = '2026-09-17T12:00:00.000Z';

interface Row {
  id: string;
  slug: string;
}

/** A quota exactly as ProviderPlanUsageService reads it off the usage endpoint. */
function reported(body: Record<string, { utilization: number; resets_at?: string }>): PlanUsageSnapshot {
  const usage = parseSubscriptionUsage(body, NOW.toISOString());
  if (!usage) throw new AssertionError({ message: `no window parsed from ${JSON.stringify(body)}` });
  return usage;
}

/** The 5-hour window at `utilization`, resetting in two hours. */
function fiveHour(utilization: number): PlanUsageSnapshot {
  return reported({ five_hour: { utilization, resets_at: IN_TWO_HOURS } });
}

function member(slug: string, usage: PlanUsageSnapshot | null, refused = false): PoolCandidate<Row> {
  return { row: { id: `id-${slug}`, slug }, usage, refused };
}

function hold(candidate: PoolCandidate<Row>, resetsAt: string | null) {
  return {
    row: candidate.row,
    refused: candidate.refused,
    resetsAt: resetsAt === null ? null : new Date(resetsAt),
  };
}

/** The slug of the member a selection chose. */
function chosen(selection: PoolSelection<Row>): string {
  if (selection.kind !== 'SELECTED') {
    throw new AssertionError({ message: `expected a member to be chosen, got ${JSON.stringify(selection)}` });
  }
  return selection.row.slug;
}

test('every member reporting: the lowest 5-hour utilization is chosen, a tie going to the slug', () => {
  const members = [
    member('anthropic', fiveHour(40)),
    member('anthropic-2', fiveHour(12.5)),
    member('anthropic-3', fiveHour(70)),
  ];
  assert.equal(chosen(selectPoolMember(members, null, NOW)), 'anthropic-2');

  // Rare with decimals, but when it happens the order the rows came back in must not decide it.
  const tied = [member('work', fiveHour(30)), member('personal', fiveHour(30))];
  assert.equal(chosen(selectPoolMember(tied, null, NOW)), 'personal');
  assert.equal(chosen(selectPoolMember([...tied].reverse(), null, NOW)), 'personal');
});

test('some members unreported: they rank after every member that reported, never as 0% used', () => {
  const unreported = member('anthropic', null);
  const almostSpent = member('anthropic-2', fiveHour(99));
  assert.equal(chosen(selectPoolMember([unreported, almostSpent], null, NOW)), 'anthropic-2');

  // A snapshot without a 5-hour window has nothing to rank by either.
  const weeklyOnly = member('anthropic-3', reported({ seven_day: { utilization: 1, resets_at: IN_THREE_DAYS } }));
  assert.equal(chosen(selectPoolMember([weeklyOnly, almostSpent], null, NOW)), 'anthropic-2');

  // Last is still a place: once every reporting member is spent, the run goes to an unreported one
  // rather than the pool reading as exhausted.
  const spent = member('anthropic-2', fiveHour(100));
  assert.equal(chosen(selectPoolMember([spent, weeklyOnly, unreported], null, NOW)), 'anthropic');
});

test('every member spent: EXHAUSTED until the earliest member frees up, each waiting for all its windows', () => {
  const inTwoHours = member('anthropic', fiveHour(100));
  // Its 5-hour window resets first, but its week is spent too, and a member waits for every window.
  const inThreeDays = member(
    'anthropic-2',
    reported({
      five_hour: { utilization: 100, resets_at: IN_AN_HOUR },
      seven_day: { utilization: 100, resets_at: IN_THREE_DAYS },
    }),
  );
  assert.deepEqual(selectPoolMember([inThreeDays, inTwoHours], null, NOW), {
    kind: 'EXHAUSTED',
    resetsAt: new Date(IN_TWO_HOURS),
    members: [hold(inThreeDays, IN_THREE_DAYS), hold(inTwoHours, IN_TWO_HOURS)],
  });

  // A spent member that reported no reset holds as well, and leaves the pool's reset to those that did.
  const noReset = member('anthropic-3', reported({ five_hour: { utilization: 100 } }));
  assert.deepEqual(selectPoolMember([noReset, inTwoHours], null, NOW), {
    kind: 'EXHAUSTED',
    resetsAt: new Date(IN_TWO_HOURS),
    members: [hold(noReset, null), hold(inTwoHours, IN_TWO_HOURS)],
  });
  assert.deepEqual(selectPoolMember([noReset], null, NOW), {
    kind: 'EXHAUSTED',
    resetsAt: null,
    members: [hold(noReset, null)],
  });
});

test('spent means any window at 100% whose reset has not passed yet', () => {
  // A weekly limit rules a member out however much 5-hour room it has.
  const weekSpent = member(
    'anthropic',
    reported({
      five_hour: { utilization: 5, resets_at: IN_TWO_HOURS },
      seven_day: { utilization: 100, resets_at: IN_THREE_DAYS },
    }),
  );
  assert.equal(chosen(selectPoolMember([weekSpent, member('anthropic-2', fiveHour(90))], null, NOW)), 'anthropic-2');

  // A reset already behind us means the snapshot is older than the window it describes.
  const reset = member('anthropic', reported({ five_hour: { utilization: 100, resets_at: AN_HOUR_AGO } }));
  assert.equal(chosen(selectPoolMember([reset], null, NOW)), 'anthropic');
});

test('a member whose key was refused (401/403) is unavailable, not idle', () => {
  // The service keeps a refused key's last snapshot, so it can still read as untouched.
  const refused = member('anthropic', fiveHour(0), true);
  assert.equal(chosen(selectPoolMember([refused, member('anthropic-2', fiveHour(80))], null, NOW)), 'anthropic-2');

  // No reset brings a refused key back, so a pool of nothing else is UNAVAILABLE, not EXHAUSTED.
  const refusedUnreported = member('anthropic-3', null, true);
  assert.deepEqual(selectPoolMember([refused, refusedUnreported], null, NOW), {
    kind: 'UNAVAILABLE',
    members: [hold(refused, null), hold(refusedUnreported, null)],
  });
  assert.deepEqual(selectPoolMember([], null, NOW), { kind: 'UNAVAILABLE', members: [] });

  // Beside a spent member waiting does help: EXHAUSTED, on that member's reset alone.
  const spent = member('anthropic-2', fiveHour(100));
  assert.deepEqual(selectPoolMember([refused, spent], null, NOW), {
    kind: 'EXHAUSTED',
    resetsAt: new Date(IN_TWO_HOURS),
    members: [hold(refused, null), hold(spent, IN_TWO_HOURS)],
  });
});

test('a sticky member that is still usable is kept, even with more room elsewhere', () => {
  const roomier = member('anthropic', fiveHour(40));
  const current = member('anthropic-2', fiveHour(41));
  assert.equal(chosen(selectPoolMember([roomier, current], current.row.id, NOW)), 'anthropic-2');

  // Not reported is not spent: a member whose snapshot has not come in yet (its key was just
  // replaced) keeps the session.
  assert.equal(chosen(selectPoolMember([roomier, member('anthropic-2', null)], current.row.id, NOW)), 'anthropic-2');

  // Once it is no longer usable the session moves, to the best of the rest.
  const spent = member('anthropic-2', fiveHour(100));
  assert.equal(chosen(selectPoolMember([roomier, spent], current.row.id, NOW)), 'anthropic');
  const refused = member('anthropic-2', fiveHour(41), true);
  assert.equal(chosen(selectPoolMember([roomier, refused], current.row.id, NOW)), 'anthropic');
  // And so it does once it has left the pool.
  assert.equal(chosen(selectPoolMember([member('anthropic-3', fiveHour(60)), roomier], current.row.id, NOW)), 'anthropic');
});

test("a claim on a spent pool still runs on the pool's own accounts: its member, else the first to reset", () => {
  const later = member('anthropic', fiveHour(100));
  const sooner = member('anthropic-2', reported({ five_hour: { utilization: 100, resets_at: IN_AN_HOUR } }));
  assert.equal(choosePoolMember([later, sooner], null, NOW)?.slug, 'anthropic-2');
  assert.equal(choosePoolMember([later, sooner], later.row.id, NOW)?.slug, 'anthropic');
  // A refused member is not one of them, even as the session's own.
  assert.equal(choosePoolMember([member('anthropic', fiveHour(100), true), sooner], 'id-anthropic', NOW)?.slug, 'anthropic-2');
  // Nothing any reset brings back: no member at all, and dispatch falls back as for a deleted provider.
  assert.equal(choosePoolMember([member('anthropic', fiveHour(10), true)], null, NOW), null);
  assert.equal(choosePoolMember([], null, NOW), null);
  assert.equal(choosePoolMember([later, member('anthropic-3', fiveHour(20))], later.row.id, NOW)?.slug, 'anthropic-3');
});

test('the switch line says why the session left its member', () => {
  const to = { label: 'Work' };
  const from = { label: 'Personal', enabled: true, refused: false };
  assert.equal(
    poolSwitchNotice(to, { ...from, usage: fiveHour(100) }, NOW),
    "Switched to Work — Personal's 5-hour window is spent",
  );
  const weekSpent = reported({
    five_hour: { utilization: 20, resets_at: IN_TWO_HOURS },
    seven_day: { utilization: 100, resets_at: IN_THREE_DAYS },
  });
  assert.equal(
    poolSwitchNotice(to, { ...from, usage: weekSpent }, NOW),
    "Switched to Work — Personal's weekly window is spent",
  );
  // A refused key keeps its last snapshot, which can read as barely used: the refusal is the reason.
  assert.equal(
    poolSwitchNotice(to, { ...from, usage: fiveHour(3), refused: true }, NOW),
    "Switched to Work — Personal's key was refused",
  );
  assert.equal(poolSwitchNotice(to, { ...from, usage: null, enabled: false }, NOW), 'Switched to Work — Personal is disabled');
  assert.equal(poolSwitchNotice(to, null, NOW), 'Switched to Work — the previous account is no longer in this pool');
});

test('the fallback line names the pool and where the run went instead', () => {
  assert.equal(
    poolFallbackNotice({ label: 'Claude accounts' }),
    'Fell back to the Claude default (this runner\'s own login) — no account in the pool "Claude accounts" can run',
  );
});

test('a pool takes work now while a member has room, and at the earliest reset once every member is spent', () => {
  const spent = member('anthropic', fiveHour(100));
  assert.deepEqual(poolResumesAt([spent, member('anthropic-2', fiveHour(60))], NOW), NOW);
  // Beside a spent member an unreported one still takes the run, as selectPoolMember sends it there.
  assert.deepEqual(poolResumesAt([spent, member('anthropic-2', null)], NOW), NOW);
  // Across accounts the first to free up is enough: the opposite direction from one account's windows.
  const spentForAnHour = member('anthropic-2', reported({ five_hour: { utilization: 100, resets_at: IN_AN_HOUR } }));
  assert.deepEqual(poolResumesAt([spent, spentForAnHour], NOW), new Date(IN_AN_HOUR));
});

test('a pool that reports nothing to go by has no time of its own', () => {
  // Nobody has reported, which is not room.
  assert.equal(poolResumesAt([member('anthropic', null), member('anthropic-2', null)], NOW), null);
  // Nor is a refused key's leftover snapshot a report.
  assert.equal(poolResumesAt([member('anthropic', fiveHour(10), true), member('anthropic-2', null)], NOW), null);
  // Spent, with no member saying when it resets.
  assert.equal(poolResumesAt([member('anthropic', reported({ five_hour: { utilization: 100 } }))], NOW), null);
  assert.equal(poolResumesAt([], NOW), null);
});
