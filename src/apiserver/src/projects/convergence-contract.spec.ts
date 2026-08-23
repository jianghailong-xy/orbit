import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, headingNumbers, section, tables } from './contract-doc';
import {
  CHECKPOINT_RECORD_REFUSALS,
  checkpointContentDigest,
} from './task-checkpoint';
import {
  EvidenceFreshness,
  actionIdentity,
  evidenceSupportsProgress,
  hypothesisIdentity,
} from './convergence-evidence';
import { EMPTY_PROGRESS_VECTOR } from './convergence-progress';
import {
  AttemptBudget,
  CLASSIFICATION_COUNTER,
  CLASSIFICATION_OUTCOME,
  CONVERGENCE_CLASSIFICATIONS,
  CONVERGENCE_DISPATCH_REFUSALS,
  CONVERGENCE_EVENTS,
  CONVERGENCE_TRANSITIONS,
  DEFAULT_ATTEMPT_BUDGET,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  DISPATCHABLE_PROGRESS_STATES,
  ConvergenceClassification,
  ConvergenceEvent,
  ConvergenceThresholds,
  MERGE_GATE_REFUSALS,
  PROGRESS_RESET_COUNTERS,
  SCOPE_ACTIONS,
  SCOPE_ACTORS,
  SCOPE_AUTHORITY,
  ScopeAction,
  ScopeActor,
  authorizeScopeAction,
  NON_CONVERGENCE_PRIORITY,
  NonConvergenceReason,
  NON_CONVERGENCE_RULE,
  REPLAN_EXIT_EVENTS,
  TASK_PROGRESS_STATES,
  TaskProgressState,
  isDispatchableProgressState,
  progressStateAfter,
  resolveAttemptBudget,
  resolveThresholds,
} from './convergence-contract';

// `[K1]`. The bounded-convergence rules are frozen in a document AND implemented as tables in
// `convergence-contract.ts`; this holds the two to each other the way `coordinator-contract.spec.ts`
// holds the main contract to itself. A threshold that is raised in code and not in the document is
// the specific mistake that ends with nobody able to say what the breaker's limits are.
const REPO = path.resolve(__dirname, '../../../..');
const DOC = readFileSync(path.join(REPO, 'docs/project-coordinator-convergence-contract.md'), 'utf8');

/** The one table in a section, addressed by a header so a section holding two cannot be misread. */
function tableWith(sectionNumber: string, header: string): string[][] {
  const found = tables(section(DOC, sectionNumber)).find((t) => t[0].some((h) => bare(h) === header));
  assert.ok(found, `§${sectionNumber} no longer states a table headed "${header}"`);
  return found;
}

/** One `- **NAME**：…` rule, whole, including the lines it wraps onto. */
function rule(sectionNumber: string, name: string): string {
  const found = section(DOC, sectionNumber)
    .split(/\n(?=- \*\*)/)
    .find((chunk) => chunk.startsWith(`- **${name}**`));
  assert.ok(found, `§${sectionNumber} no longer states ${name}`);
  return found;
}

test('§0–§9 all exist, and the code names the version the document does', () => {
  const headings = headingNumbers(DOC);
  for (const n of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    assert.ok(headings.has(n), `§${n} is missing from the convergence contract`);
  }
  // v1.2: `[K3]` added the two attempt-budget dimensions §8's prose already relied on, and `[K4]`
  // added the two threshold rows the incident crossed without a line — the repeated ACTION and the
  // repair that repairs nothing.
  //
  // v1.3: `[K6]` wrote §7's second half. CP1–CP4 were frozen at v1.0 and are unchanged; what is
  // new is the shape a checkpoint is RECORDED in (a table that had to exist before anything could
  // write one), its own refusal vocabulary, and CP5 — the question that has to be asked before all
  // of them, and whose absence let a merge replay twenty-two commits into a target that already
  // held every one of them. Every other table is still byte-identical to the frozen v1.0, and the
  // assertions below say so.
  assert.match(DOC.split('\n')[0], /有界收敛契约 v1\.3$/);
});

test('§2: the state table and the code list exactly the same states', () => {
  const stated = column(tableWith('2', '状态'), '状态').map((cell) => bare(cell) as TaskProgressState);
  assert.deepEqual([...stated].sort(), [...TASK_PROGRESS_STATES].sort());
  assert.equal(stated.length, new Set(stated).size, 'a state is listed twice');
});

test('§2: the dispatchable column is the code list', () => {
  const rows = tableWith('2', '状态');
  const states = column(rows, '状态').map(bare);
  const dispatchable = column(rows, '是否可自动派发').map(bare);
  const fromDoc = states.filter((_, i) => dispatchable[i] === '是');
  assert.deepEqual([...fromDoc].sort(), [...DISPATCHABLE_PROGRESS_STATES].sort());
  for (const state of TASK_PROGRESS_STATES) {
    assert.equal(isDispatchableProgressState(state), fromDoc.includes(state));
  }
});

test('§2: the transition table replays row for row', () => {
  const rows = tableWith('2', '起始状态');
  const from = column(rows, '起始状态').map(bare);
  const event = column(rows, '事件').map(bare);
  const to = column(rows, '目标状态').map(bare);

  const seen = new Set<string>();
  for (let i = 0; i < from.length; i++) {
    const pair = `${from[i]}/${event[i]}`;
    assert.ok(!seen.has(pair), `§2 states ${pair} twice — the table must be determinate`);
    seen.add(pair);
    assert.equal(
      progressStateAfter(from[i] as TaskProgressState, event[i] as ConvergenceEvent),
      to[i],
      `§2 row "${pair} → ${to[i]}" is not what the code does`,
    );
  }

  // And the other direction: no edge in code that the document does not state.
  let coded = 0;
  for (const state of TASK_PROGRESS_STATES) {
    for (const [ev, next] of Object.entries(CONVERGENCE_TRANSITIONS[state])) {
      coded++;
      assert.ok(seen.has(`${state}/${ev}`), `code has an undocumented edge ${state}/${ev} → ${next}`);
    }
  }
  assert.equal(coded, from.length);
});

test('§2 SM1: SETTLED has no outgoing edge', () => {
  assert.deepEqual(CONVERGENCE_TRANSITIONS.SETTLED, {});
  for (const event of CONVERGENCE_EVENTS) {
    assert.equal(progressStateAfter('SETTLED', event), null);
  }
});

test('§2 SM2: ATTEMPT_STARTED is only legal from a dispatchable state', () => {
  for (const state of TASK_PROGRESS_STATES) {
    const moves = progressStateAfter(state, 'ATTEMPT_STARTED') !== null;
    assert.equal(moves, DISPATCHABLE_PROGRESS_STATES.includes(state), state);
  }
});

test('§2 SM3: CIRCUIT_TRIPPED is reachable from every non-terminal state and lands on NEEDS_REPLAN', () => {
  for (const state of TASK_PROGRESS_STATES) {
    if (state === 'SETTLED' || state === 'NEEDS_REPLAN' || state === 'AWAITING_HUMAN') continue;
    assert.equal(progressStateAfter(state, 'CIRCUIT_TRIPPED'), 'NEEDS_REPLAN', state);
  }
  // Tripping a task that is already parked is a no-op rather than a second trip: both states are
  // already waiting on a person, and a redelivered event must not re-open anything.
  assert.equal(progressStateAfter('NEEDS_REPLAN', 'CIRCUIT_TRIPPED'), null);
  assert.equal(progressStateAfter('AWAITING_HUMAN', 'CIRCUIT_TRIPPED'), null);
});

test('§2 SM4: NEEDS_REPLAN has exactly three exits and every one needs an explicit decision', () => {
  const exits = Object.keys(CONVERGENCE_TRANSITIONS.NEEDS_REPLAN)
    .filter((event) => event !== 'TASK_TERMINAL');
  assert.deepEqual([...exits].sort(), [...REPLAN_EXIT_EVENTS].sort());
  // None of the three can be produced by time passing, a restart or a duplicate event: they are
  // authorizations. This is asserted as a naming property because the events ARE the vocabulary.
  for (const exit of REPLAN_EXIT_EVENTS) {
    assert.match(exit, /AUTHORIZED|EXTENDED|HUMAN_REQUIRED/);
  }
});

test('§3: classifications, their single outcome and the counter each one spends', () => {
  const rows = tableWith('3', '分类');
  const classes = column(rows, '分类').map(bare);
  const outcomes = column(rows, '唯一合法结果').map(bare);
  const counters = column(rows, '计入').map(bare);
  assert.deepEqual([...classes].sort(), [...CONVERGENCE_CLASSIFICATIONS].sort());
  for (let i = 0; i < classes.length; i++) {
    assert.equal(CLASSIFICATION_OUTCOME[classes[i] as ConvergenceClassification], outcomes[i], classes[i]);
    const coded = CLASSIFICATION_COUNTER[classes[i] as ConvergenceClassification];
    assert.equal(coded ?? '不计入', counters[i], classes[i]);
  }
});

test('§3 CL1: ENVIRONMENT and HUMAN_REQUIRED spend no attempt budget', () => {
  assert.equal(CLASSIFICATION_COUNTER.ENVIRONMENT, null);
  assert.equal(CLASSIFICATION_COUNTER.HUMAN_REQUIRED, null);
});

test('§4 PV1: the progress vector table names activity nowhere', () => {
  const fields = column(tableWith('4', '字段'), '字段').map(bare);
  for (const forbidden of ['session', 'turn', 'token', 'tool', 'wallClock', 'commit', 'lines']) {
    assert.ok(
      !fields.some((f) => f.toLowerCase().includes(forbidden.toLowerCase())),
      `§4 must not make "${forbidden}" a progress dimension — activity is not progress (RL0)`,
    );
  }
});

test('§8: the default thresholds are the document\'s numbers, and every one of them is finite', () => {
  const rows = tableWith('8', '阈值');
  const names = column(rows, '阈值').map(bare);
  const values = column(rows, '默认值').map(bare);
  const reasons = column(rows, '触发后的 reason').map(bare);
  assert.equal(names.length, Object.keys(DEFAULT_CONVERGENCE_THRESHOLDS).length);
  for (let i = 0; i < names.length; i++) {
    const coded = DEFAULT_CONVERGENCE_THRESHOLDS[names[i] as keyof ConvergenceThresholds];
    assert.equal(coded, Number(values[i]), names[i]);
    assert.notEqual(coded, null, `${names[i]} must default to a finite number`);
    assert.equal(NON_CONVERGENCE_RULE[reasons[i] as NonConvergenceReason].threshold, names[i]);
  }
});

test('§8: the per-attempt resource budget matches, and is finite', () => {
  const rows = tableWith('8', '维度');
  const dims = column(rows, '维度').map(bare);
  const values = column(rows, '默认值').map(bare);
  assert.equal(dims.length, Object.keys(DEFAULT_ATTEMPT_BUDGET).length);
  for (let i = 0; i < dims.length; i++) {
    assert.equal(DEFAULT_ATTEMPT_BUDGET[dims[i] as keyof AttemptBudget], Number(values[i]), dims[i]);
  }
});

test('§8 TH1: the priority order in the document is the order in the code', () => {
  const stated = section(DOC, '8')
    .split('\n')
    .filter((line) => line.includes('TH1') || /^\s{2}`[A-Z_]+`/.test(line))
    .join('\n')
    .match(/`([A-Z_]+)`/g)
    ?.map((m) => m.replace(/`/g, ''))
    .filter((token) => (NON_CONVERGENCE_PRIORITY as readonly string[]).includes(token)) ?? [];
  assert.deepEqual(stated, [...NON_CONVERGENCE_PRIORITY]);
  assert.equal(new Set(NON_CONVERGENCE_PRIORITY).size, NON_CONVERGENCE_PRIORITY.length);
});

test('§9: the two dispatch refusals are stated and coded identically', () => {
  const stated = column(tableWith('9', '拒绝码'), '拒绝码').map(bare);
  assert.deepEqual([...stated].sort(), [...CONVERGENCE_DISPATCH_REFUSALS].sort());
});

test('§7 CP3: the merge-gate refusal codes are stated and coded identically', () => {
  const stated = column(tableWith('7', '拒绝码'), '拒绝码').map(bare);
  assert.deepEqual([...stated].sort(), [...MERGE_GATE_REFUSALS].sort());
});

test('§7: the checkpoint RECORD refusals are stated and coded identically', () => {
  // A second table with its own header rather than more rows on CP3's. The two answer different
  // questions — one refuses a WRITE, the other refuses a RELEASE — and folding them together would
  // make "why can this not be recorded" and "why can this not be merged" one vocabulary, which is
  // how a caller ends up handling a merge refusal by editing the checkpoint it already wrote.
  const stated = column(tableWith('7', '记录拒绝码'), '记录拒绝码').map(bare);
  assert.deepEqual([...stated].sort(), [...CHECKPOINT_RECORD_REFUSALS].sort());
});

test('§7: the two refusal vocabularies stay disjoint apart from the one they share', () => {
  // `SCOPE_REVISION_MISMATCH` is deliberately in both: a conclusion measured against a question
  // nobody is asking any more is the same defect whether it is being written down or acted on.
  // Anything ELSE appearing in both would mean one code has two meanings.
  const shared = MERGE_GATE_REFUSALS.filter((r) =>
    (CHECKPOINT_RECORD_REFUSALS as readonly string[]).includes(r),
  );
  assert.deepEqual(shared, ['SCOPE_REVISION_MISMATCH']);
});

test('§7 CP1: the recorded shape in the document is the shape the code hashes', () => {
  // CP1's identity is "every field, hashed", so the document's field table and the digest have to
  // list the same fields. A field in the table but outside the digest is a field somebody can
  // change without making a new checkpoint, which is exactly what CP1 forbids.
  const fields = column(tableWith('7', '字段'), '字段').join(' ');
  for (const name of ['kind', 'commitSha', 'treeSha', 'baseSha', 'evidenceDigest', 'artifact']) {
    assert.ok(fields.includes(name), `§7 no longer states the ${name} column`);
  }
  const base = {
    kind: 'ACCEPTED' as const,
    commit: { branch: 'b', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), baseSha: 'c'.repeat(40) },
    evidenceDigest: 'd'.repeat(64),
    artifact: { kind: 'GIT_BUNDLE' as const, ref: 'r', digest: 'e'.repeat(64) },
  };
  const digests = new Set([
    checkpointContentDigest(base),
    checkpointContentDigest({ ...base, kind: 'WIP_RED' }),
    checkpointContentDigest({ ...base, commit: { ...base.commit, branch: 'other' } }),
    checkpointContentDigest({ ...base, commit: { ...base.commit, commitSha: 'f'.repeat(40) } }),
    checkpointContentDigest({ ...base, commit: { ...base.commit, treeSha: 'f'.repeat(40) } }),
    checkpointContentDigest({ ...base, commit: { ...base.commit, baseSha: 'f'.repeat(40) } }),
    checkpointContentDigest({ ...base, evidenceDigest: '1'.repeat(64) }),
    checkpointContentDigest({ ...base, artifact: { ...base.artifact, ref: 'other' } }),
    checkpointContentDigest({ ...base, artifact: { ...base.artifact, digest: '1'.repeat(64) } }),
  ]);
  assert.equal(digests.size, 9, 'a stated field does not take part in the identity');
});

test('OW4: an unbounded threshold without a USER authorizer falls back to the finite default', () => {
  const unsigned = resolveThresholds({ maxAttemptsPerScopeRevision: null }, null);
  assert.equal(unsigned.maxAttemptsPerScopeRevision, DEFAULT_CONVERGENCE_THRESHOLDS.maxAttemptsPerScopeRevision);
  const signed = resolveThresholds(
    { maxAttemptsPerScopeRevision: null },
    { actor: 'USER', principal: '2p7QMFOwEGtL5oaTxZHihm' },
  );
  assert.equal(signed.maxAttemptsPerScopeRevision, null);

  // The signature an agent can produce by itself is not a smaller version of the user's — it is
  // not one. An unattributed or blank principal is not one either.
  for (const actor of ['COORDINATOR', 'WORKER', 'VERIFIER'] as ScopeActor[]) {
    const forged = resolveThresholds({ maxAttemptsPerScopeRevision: null }, { actor, principal: 'a' });
    assert.equal(
      forged.maxAttemptsPerScopeRevision,
      DEFAULT_CONVERGENCE_THRESHOLDS.maxAttemptsPerScopeRevision,
      `${actor} must not be able to sign away the breaker`,
    );
  }
  assert.equal(
    resolveThresholds({ maxAttemptsPerScopeRevision: null }, { actor: 'USER', principal: '  ' })
      .maxAttemptsPerScopeRevision,
    DEFAULT_CONVERGENCE_THRESHOLDS.maxAttemptsPerScopeRevision,
  );

  // The same rule for the resource budget, and for garbage: a negative or fractional override is
  // not an override, because the alternative is a breaker configured out of existence by a typo.
  assert.equal(resolveAttemptBudget({ maxTurns: null }, null).maxTurns, DEFAULT_ATTEMPT_BUDGET.maxTurns);
  assert.equal(
    resolveAttemptBudget({ maxTurns: null }, { actor: 'COORDINATOR', principal: 'coordinator' }).maxTurns,
    DEFAULT_ATTEMPT_BUDGET.maxTurns,
  );
  assert.equal(resolveAttemptBudget({ maxTurns: 0 }, null).maxTurns, DEFAULT_ATTEMPT_BUDGET.maxTurns);
  assert.equal(resolveAttemptBudget({ maxTurns: 1.5 }, null).maxTurns, DEFAULT_ATTEMPT_BUDGET.maxTurns);
  assert.equal(resolveAttemptBudget({ maxTurns: 12 }, null).maxTurns, 12);
  assert.equal(resolveThresholds({ maxSameFingerprintRepeats: -1 }, null).maxSameFingerprintRepeats, 2);
  // Zero IS a legal threshold — §8 gives `maxScopeExpansionRequests` exactly that value.
  assert.equal(resolveThresholds({ maxVerificationRounds: 0 }, null).maxVerificationRounds, 0);
});

test('§1: the authority table is stated and coded cell for cell', () => {
  const rows = tableWith('1', '动作');
  const actions = column(rows, '动作').map(bare);
  assert.deepEqual([...actions].sort(), [...SCOPE_ACTIONS].sort());
  for (const actor of SCOPE_ACTORS) {
    const stated = column(rows, actor).map(bare);
    for (let i = 0; i < actions.length; i++) {
      assert.equal(
        SCOPE_AUTHORITY[actor][actions[i] as ScopeAction],
        stated[i],
        `§1 cell ${actor} × ${actions[i]}`,
      );
    }
  }
  assert.deepEqual([...Object.keys(SCOPE_AUTHORITY)].sort(), [...SCOPE_ACTORS].sort());
});

test('§1 OW1/OW2: no agent may revise scope or add an acceptance criterion, under any policy', () => {
  for (const policy of ['MANUAL', 'GUARDED_AUTO', 'AUTO'] as const) {
    for (const actor of ['WORKER', 'VERIFIER'] as ScopeActor[]) {
      assert.notEqual(authorizeScopeAction(actor, 'REVISE_SCOPE', policy), 'ALLOWED', `${actor}/${policy}`);
      assert.notEqual(authorizeScopeAction(actor, 'ADD_ACCEPTANCE_CRITERION', policy), 'ALLOWED');
      // …but saying so is always allowed. Refusing the report as well would leave a worker that
      // found a genuinely mis-sized task with no legal move at all.
      assert.equal(authorizeScopeAction(actor, 'REQUEST_SCOPE_EXPANSION', policy), 'ALLOWED');
      assert.equal(authorizeScopeAction(actor, 'REPORT_FINDING', policy), 'ALLOWED');
    }
    // OW3/OW5: `AUTO` opens the coordinator's re-plan cell and nothing else.
    assert.equal(
      authorizeScopeAction('COORDINATOR', 'REVISE_SCOPE', policy),
      policy === 'AUTO' ? 'ALLOWED' : 'REPLAN_REQUIRES_AUTHORIZATION',
    );
    assert.notEqual(authorizeScopeAction('COORDINATOR', 'ADD_ACCEPTANCE_CRITERION', policy), 'ALLOWED');
    assert.notEqual(authorizeScopeAction('COORDINATOR', 'AUTHORIZE_UNBOUNDED', policy), 'ALLOWED');
    // OW4: the user is the only actor every cell is open to.
    for (const action of SCOPE_ACTIONS) {
      assert.equal(authorizeScopeAction('USER', action, policy), 'ALLOWED', action);
    }
  }
});

test('§4 PV4: the reset set is the four the document names, and the three absolutes are outside it', () => {
  const pv4 = rule('4', 'PV4');
  const [resets, absolutes] = pv4.split('绝对计数');
  assert.ok(absolutes, '§4 PV4 must still name the counters progress does NOT reset');
  for (const counter of PROGRESS_RESET_COUNTERS) {
    assert.ok(resets.includes(counter), `§4 PV4 must name ${counter} as reset by strict progress`);
  }
  assert.equal(PROGRESS_RESET_COUNTERS.length, 5);
  for (const absolute of ['attemptsOnRevision', 'verificationRounds', 'scopeExpansionRequests']) {
    assert.ok(absolutes.includes(absolute), `§4 PV4 must name ${absolute} as 永不清零`);
    assert.ok(
      !(PROGRESS_RESET_COUNTERS as readonly string[]).includes(absolute),
      `${absolute} must survive strict progress — §4 PV4 calls it 永不清零`,
    );
  }
});

test('§4 PV6: the freshness readings are the code\'s, and only FRESH may claim progress', () => {
  const stated = column(tableWith('4', '读数'), '读数').map(bare) as EvidenceFreshness[];
  assert.deepEqual([...stated].sort(), ['FRESH', 'STALE', 'UNMEASURED']);
  const claims = column(tableWith('4', '读数'), '能否刷新 lastProgressAt').map(bare);
  for (let i = 0; i < stated.length; i++) {
    assert.equal(
      evidenceSupportsProgress({ freshness: stated[i], evidenceAsOf: null, staleItems: [] }),
      claims[i] === '能',
      `§4 PV6 row ${stated[i]}`,
    );
  }
  // PV1 again, from the other side: freshness must not have become a ninth dimension while nobody
  // was looking. The vector's fields are §4's table and this reading is not one of them.
  const fields = column(tableWith('4', '字段'), '字段').map(bare);
  assert.deepEqual([...fields].sort(), Object.keys(EMPTY_PROGRESS_VECTOR).sort());
  assert.ok(!fields.some((f) => /fresh|evidence/i.test(f)));
});

test('§5.1: the action identity is over the document\'s four fields and nothing else', () => {
  const stated = column(tableWith('5', '动作字段'), '动作字段').map(bare);
  assert.deepEqual([...stated].sort(), ['hypothesis', 'kind', 'scopeHash', 'target']);
  // FP5: the generation is in the idempotency KEY and never in the identity. Stated as a property
  // of the values rather than of the names, because the failure it refuses is silent — an identity
  // that varied per generation would simply never report a repeat.
  const facts = { kind: 'DISPATCH_ATTEMPT', target: 'branch', hypothesis: 'retry the suite', scopeHash: 'abc' };
  assert.equal(actionIdentity(facts), actionIdentity({ ...facts }));
  // FP4: §5's normalization, so an id, a timestamp and a constant are the same proposal.
  assert.equal(
    actionIdentity({ ...facts, hypothesis: 'retry session 3f7c1a52-9d3e-4b8f-8a21-77dcb0c5e9a1 with timeout 5' }),
    actionIdentity({ ...facts, hypothesis: 'retry session 91b0dd47-2e6a-42c1-9f70-1d4ab8e63c05 with timeout 30' }),
  );
  // FP2's other side: a genuinely different plan is a different identity.
  assert.notEqual(actionIdentity(facts), actionIdentity({ ...facts, kind: 'FILE_DEFECT' }));
  // FP3/FP6: a new revision is a new question, so the same words are a different proposal.
  assert.notEqual(actionIdentity(facts), actionIdentity({ ...facts, scopeHash: 'def' }));
  assert.notEqual(
    hypothesisIdentity('retry the suite', 'abc'),
    hypothesisIdentity('retry the suite', 'def'),
  );
});

test('§8: the two attempt lines read different counters, and only one of them resets', () => {
  // The defect this unit was reviewed for: one threshold pointed at the counter that never resets,
  // so a task closing one acceptance item per attempt was cut off at attempt six. They are two
  // questions — "is this hypothesis working" and "was this task sized right" — and one counter
  // cannot answer both.
  const budget = NON_CONVERGENCE_RULE.ATTEMPT_BUDGET_EXHAUSTED;
  const cap = NON_CONVERGENCE_RULE.HARD_ATTEMPT_CAP_REACHED;
  assert.notEqual(budget.counter, cap.counter);
  assert.ok((PROGRESS_RESET_COUNTERS as readonly string[]).includes(budget.counter));
  assert.ok(!(PROGRESS_RESET_COUNTERS as readonly string[]).includes(cap.counter));
  const budgetLimit = DEFAULT_CONVERGENCE_THRESHOLDS[budget.threshold] as number;
  const capLimit = DEFAULT_CONVERGENCE_THRESHOLDS[cap.threshold] as number;
  assert.ok(capLimit > budgetLimit, 'the hard cap must be looser than the no-progress budget');
});
