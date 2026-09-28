import { describe, expect, it } from 'vitest';
import { encodeId } from './idCodec';
import { availableCount, memberQuota, memberStatus, poolHeadline, poolsAsProviders } from './providerPools';
import {
  allOutOfBudget,
  canAddKey,
  canRemoveKey,
  formatCapReset,
  keyState,
  outOfBudget,
  personShare,
  sharedPoolAsProviderPool,
  type SharedPool,
  type SharedPoolKey,
  type SharedPoolPerson,
} from './sharedPools';

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const ANN = id(1);
const MIA = id(2);

const spend = (costUsd: number) => ({ inputTokens: 0, outputTokens: 0, costUsd });
const person = (userId: string, name: string, over: Partial<SharedPoolPerson> = {}): SharedPoolPerson => ({
  userId,
  name,
  role: 'MEMBER',
  creator: false,
  you: false,
  keys: 0,
  sessions: 0,
  usage: spend(0),
  ...over,
});
const key = (n: number, contributor: string, over: Partial<SharedPoolKey> = {}): SharedPoolKey => ({
  id: id(100 + n),
  label: `key-${n}`,
  fingerprint: `sk-…000${n}`,
  state: 'ACTIVE',
  enabled: true,
  shareCap: 50,
  spentUntil: null,
  contributor: { userId: contributor, name: contributor === ANN ? 'Ann' : 'Mia', you: contributor === ANN },
  usage: { ...spend(0), othersCostUsd: 0 },
  running: false,
  next: false,
  ...over,
});
/** Seen by Ann, who made it. */
const pool = (keys: SharedPoolKey[], over: Partial<SharedPool> = {}): SharedPool => ({
  id: id(900),
  slug: 'team-codex',
  label: 'Team Codex',
  engine: 'codex',
  membersCanAdd: true,
  ownKeyFirst: true,
  viewerRole: 'ADMIN',
  window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
  people: [
    person(ANN, 'Ann', { role: 'ADMIN', creator: true, you: true, usage: spend(30) }),
    person(MIA, 'Mia', { usage: spend(10) }),
  ],
  keys,
  ...over,
});
const others = (othersCostUsd: number) => ({ usage: { ...spend(othersCostUsd), othersCostUsd } });

describe('where a shared pool key stands, for whoever reads it', () => {
  it('is at its cap for everyone but its contributor, whose own use no cap limits', () => {
    expect(keyState(key(1, MIA, others(50)))).toBe('SPENT');
    expect(keyState(key(1, MIA, others(49.99)))).toBe('AVAILABLE');
    expect(keyState(key(1, ANN, others(50)))).toBe('AVAILABLE');
    expect(keyState(key(1, MIA, { ...others(500), shareCap: null }))).toBe('AVAILABLE');
  });

  it('reads refused by OpenAI before switched off, and either before capped or busy', () => {
    expect(keyState(key(1, MIA, { state: 'INVALID', enabled: false }))).toBe('INVALID');
    expect(keyState(key(1, MIA, { enabled: false, running: true }))).toBe('DISABLED');
    expect(keyState(key(1, MIA, { state: 'DISABLED' }))).toBe('DISABLED');
    expect(keyState(key(1, MIA, { ...others(50), running: true }))).toBe('SPENT');
    expect(keyState(key(1, MIA, { running: true }))).toBe('RUNNING');
  });

  it('reads OpenAI putting a key out of budget before anything but refused or switched off', () => {
    const until = '2026-09-30T06:00:00.000Z';
    expect(keyState(key(1, MIA, { spentUntil: until }))).toBe('SPENT');
    expect(memberStatus(sharedPoolAsProviderPool(pool([key(1, MIA, { spentUntil: until })])).members[0])).toEqual({
      label: 'Out of budget · resets Sep 30',
      color: 'orange',
    });
    // Out of budget outranks the cap, and holds for the key's own contributor too — where a cap
    // stops only the others.
    expect(keyState(key(1, MIA, { spentUntil: until, ...others(50), running: true }))).toBe('SPENT');
    expect(keyState(key(1, ANN, { spentUntil: until, ...others(50) }))).toBe('SPENT');
    expect(keyState(key(1, MIA, { state: 'INVALID', spentUntil: until }))).toBe('INVALID');
    expect(keyState(key(1, MIA, { state: 'DISABLED', spentUntil: until }))).toBe('DISABLED');
    expect(keyState(key(1, MIA, { enabled: false, spentUntil: until }))).toBe('DISABLED');
    // A key the payload says nothing about is a key with no mark, not one out of budget: only a mark
    // still to come is sent, and a field left out reads as none.
    const silent = { ...key(1, MIA) } as Partial<SharedPoolKey>;
    delete silent.spentUntil;
    expect(outOfBudget(silent as SharedPoolKey)).toBe(false);
    expect(keyState(silent as SharedPoolKey)).toBe('AVAILABLE');
  });
});

describe('a shared pool drawn as an account pool', () => {
  it('makes each key a member: its state, its cap as a monthly gauge, the next one, and the key itself', () => {
    const shown = sharedPoolAsProviderPool(
      pool([key(1, ANN, { ...others(12.4), next: true }), key(2, MIA, { ...others(50) }), key(3, MIA, { shareCap: null })]),
    );
    expect(shown.members.map((m) => [m.label, m.state, m.next])).toEqual([
      ['key-1', 'AVAILABLE', true],
      ['key-2', 'SPENT', false],
      ['key-3', 'AVAILABLE', false],
    ]);
    expect(memberQuota(shown.members[0])).toMatchObject({ label: 'Monthly limit', percent: 25 });
    // No cap, nothing to fill.
    expect(memberQuota(shown.members[2])).toBeNull();
    expect(memberStatus(shown.members[1])).toEqual({ label: 'At cap · resets Oct 1', color: 'orange' });
    expect(shown.members[1].key?.fingerprint).toBe('sk-…0002');
    expect(availableCount(shown, new Map())).toBe(2);
    expect(poolHeadline(shown)).toMatchObject({ kind: 'next', member: { label: 'key-1' } });
    expect(poolsAsProviders([shown])[0]).toMatchObject({ slug: 'team-codex', runtime: 'codex', presetSlug: 'openai' });
  });

  it('says why when no key can run, and when the caps come back when only caps are in the way', () => {
    expect(sharedPoolAsProviderPool(pool([])).unavailable).toBe('No keys');
    const refused = sharedPoolAsProviderPool(pool([key(1, MIA, { state: 'INVALID' }), key(2, MIA, { enabled: false })]));
    expect(refused.unavailable).toBe('No key can run');
    expect(poolHeadline(refused)).toEqual({ kind: 'none', reason: 'No key can run' });
    const capped = sharedPoolAsProviderPool(pool([key(1, MIA, others(50))]));
    expect(capped.unavailable).toBeNull();
    expect(poolHeadline(capped)).toEqual({ kind: 'spent', resetsAt: '2026-10-01T00:00:00.000Z' });
  });

  it('counts a key OpenAI put out of budget as one no session starts on, and heads the pool with its reset', () => {
    const until = '2026-09-30T06:00:00.000Z';
    const shown = sharedPoolAsProviderPool(
      pool([key(1, ANN, { next: true }), key(2, MIA, { spentUntil: until }), key(3, MIA, others(50))]),
    );
    expect(shown.members.map((m) => m.state)).toEqual(['AVAILABLE', 'SPENT', 'SPENT']);
    expect(availableCount(shown, new Map())).toBe(1);
    // A key that can run is enough: the pool names no reset while one is free.
    expect(shown.resetsAt).toBeNull();
    // With nothing to run on, the pool's own reset is the EARLIEST of the stops — OpenAI's mark comes
    // before the month turns.
    const stopped = sharedPoolAsProviderPool(pool([key(2, MIA, { spentUntil: until }), key(3, MIA, others(50))]));
    expect(stopped.resetsAt).toBe(until);
    expect(poolHeadline(stopped)).toEqual({ kind: 'spent', resetsAt: until });
    // Out of budget alone is the head's words; a cap among the stops keeps the cap's.
    expect(allOutOfBudget(pool([key(2, MIA, { spentUntil: until })]))).toBe(true);
    expect(allOutOfBudget(pool([key(2, MIA, { spentUntil: until }), key(3, MIA, others(50))]))).toBe(false);
    expect(allOutOfBudget(pool([key(2, MIA, others(50))]))).toBe(false);
    expect(allOutOfBudget(pool([key(1, ANN)]))).toBe(false);
  });
});

describe("a shared pool's people and permissions", () => {
  it("gives each person their share of the month's use, and nobody a share of nothing", () => {
    const team = pool([]);
    expect(team.people.map((p) => personShare(team, p))).toEqual([75, 25]);
    const idle = pool([], { people: [person(ANN, 'Ann'), person(MIA, 'Mia')] });
    expect(idle.people.map((p) => personShare(idle, p))).toEqual([0, 0]);
  });

  it('lets a key go out by its contributor or an admin, and a key in by an admin or while members may', () => {
    const miaKey = key(1, MIA);
    expect(canRemoveKey(pool([miaKey]), miaKey)).toBe(true);
    const asMember = pool([miaKey], { viewerRole: 'MEMBER' });
    expect(canRemoveKey(asMember, miaKey)).toBe(false);
    expect(canRemoveKey(asMember, key(2, ANN))).toBe(true);
    expect(canAddKey(asMember)).toBe(true);
    expect(canAddKey({ ...asMember, membersCanAdd: false })).toBe(false);
    expect(canAddKey({ ...asMember, membersCanAdd: false, viewerRole: 'ADMIN' })).toBe(true);
  });

  it('names when a cap starts again by its date, in the month the server counts', () => {
    expect(formatCapReset('2026-10-01T00:00:00.000Z')).toBe('Oct 1');
  });
});
