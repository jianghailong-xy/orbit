import { describe, expect, it } from 'vitest';
import {
  PINNED_GROUP_KEY,
  UNFILED_GROUP_KEY,
  projectBadgeParts,
  projectCountsById,
  sessionProjectSections,
  type ProjectCounts,
} from './projectGrouping';
import { sessionTimeSections } from './sessionGrouping';

// Local wall-clock parts, then serialized, so the recency boundaries inside Unfiled are
// deterministic whatever timezone CI runs in — same reason sessionGrouping.test.ts does it.
const NOW = new Date(2026, 6, 8, 12, 0, 0); // 2026-07-08 12:00 local
const at = (y: number, m: number, d: number, h = 12): string =>
  new Date(y, m - 1, d, h).toISOString();

const session = (
  id: string,
  o: {
    projectId?: string | null;
    projectTitle?: string | null;
    lastTurnAt?: string;
    pinnedAt?: string;
  } = {},
) => ({ id, ...o });

const counts = (needsYou: number, running: number, done: number, total: number): ProjectCounts => ({
  needsYou,
  running,
  done,
  total,
});

const ids = <T extends { id: string }>(sections: { sessions: T[] }[]): string[][] =>
  sections.map((s) => s.sessions.map((x) => x.id));

// Two projects and three project-less sessions, in console order (most recent first). The
// project-less three straddle three recency buckets so Unfiled has something to section.
const MIXED = [
  session('alpha-1', { projectId: 'pA', projectTitle: 'Alpha', lastTurnAt: at(2026, 7, 8, 11) }),
  session('loose-today', { lastTurnAt: at(2026, 7, 8, 10) }),
  session('beta-1', { projectId: 'pB', projectTitle: 'Beta', lastTurnAt: at(2026, 7, 8, 9) }),
  session('alpha-2', { projectId: 'pA', projectTitle: 'Alpha', lastTurnAt: at(2026, 7, 7, 20) }),
  session('loose-yesterday', { lastTurnAt: at(2026, 7, 7, 8) }),
  session('loose-old', { lastTurnAt: at(2026, 5, 9) }),
];

describe('sessionProjectSections', () => {
  it('groups a mixed list by project, with the project-less ones in a trailing Unfiled', () => {
    const out = sessionProjectSections(MIXED, { now: NOW });

    expect(out.map((g) => [g.key, g.title])).toEqual([
      ['pA', 'Alpha'],
      ['pB', 'Beta'],
      [UNFILED_GROUP_KEY, 'Unfiled'],
    ]);
    expect(out.map((g) => g.projectId)).toEqual(['pA', 'pB', null]);
    // Rows stay in the order the console sorted them, and each appears exactly once.
    expect(ids(out[0].sections)).toEqual([['alpha-1', 'alpha-2']]);
    expect(ids(out[1].sections)).toEqual([['beta-1']]);
    expect(out.flatMap((g) => g.sections.flatMap((s) => s.sessions.map((x) => x.id))).sort()).toEqual(
      MIXED.map((s) => s.id).sort(),
    );
  });

  it('orders projects by first mention, which over a recency-sorted list is most recent first', () => {
    // Same rows, Beta's newest ahead of Alpha's.
    const out = sessionProjectSections([MIXED[2], ...MIXED.slice(0, 2), ...MIXED.slice(3)], {
      now: NOW,
    });
    expect(out.map((g) => g.key)).toEqual(['pB', 'pA', UNFILED_GROUP_KEY]);
  });

  it('sections Unfiled by recency, identically to sessionGrouping over the same rows', () => {
    const out = sessionProjectSections(MIXED, { now: NOW });
    const unfiled = out.at(-1)!;
    const loose = MIXED.filter((s) => !s.projectId);

    expect(unfiled.sections).toEqual(
      sessionTimeSections(loose, { pinnedFirst: false, now: NOW }).map((t) => ({
        title: t.title,
        sessions: t.sessions,
      })),
    );
    expect(unfiled.sections.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'Older']);
    // A project group needs no sub-heading; only Unfiled carries them.
    expect(out[0].sections.map((s) => s.title)).toEqual([null]);
  });

  it('lifts pinned sessions above every project, and leaves them in place when pinning is off', () => {
    const rows = [
      session('pinned', { projectId: 'pA', projectTitle: 'Alpha', pinnedAt: at(2026, 1, 1) }),
      ...MIXED,
    ];

    const lifted = sessionProjectSections(rows, { now: NOW });
    expect(lifted[0].key).toBe(PINNED_GROUP_KEY);
    expect(lifted[0].title).toBe('Pinned');
    expect(ids(lifted[0].sections)).toEqual([['pinned']]);
    expect(ids(lifted[1].sections)).toEqual([['alpha-1', 'alpha-2']]);

    // Under a tag filter the caller turns pinning off, and the pinned row files by project.
    const inPlace = sessionProjectSections(rows, { now: NOW, pinnedFirst: false });
    expect(inPlace.map((g) => g.key)).toEqual(['pA', 'pB', UNFILED_GROUP_KEY]);
    expect(ids(inPlace[0].sections)).toEqual([['pinned', 'alpha-1', 'alpha-2']]);
  });

  it('never lets Unfiled lift a pin a second time', () => {
    const loosePin = session('loose-pin', {
      lastTurnAt: at(2026, 5, 1),
      pinnedAt: at(2026, 1, 1),
    });

    // Lifted: it belongs to the one leading Pinned group, not to a second one inside Unfiled.
    const lifted = sessionProjectSections([loosePin, ...MIXED], { now: NOW });
    expect(lifted[0].key).toBe(PINNED_GROUP_KEY);
    expect(lifted.at(-1)!.sections.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'Older']);

    // Not lifted: it buckets by its own date like any other row — no "Pinned" heading appears.
    const inPlace = sessionProjectSections([loosePin, ...MIXED], { now: NOW, pinnedFirst: false });
    const unfiled = inPlace.at(-1)!;
    expect(unfiled.sections.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'Older']);
    expect(ids(unfiled.sections).flat()).toContain('loose-pin');
  });

  it('names a group from whichever of its rows carries the title', () => {
    const out = sessionProjectSections(
      [session('a', { projectId: 'pA' }), session('b', { projectId: 'pA', projectTitle: 'Alpha' })],
      { now: NOW },
    );
    expect(out.map((g) => g.title)).toEqual(['Alpha']);
  });

  it('drops the groups a list has no rows for, and keeps no empty Unfiled', () => {
    const out = sessionProjectSections(
      [session('alpha-1', { projectId: 'pA', projectTitle: 'Alpha' })],
      { now: NOW },
    );
    expect(out.map((g) => g.key)).toEqual(['pA']);
  });

  describe('rollups', () => {
    it("attaches each project's counts, and none to Pinned or Unfiled", () => {
      const out = sessionProjectSections(
        [session('pin', { pinnedAt: at(2026, 1, 1) }), ...MIXED],
        {
          now: NOW,
          counts: projectCountsById([
            { projectId: 'pA', ...counts(2, 1, 5, 9) },
            { projectId: 'pB', ...counts(0, 0, 3, 3) },
          ]),
        },
      );
      expect(out.map((g) => g.counts)).toEqual([null, counts(2, 1, 5, 9), counts(0, 0, 3, 3), null]);
    });

    it('leaves counts null while the rollup has not arrived', () => {
      const out = sessionProjectSections(MIXED, { now: NOW });
      expect(out.map((g) => g.counts)).toEqual([null, null, null]);
    });

    it('keeps the rollup on a collapsed group, so rolling up never hides a waiting approval', () => {
      const out = sessionProjectSections(MIXED, {
        now: NOW,
        collapsed: new Set(['pA', UNFILED_GROUP_KEY]),
        counts: projectCountsById([{ projectId: 'pA', ...counts(2, 1, 5, 9) }]),
      });

      const [alpha, beta, unfiled] = out;
      expect(alpha.collapsed).toBe(true);
      expect(alpha.counts).toEqual(counts(2, 1, 5, 9));
      expect(projectBadgeParts(alpha.counts!)[0].text).toBe('2 needs you');
      // Collapsed groups keep their size but yield no rows — so a caller flattening `sections`
      // to walk what is on screen cannot land inside one.
      expect(alpha.count).toBe(2);
      expect(alpha.sections).toEqual([]);
      expect(unfiled.collapsed).toBe(true);
      expect(unfiled.count).toBe(3);
      expect(unfiled.sections).toEqual([]);
      // An untouched group is unaffected.
      expect(beta.collapsed).toBe(false);
      expect(ids(beta.sections)).toEqual([['beta-1']]);
    });
  });
});

describe('projectCountsById', () => {
  it('indexes the rollup rows by project, and answers an empty map for no rows', () => {
    expect(projectCountsById([{ projectId: 'pA', ...counts(1, 2, 3, 4) }]).get('pA')).toEqual(
      counts(1, 2, 3, 4),
    );
    expect(projectCountsById(undefined).size).toBe(0);
    expect(projectCountsById(null).size).toBe(0);
  });
});

describe('projectBadgeParts', () => {
  it('states all three buckets when all three have something to say', () => {
    expect(projectBadgeParts(counts(2, 1, 5, 9))).toEqual([
      { kind: 'needsYou', text: '2 needs you' },
      { kind: 'running', text: '1 running' },
      { kind: 'done', text: '5/9 done' },
    ]);
  });

  it('drops the live tallies at zero but always states progress', () => {
    expect(projectBadgeParts(counts(0, 0, 3, 3))).toEqual([{ kind: 'done', text: '3/3 done' }]);
    expect(projectBadgeParts(counts(0, 2, 1, 4))).toEqual([
      { kind: 'running', text: '2 running' },
      { kind: 'done', text: '1/4 done' },
    ]);
    expect(projectBadgeParts(counts(1, 0, 0, 6))).toEqual([
      { kind: 'needsYou', text: '1 needs you' },
      { kind: 'done', text: '0/6 done' },
    ]);
  });
});
