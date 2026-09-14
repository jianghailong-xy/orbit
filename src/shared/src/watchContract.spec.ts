import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The executable half of docs/watch-contract.md: it holds the frozen contract to its own rules so
 * the prose and contracts/watch.contract.json cannot drift apart before the Watch implementation
 * tasks read them. It checks the contract's internal consistency and coverage — it does NOT
 * evaluate predicates, because no evaluator exists yet; that is what the P1 tasks build against
 * these vectors.
 */

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (relative: string): any => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
const CONTRACT = readJson('contracts/watch.contract.json');

const STATE_MACHINES = ['watch', 'target', 'delivery'] as const;

describe('watch contract', () => {
  it('is version 1, serves predicate versions 1 and 2, and points at a document that exists', () => {
    expect(CONTRACT.name).toBe('orbit.watch');
    expect(CONTRACT.contractVersion).toBe(1);
    expect(CONTRACT.predicateVersion).toBe(2);
    // The newest grammar is served, and so is every one before it: a stored predicate is decided under
    // the version it was requested with, so dropping one would strand every watch written under it.
    expect(CONTRACT.servedPredicateVersions).toEqual([1, 2]);
    expect(Object.keys(CONTRACT.grammar.versions)).toEqual(['1', '2']);
    expect(existsSync(path.join(ROOT, CONTRACT.doc))).toBe(true);
  });

  it('introduces every later leaf under a served version', () => {
    for (const [name, leaf] of Object.entries<any>(CONTRACT.leaves)) {
      const since = leaf.sinceVersion ?? 1;
      expect(CONTRACT.servedPredicateVersions, `${name} arrives in an unserved version`).toContain(since);
      // A leaf that takes parameters says what they are, and none of the version-1 leaves takes any.
      expect(Boolean(leaf.params), `${name}'s params and its version disagree`).toBe(since > 1);
    }
  });

  it('declares every leaf against a watchable target kind and named source columns', () => {
    const watchable: string[] = CONTRACT.watchableTargetKinds;
    expect(watchable.length).toBeGreaterThan(0);
    for (const [name, leaf] of Object.entries<any>(CONTRACT.leaves)) {
      expect(watchable, `${name} targets a non-watchable kind`).toContain(leaf.targetKind);
      expect(leaf.definition, `${name} has no definition`).toBeTruthy();
      expect(leaf.sourceColumns.length, `${name} names no source columns`).toBeGreaterThan(0);
    }
  });

  it.each(STATE_MACHINES)('has a consistent %s state machine', (machine) => {
    const sm = CONTRACT.states[machine];
    const values: string[] = sm.values;

    expect(values).toContain(sm.initial);
    for (const terminal of sm.terminal ?? []) expect(values).toContain(terminal);

    for (const t of sm.transitions) {
      expect(values, `${machine}: unknown from-state ${t.from}`).toContain(t.from);
      expect(values, `${machine}: unknown to-state ${t.to}`).toContain(t.to);
      expect(t.trigger, `${machine}: ${t.from}->${t.to} has no trigger`).toBeTruthy();
    }

    // A terminal state is one nothing leaves. A transition out of one would mean the word is a lie.
    for (const terminal of sm.terminal ?? []) {
      const leaving = sm.transitions.filter((t: any) => t.from === terminal);
      expect(leaving, `${machine}: ${terminal} is terminal but has outgoing transitions`).toEqual([]);
    }

    // Every declared state must be reachable, or it is vocabulary nothing can ever produce.
    const reached = new Set<string>([sm.initial]);
    for (let i = 0; i < values.length; i += 1) {
      for (const t of sm.transitions) if (reached.has(t.from)) reached.add(t.to);
    }
    expect([...values].sort(), `${machine}: unreachable states`).toEqual([...reached].sort());
  });

  it('carries at least 12 uniquely named vectors, each with a stated reason', () => {
    const vectors: any[] = CONTRACT.vectors;
    expect(vectors.length).toBeGreaterThanOrEqual(12);
    const ids = vectors.map((v) => v.id);
    expect(new Set(ids).size, 'vector ids are not unique').toBe(ids.length);
    for (const v of vectors) {
      expect(v.given, `${v.id} has no given`).toBeTruthy();
      expect(v.expect, `${v.id} has no expectation`).toBeTruthy();
      expect(v.why, `${v.id} does not say why it matters`).toBeTruthy();
    }
  });

  it('exercises every declared leaf in at least one vector', () => {
    const serialized = JSON.stringify(CONTRACT.vectors);
    for (const name of Object.keys(CONTRACT.leaves)) {
      expect(serialized.includes(name), `no vector exercises ${name}`).toBe(true);
    }
  });

  it('only expects refusals and states the contract declares', () => {
    const codes: string[] = CONTRACT.refusals.map((r: any) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const v of CONTRACT.vectors) {
      if (v.expect.refusal) expect(codes, `${v.id}`).toContain(v.expect.refusal);
      if (v.expect.watchState) expect(CONTRACT.states.watch.values, `${v.id}`).toContain(v.expect.watchState);
      if (v.expect.targetState) expect(CONTRACT.states.target.values, `${v.id}`).toContain(v.expect.targetState);
    }
  });

  it('keeps the TTL window and delivery budget ordered', () => {
    const l = CONTRACT.limits;
    expect(l.minTtlSeconds).toBeLessThan(l.defaultTtlSeconds);
    expect(l.defaultTtlSeconds).toBeLessThanOrEqual(l.maxTtlSeconds);
    expect(l.maxDeliveryAttempts).toBeGreaterThan(1);
    expect(l.maxPredicateDepth).toBeGreaterThanOrEqual(2);
  });

  it('records that the durable session trigger does not cover every leaf it would need to', () => {
    // If migration 0133's column list is ever widened to completed_at, this contract's claim that
    // the sweep is load-bearing stops being true and has to be rewritten deliberately.
    const columns: string[] = CONTRACT.factSource.coverageGap.sessionTriggerColumns;
    expect(columns).toEqual(['status', 'deleted_at', 'merge_status']);
    expect(columns).not.toContain('completed_at');
    expect(CONTRACT.factSource.authoritative).toMatch(/PostgreSQL/u);
  });

  it('builds every agent await preset from declared leaves of its own target kind, inside the grammar', () => {
    const surface = CONTRACT.agentSurface;
    const check = (term: any, depth: number): string[] => {
      expect(depth, 'a preset nests deeper than the grammar allows').toBeLessThanOrEqual(CONTRACT.limits.maxPredicateDepth);
      if (CONTRACT.aggregations.includes(term.kind)) {
        expect(Object.keys(term).sort()).toEqual(['kind', 'leaf', 'over']);
        expect(CONTRACT.targetSelectors).toContain(term.over);
        expect(Object.keys(CONTRACT.leaves)).toContain(term.leaf);
        return [term.leaf];
      }
      expect(CONTRACT.composites, `unknown predicate kind ${term.kind}`).toContain(term.kind);
      expect(Object.keys(term).sort()).toEqual(['kind', 'operands']);
      expect(term.operands.length).toBeGreaterThan(0);
      expect(term.operands.length).toBeLessThanOrEqual(CONTRACT.limits.maxOperandsPerComposite);
      return term.operands.flatMap((operand: any) => check(operand, depth + 1));
    };
    for (const [tool, family] of Object.entries<any>(surface.awaitPresets)) {
      expect(surface.tools, `${tool} is not one of the agent tools`).toContain(tool);
      expect(CONTRACT.watchableTargetKinds).toContain(family.targetKind);
      expect(Object.keys(family.until), `${tool}'s default is not one of its presets`).toContain(family.default);
      for (const [until, predicate] of Object.entries<any>(family.until)) {
        for (const leaf of check(predicate, 1)) {
          expect(CONTRACT.leaves[leaf].targetKind, `${tool} ${until} reads ${leaf}`).toBe(family.targetKind);
        }
      }
    }
    // The request agents make most, "all of these tasks settled or any one failed", is the default.
    const headline = CONTRACT.vectors.find((v: any) => v.id === 'all-terminal-or-any-failed');
    const tasks = surface.awaitPresets.task_await;
    expect(tasks.until[tasks.default]).toEqual(headline.given.predicate);
    // session_create(wait) keeps waiting for the line it always waited for: a settled turn.
    expect(surface.sessionCreateWait.watch.predicate).toEqual({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' });
    expect(Object.keys(surface.release.outcomes).sort()).toEqual(
      ['ALREADY_WOKEN', 'CANCELLED', 'NOTHING_OWED', 'WAKE_NOT_QUEUED', 'WAKE_WITHDRAWN'],
    );
  });

  it('names exactly one effect per action kind', () => {
    const kinds = CONTRACT.actions.map((a: any) => a.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const a of CONTRACT.actions) expect(a.effect, `${a.kind} has no effect`).toBeTruthy();
  });

  it('says for every terminal state whether the session waiting on the watch is told, each end under its own turn key', () => {
    const resume = CONTRACT.actions.find((a: any) => a.kind === 'RESUME_SESSION');
    const delivered: Record<string, { clientTurnId: string; payload: string[] }> = resume.endTurns.delivered;
    const notDelivered: Record<string, string> = resume.endTurns.notDelivered;
    // MATCHED is the one end not listed: the Match's own wake tells the session, under the generation key.
    const classified = [...Object.keys(delivered), ...Object.keys(notDelivered)];
    expect([...classified, 'MATCHED'].sort(), 'a terminal state is unclassified, or classified twice').toEqual(
      [...CONTRACT.states.watch.terminal].sort(),
    );
    const keys = [resume.idempotency.clientTurnId, ...Object.values(delivered).map((end) => end.clientTurnId)];
    expect(new Set(keys).size, 'two wakes share a turn key').toBe(keys.length);
    for (const [state, end] of Object.entries(delivered)) {
      expect(end.clientTurnId, `${state}'s key could be read as a generation`).toMatch(/^watch:<watchId>:[a-z]+$/u);
      expect(end.payload.slice(0, 2), `${state}'s turn does not name the watch and its end`).toEqual(['watchId', 'state']);
    }
    // Contract §7: a revoked watch's turn names its end and nothing about what it watched.
    expect(delivered.REVOKED.payload).toEqual(['watchId', 'state']);
    for (const state of classified) {
      const told = state in delivered;
      const pinned = CONTRACT.vectors.some(
        (v: any) => v.expect.watchState === state && typeof v.expect.delivery === 'string' && (v.expect.delivery === 'none') !== told,
      );
      expect(pinned, `no vector pins whether ${state} tells the waiting session`).toBe(true);
    }
  });
});
