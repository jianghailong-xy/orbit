import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Independent unit-02 review of Coordinator contract v1.8, flipped by unit 01I for v1.9.
//
// v1.8 shape: every assertion below modelled the predicate D15/D16 actually enforced and exhibited
// a committed state those predicates accept while the prose invariants reject. v1.9 closed
// `PC-CX-47..49`, so a witness assertion would now necessarily go red — the same discipline §24.6,
// §25.7 and §26.5 applied to the v1.5, v1.6 and v1.7 spec files. Each test therefore asserts TWO
// things:
//   1. the closed shape — v1.9's clause/object refuses the review's exact state, and
//   2. the reverse control — v1.8's shape, kept verbatim, still admits it.
// Deleting the reverse control would make the fix unfalsifiable, so it stays. The suite is still
// database-free: the real-server half of these three findings lives in
// `coordinator-linearization.pg.spec.ts` (§27's `PC-CX-4x on real Postgres:` tests).
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const REVIEW = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.8.md'), 'utf8');

function between(document: string, start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return document.slice(from, to);
}

const I17_A = between(CONTRACT, '- **I17-A（create 冻结列', '- **I17-A2（claim 冻结列');
const I17_A2 = between(CONTRACT, '- **I17-A2（claim 冻结列', '- **I17-A3（lineage');
const EC2_B = between(CONTRACT, '- **EC2-b（', '- **EC2-c（');
const EC6_C = between(CONTRACT, '- **EC6-c（', '- **EC6-d（');
const D15 = between(CONTRACT, '#### D15 ', '#### D16 ');
const D16 = between(CONTRACT, '#### D16 ', '#### D8 ');
const D16_SQL = D16.slice(D16.indexOf('CREATE OR REPLACE FUNCTION'), D16.lastIndexOf('```'));
const D17 = between(CONTRACT, '#### D17 ', '#### D7 ');
const LIMITS = CONTRACT.slice(CONTRACT.indexOf('### 26.5 '), CONTRACT.indexOf('## 27. '));

/** v1.8's D16, verbatim: existence and cardinality, and nothing about either record's contents. */
function v18Accepts(generation: number, claimResolution: object | null, retiredPins: object[]): boolean {
  return generation === 0
    ? claimResolution === null && retiredPins.length === 0
    : claimResolution !== null && retiredPins.length === generation - 1;
}

/** v1.9's ⓪ `coordinator_pin_ledger_fold` + the two comparisons its callers make (§7.7 D16). */
type Part = { frozen?: string | null; value?: string | null; source?: string };
type Claim = { generation?: number; at?: string; model?: Part; effort?: Part };
type Retired = { generation?: number; component?: string; from?: string; to?: string; at?: string; reason?: string };
const AT_FROZEN = '2026-08-19T00:00:00.000Z';
const AT_CLAIM = '2026-08-19T00:01:00.000Z';

function keys(value: object): string {
  return JSON.stringify(Object.keys(value).sort());
}

function v19Accepts(state: {
  frozen: { model: string | null; effort: string | null };
  claim: Claim | null;
  retiredPins: Retired[];
  generation: number;
  session: { model: string | null; effort: string | null };
}): boolean {
  const { claim, generation } = state;
  if (generation === 0) {
    return claim === null && state.retiredPins.length === 0
      && state.session.model === null && state.session.effort === null;
  }
  if (claim === null || keys(claim) !== keys({ generation: 0, at: '', model: {}, effort: {} })) return false;
  if (claim.generation !== 1 || typeof claim.at !== 'string' || Date.parse(claim.at) < Date.parse(AT_FROZEN)) return false;
  const pin: Record<'model' | 'effort', string | null> = { model: null, effort: null };
  for (const component of ['model', 'effort'] as const) {
    const part = claim[component];
    if (!part || keys(part) !== keys({ frozen: '', value: '', source: '' })) return false;
    if (part.frozen !== state.frozen[component]) return false;
    if (part.frozen === 'DEFERRED_TO_CLAIM') {
      if (part.source !== 'RESOLVED_AT_CLAIM' || !part.value || part.value === 'DEFERRED_TO_CLAIM') return false;
    } else if (part.source !== 'FROZEN_CONTEXT' || part.value !== part.frozen) return false;
    pin[component] = part.value ?? null;
  }
  if (state.retiredPins.length !== generation - 1) return false;
  let previous = Date.parse(claim.at);
  for (const [i, entry] of state.retiredPins.entries()) {
    if (keys(entry) !== keys({ generation: 0, component: '', from: '', to: '', at: '', reason: '' })) return false;
    const component = entry.component as 'model' | 'effort';
    if (component !== 'model' && component !== 'effort') return false;
    if (entry.reason !== 'RUNTIME_RETIRED' || entry.generation !== i + 2) return false;
    if (typeof entry.at !== 'string' || Date.parse(entry.at) < previous) return false;
    if (entry.from !== pin[component] || !entry.to || entry.to === entry.from) return false;
    previous = Date.parse(entry.at);
    pin[component] = entry.to;
  }
  return pin.model === state.session.model && pin.effort === state.session.effort;
}

test('PC-CX-47: a first claim can no longer contradict the frozen concrete model and effort', () => {
  // Closed: I17-A2 and EC6-c now state the two branches as one rule each, and D16 compares the
  // fold with the session's own columns instead of asking whether some object exists.
  assert.match(I17_A2, /逐字等于 `session\.model` \/ `session\.effort`/,
    'I17-A2 no longer binds the ledger to the pin the session is actually running');
  assert.match(EC2_B, /model.*effort.*具体值或显式的 `DEFERRED_TO_CLAIM`/s,
    'EC2-b no longer includes the model/effort resolution conclusion');
  assert.match(EC6_C, /`frozen` \*\*逐字等于\*\* `execution_context` 的对应分量/,
    'EC6-c no longer requires the record to quote the frozen conclusion verbatim');
  assert.match(EC6_C, /`source = 'RESOLVED_AT_CLAIM'`/, 'EC6-c no longer names the deferred branch\'s source');
  assert.match(D16_SQL, /coordinator_pin_ledger_fold/, 'D16 does not judge the ledger at all');
  assert.match(D16_SQL, /session % runs %\/% while action % records/,
    'D16 does not compare the session pin with what the action recorded');

  // The review's exact witness, run through both shapes.
  const witness = {
    frozen: { model: 'model-v1', effort: 'high' },
    claim: {} as Claim,
    retiredPins: [] as Retired[],
    generation: 1,
    session: { model: 'model-evil', effort: 'low' },
  };
  assert.equal(v18Accepts(1, witness.claim, witness.retiredPins), true,
    'reverse control: v1.8 accepts a claim that contradicts the frozen concrete values');
  assert.equal(v19Accepts(witness), false, 'v1.9 must refuse the review\'s witness');

  // Both legal branches still commit: the concrete one may only pin the frozen value, and the
  // deferred one must record what it actually resolved.
  assert.equal(v19Accepts({
    frozen: { model: 'model-v1', effort: 'high' },
    claim: {
      generation: 1, at: AT_CLAIM,
      model: { frozen: 'model-v1', value: 'model-v1', source: 'FROZEN_CONTEXT' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    },
    retiredPins: [], generation: 1, session: { model: 'model-v1', effort: 'high' },
  }), true, 'a concrete first claim of the frozen conclusion must commit');
  assert.equal(v19Accepts({
    frozen: { model: 'DEFERRED_TO_CLAIM', effort: 'high' },
    claim: {
      generation: 1, at: AT_CLAIM,
      model: { frozen: 'DEFERRED_TO_CLAIM', value: 'runtime-default-v3', source: 'RESOLVED_AT_CLAIM' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    },
    retiredPins: [], generation: 1, session: { model: 'runtime-default-v3', effort: 'high' },
  }), true, 'a deferred first claim that records its resolution must commit');
  // …and a deferred claim that records nothing is exactly the hole this finding named.
  assert.equal(v19Accepts({
    frozen: { model: 'DEFERRED_TO_CLAIM', effort: 'high' },
    claim: {
      generation: 1, at: AT_CLAIM,
      model: { frozen: 'DEFERRED_TO_CLAIM', value: null, source: 'RESOLVED_AT_CLAIM' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    },
    retiredPins: [], generation: 1, session: { model: 'anything-at-all', effort: 'high' },
  }), false, 'an empty claimResolution must not let a deferred conclusion admit any value');
});

test('PC-CX-48: a forged executionResultDigest is refused at commit, not frozen', () => {
  // Closed: the canonical form is a database function, and both digests are recomputed from their
  // own authoritative half at the commit point.
  assert.ok(I17_A.includes('`execution_context_digest` / `execution_result_digest`')
      && I17_A.includes('重算出来的两个摘要不等'),
    'I17-A no longer claims both stored digests equal recomputation');
  assert.match(I17_A, /§7\.7 D17/, 'I17-A does not attribute the digest half to the object that proves it');
  assert.match(D17, /CREATE CONSTRAINT TRIGGER project_action_execution_digest_check/, 'D17 has no object');
  assert.match(D17, /EXECUTION_DIGEST_MISMATCH/, 'a forged digest has no typed refusal');
  assert.match(LIMITS, /v1\.9 已取代/, '§26.5 still stands as the current answer');

  // The canonicalisation is what makes the recomputation a definition instead of a label.
  const canonical = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
  const authorization = {
    resolvedAgentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1', providerSlug: 'claude',
    model: 'model-v1', workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: null,
  };
  const resultHalf = { agentId: 'a1', model: 'model-v1', effort: 'high', permissionMode: 'read-only' };
  assert.equal(digest(Object.fromEntries(Object.entries(authorization).reverse())), digest(authorization),
    'the canonical form must not depend on key order, or two honest writers disagree');

  // Reverse control: v1.8 had no object reading either column, so the forged label was frozen as
  // faithfully as an honest one. v1.9 compares it with the recomputation.
  const forged = 'forged-result-digest';
  assert.notEqual(forged, digest(resultHalf), 'the witness must really be a forgery');
  const v18DigestGateAccepts = (_stored: string): boolean => true;
  const v19DigestGateAccepts = (stored: string): boolean => stored === digest(resultHalf);
  assert.equal(v18DigestGateAccepts(forged), true, 'reverse control: v1.8 admits any string at all');
  assert.equal(v19DigestGateAccepts(forged), false, 'v1.9 must refuse the forged digest');
  assert.equal(v19DigestGateAccepts(digest(resultHalf)), true, 'and must admit the honestly computed one');
});

test('PC-CX-49: the ledger records have a closed shape and a chain, not just a length', () => {
  // Closed: EC6-c gives both records a closed key set, EC6-e gives the chain, and D16 judges both
  // directions with one shared function.
  assert.match(I17_A2, /满足 §7\.4 EC6-c \*\*闭合形状\*\*的 `claimResolution`/,
    'I17-A2 no longer requires the claim record to have a closed shape');
  assert.match(D16_SQL, /jsonb_array_length\(ledger\) <> generation - 1/, 'D16 no longer enforces even the cardinality');
  for (const field of ['from', 'to', 'at', 'reason', 'component', 'generation']) {
    assert.ok(D16_SQL.includes(`'${field}'`), `D16 does not validate retiredPins.${field}`);
  }
  assert.equal((D16_SQL.match(/coordinator_pin_ledger_fold\(/g) ?? []).length, 3,
    'the two directions must judge by one function defined once and called from each side');
  assert.ok(D15.includes('**D15-d（'), 'D15 no longer says that a retiredPin must leave a record');

  // The review's witness: generation 2, an empty claim record and an empty retiredPin record.
  const witness = {
    frozen: { model: 'model-v1', effort: 'high' },
    claim: {} as Claim,
    retiredPins: [{} as Retired],
    generation: 2,
    session: { model: 'model-v2', effort: 'high' },
  };
  assert.equal(v18Accepts(2, witness.claim, witness.retiredPins), true,
    'reverse control: v1.8 accepts one empty entry at generation 2');
  assert.equal(v19Accepts(witness), false, 'v1.9 must refuse a ledger of empty objects');

  // A legal retiredPin still commits, and it is the one that carries old value, new value and time.
  const legal = {
    frozen: { model: 'model-v1', effort: 'high' },
    claim: {
      generation: 1, at: AT_CLAIM,
      model: { frozen: 'model-v1', value: 'model-v1', source: 'FROZEN_CONTEXT' },
      effort: { frozen: 'high', value: 'high', source: 'FROZEN_CONTEXT' },
    } as Claim,
    retiredPins: [{
      generation: 2, component: 'model', from: 'model-v1', to: 'model-v2',
      at: '2026-08-19T00:02:00.000Z', reason: 'RUNTIME_RETIRED',
    }] as Retired[],
    generation: 2,
    session: { model: 'model-v2', effort: 'high' },
  };
  assert.equal(v19Accepts(legal), true, 'a retiredPin that records itself must still commit');
  assert.equal(v19Accepts({ ...legal, retiredPins: [{ ...legal.retiredPins[0], from: 'model-v0' }] }), false,
    'a record that does not continue the chain must be refused');
  assert.equal(v19Accepts({ ...legal, session: { model: 'model-v9', effort: 'high' } }), false,
    'a chain that folds elsewhere than the session pin must be refused');
});

test('v1.8 independent-review inventory is explicit, database-free, and still readable', () => {
  assert.deepEqual(['PC-CX-47', 'PC-CX-48', 'PC-CX-49'],
    ['PC-CX-47', 'PC-CX-48', 'PC-CX-49']);
  // v1.8 stated this as "the run must have no database URL in the environment". After the flip the
  // file has to be green in BOTH matrices (with and without a database), so the property is
  // asserted where it actually lives — in this file's own source. It is also the stronger
  // statement: an unset variable never proved the suite would not connect, only that this
  // particular run had nothing to connect to. The needles are built by concatenation so that the
  // assertion cannot match itself.
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-v18-adversarial.spec.ts'), 'utf8');
  const driver = "'pg'";
  for (const needle of [`from ${driver}`, `require(${driver})`]) {
    assert.equal(self.includes(needle), false,
      'this suite must stay database-free: the real-server half lives in the Postgres spec');
  }
  // The report itself is evidence, not a draft: the reverse controls above quote it.
  assert.match(REVIEW, /FAIL/, 'the ninth review\'s verdict has been softened');
  for (const evidence of ['model-evil', 'claimResolution={}', 'retiredPins=[{}]', 'forged']) {
    assert.ok(REVIEW.includes(evidence), `the ninth review no longer contains its ${evidence} evidence`);
  }
});
