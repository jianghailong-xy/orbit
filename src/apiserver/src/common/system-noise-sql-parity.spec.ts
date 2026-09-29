import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEANINGFUL_SYSTEM_SUBTYPES, PING_KEYS, notNoiseSql } from './system-noise';

/**
 * The noise predicate's second copy — the one nothing guarded.
 *
 * It exists three times: `isNoiseSystemEvent` (what the live broadcast filters with),
 * `notNoiseSql` (the literal SQL the four read paths interpolate verbatim —
 * sessions.controller.ts:779, sessions.service.ts:2881/2954, runner-api.controller.ts:5150), and the
 * partial index `run_event_renderable_idx`'s WHERE (migration 0069), which is that same SQL
 * materialised. system-noise-index-parity.spec.ts pins the third to the second; this file pins the
 * second to the first, which is the edge that was missing. system-noise.spec.ts holds the
 * function's own behaviour — what it answers for a given payload — and not its agreement with the
 * SQL.
 *
 * WHY A DRIFT IS INVISIBLE
 * ========================
 * The two never have to agree to compile or to run. `notNoiseSql` is interpolated as text, so if
 * its subtype list or its key-subtraction chain drifts, the read paths simply start selecting a
 * different set of rows: noise back on the wire, or `init`/`resumed` gone from it
 * (`runtimeInitSessionId` reads the runtime's session id off those). Nothing raises. And the index
 * guard cannot see it either, because it pins the index to `notNoiseSql` itself — the index follows
 * the drift wherever it goes, and both specs stay green while the behaviour is already wrong.
 *
 * WHY THE SQL TEXT RATHER THAN A DATABASE
 * =======================================
 * `npm --prefix src/apiserver test` compiles the specs and hands them to `node --test` after
 * filtering out every `*.pg.spec.js`, so a check needing a live database is excluded from the lane
 * this one has to run in. Nothing is lost by reading the text instead: the expression goes into the
 * query as-is, so the tree Postgres parses on the query side comes from exactly this string — the
 * same fact 0069 states as "the WHERE clause must stay character-identical to `notNoiseSql`".
 *
 * NORMALIZATION RULES
 * ===================
 * Runs of whitespace collapse to one space, and the ends are trimmed. Nothing else is folded: case,
 * quotes and every other character stay significant, so `'INIT'`, `"init"` and `init` are red
 * rather than formatting differences — subtypes are lowercase strings. Spacing is not a liberty
 * this file takes away: 0069's WHERE has to stay character-identical to this text anyway, so the
 * predicate has no formatting freedom left to lose. A red from a reformat says so plainly, since
 * every failure below prints the text it read.
 *
 * WHAT IS PINNED, AND WHY A SINGLE-POINT CHANGE IS RED
 * ====================================================
 * The whole predicate is matched, anchored at both ends, so every character of it is accounted for.
 * Only two slots are left open, and each is compared as a SET against one of the function's own
 * sets — reordering one of those is not a semantic change and stays green:
 *
 *   * the literals of `NOT IN (…)` vs MEANINGFUL_SYSTEM_SUBTYPES — drop `'resumed'` from the set,
 *     or add a subtype to the SQL, and the lists stop matching;
 *   * the `- '<key>'` chain vs PING_KEYS — the same, key for key;
 *   * everything outside those two slots is frozen: the wrapping `NOT (`, `type = 'system'`, the
 *     COALESCE, the `NOT IN`, and the `= '{}'::jsonb`. Flipping `NOT IN` to `IN`, or dropping the
 *     outer `NOT` — each inverting the predicate — matches no longer, even with both slots still
 *     holding the right values.
 *
 * What this file deliberately does NOT do is model the jsonb operators in JS and compare verdicts
 * per payload: that would be a fourth copy of the predicate, which is the disease rather than the
 * cure. The SQL's spelling is the authority here, and the function's meaning for a payload is
 * already covered by system-noise.spec.ts.
 */
const LITERALS = /'([^']*)'/g;

/** Collapse runs of whitespace. Case, quotes and every other character are left alone. */
const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * The whole predicate, with the two slots that carry the sets left as captures. `[^()]*` keeps the
 * subtype slot to a flat literal list — a nested expression there is drift, not formatting — and
 * the chain is zero or more `- '<key>'` steps, so an emptied chain is a mismatch rather than a
 * parse failure.
 */
const PREDICATE =
  /^NOT \( type = 'system' AND COALESCE\(payload->>'subtype', ''\) NOT IN \((?<subtypes>[^()]*)\) AND \(payload(?<chain>(?: ?- ?'[^']*')*)\) = '\{\}'::jsonb \)$/;

/** The two open slots, as the literals the SQL writes, or a failure naming the text that was read. */
function slots(): { subtypes: string[]; keys: string[] } {
  const sql = normalize(notNoiseSql.sql);
  const match = PREDICATE.exec(sql);
  assert.ok(
    match?.groups,
    '`notNoiseSql` is no longer the predicate this guard knows how to read, so the subtype list ' +
      `and the key chain it holds cannot be compared with \`isNoiseSystemEvent\`'s sets. Read:\n  ${sql}`,
  );
  return {
    subtypes: [...match.groups.subtypes.matchAll(LITERALS)].map((m) => m[1]),
    keys: [...match.groups.chain.matchAll(LITERALS)].map((m) => m[1]),
  };
}

test('the SQL in notNoiseSql spells out exactly the sets isNoiseSystemEvent filters on', () => {
  const { subtypes, keys } = slots();

  assert.deepEqual(
    [...subtypes].sort(),
    [...MEANINGFUL_SYSTEM_SUBTYPES].sort(),
    '`notNoiseSql` and `isNoiseSystemEvent` disagree about which system subtypes are meaningful. ' +
      'The read paths filter on the SQL list and the live broadcast on MEANINGFUL_SYSTEM_SUBTYPES, ' +
      'so a drift here changes which rows cross the wire with nothing to raise. The SQL list is ' +
      `(${subtypes.join(', ')}); the set is (${[...MEANINGFUL_SYSTEM_SUBTYPES].join(', ')}). ` +
      'Change both, or neither.',
  );

  assert.deepEqual(
    [...keys].sort(),
    [...PING_KEYS].sort(),
    '`notNoiseSql` and `isNoiseSystemEvent` disagree about which keys a bare progress ping ' +
      'carries. The SQL subtracts the keys it lists and the function tolerates PING_KEYS, so a ' +
      `drift here moves the noise line with nothing to raise. The SQL subtracts ${keys.join(', ')}; ` +
      `the set holds ${[...PING_KEYS].join(', ')}. Change both, or neither.`,
  );
});
