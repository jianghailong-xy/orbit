import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { bare, column, headingNumbers, section, tables } from './contract-doc';
import {
  AttemptBudget,
  DEFAULT_ATTEMPT_BUDGET,
  resolveAttemptBudget,
} from './convergence-contract';
import {
  ATTEMPT_BUDGET_DIMENSIONS,
  ATTEMPT_BUDGET_LIMIT,
  ATTEMPT_OUTCOMES,
  ATTEMPT_SEED_FIELDS,
  AttemptBudgetDimension,
  AttemptOutcome,
  AttemptSpend,
  PreviousAttempt,
  ZERO_ATTEMPT_SPEND,
  attemptObservationKey,
  authorizeAttemptLifecycle,
  authorizeFreshAttempt,
  authorizeSteer,
  buildAttemptSeed,
  evaluateAttemptBudget,
  hypothesisDigest,
  planAttemptClose,
} from './attempt-budget';

// `[K3]`. The unit's rules live in a document AND in tables in `attempt-budget.ts`; this holds the
// two to each other exactly as `convergence-contract.spec.ts` does for `[K1]`. A dimension added in
// code and not in the document is a limit nobody can name, which by RL1 is not a limit.
const REPO = path.resolve(__dirname, '../../../..');
const DOC = readFileSync(path.join(REPO, 'docs/project-coordinator-attempt-budget.md'), 'utf8');
const CONTRACT = readFileSync(
  path.join(REPO, 'docs/project-coordinator-convergence-contract.md'),
  'utf8',
);

function tableWith(doc: string, sectionNumber: string, header: string): string[][] {
  const found = tables(section(doc, sectionNumber))
    .find((t) => t[0].some((h) => bare(h) === header));
  assert.ok(found, `§${sectionNumber} no longer states a table headed "${header}"`);
  return found;
}

function rule(sectionNumber: string, name: string): string {
  const found = section(DOC, sectionNumber)
    .split(/\n(?=- \*\*)/)
    .find((chunk) => chunk.startsWith(`- **${name}**`));
  assert.ok(found, `§${sectionNumber} no longer states ${name}`);
  return found;
}

function spend(over: Partial<AttemptSpend> = {}): AttemptSpend {
  return { ...ZERO_ATTEMPT_SPEND, ...over };
}

const BUDGET: AttemptBudget = { ...DEFAULT_ATTEMPT_BUDGET };

// -------------------------------------------------------------------------------------------
// §0–§7 exist, and the document and the code agree about the dimensions.
// -------------------------------------------------------------------------------------------

test('§0–§7 all exist and the document names its version', () => {
  const headings = headingNumbers(DOC);
  for (const n of ['0', '1', '2', '3', '4', '5', '6', '7']) {
    assert.ok(headings.has(n), `§${n} is missing from the attempt-budget spec`);
  }
  assert.match(DOC.split('\n')[0], /有界 Session attempt 与自然轮换 v1\.0$/);
});

test('§1: the six dimensions are the code list, in the document\'s order (BD1)', () => {
  const stated = column(tableWith(DOC, '1', '维度'), '维度').map(bare);
  assert.deepEqual(stated, [...ATTEMPT_BUDGET_DIMENSIONS]);
  assert.equal(stated.length, new Set(stated).size, 'a dimension is listed twice');
});

test('§1: each dimension is bounded by the budget field the document names', () => {
  const rows = tableWith(DOC, '1', '维度');
  const dims = column(rows, '维度').map(bare);
  const fields = column(rows, '预算字段').map(bare);
  for (let i = 0; i < dims.length; i++) {
    assert.equal(ATTEMPT_BUDGET_LIMIT[dims[i] as AttemptBudgetDimension], fields[i], dims[i]);
  }
  // And every field the contract's §8 budget has is spent by exactly one dimension: a budget key
  // nothing reads is a limit that silently does not apply.
  assert.deepEqual(
    Object.values(ATTEMPT_BUDGET_LIMIT).sort(),
    (Object.keys(DEFAULT_ATTEMPT_BUDGET) as Array<keyof AttemptBudget>).sort(),
  );
});

test('the contract\'s §8 budget table carries the two dimensions `[K3]` added', () => {
  const rows = tableWith(CONTRACT, '8', '维度');
  const dims = column(rows, '维度').map(bare);
  const values = column(rows, '默认值').map(bare);
  for (const added of ['maxContextPercent', 'maxCoordinatorSteers']) {
    assert.ok(dims.includes(added), `§8's table does not carry ${added}`);
  }
  for (let i = 0; i < dims.length; i++) {
    assert.equal(DEFAULT_ATTEMPT_BUDGET[dims[i] as keyof AttemptBudget], Number(values[i]), dims[i]);
    assert.notEqual(
      DEFAULT_ATTEMPT_BUDGET[dims[i] as keyof AttemptBudget],
      null,
      `${dims[i]} must default to a finite value`,
    );
  }
});

// -------------------------------------------------------------------------------------------
// §1: the readings.
// -------------------------------------------------------------------------------------------

test('§1: every dimension is WITHIN with a readable remaining when nothing has been spent (BD4)', () => {
  const report = evaluateAttemptBudget(BUDGET, spend({ contextTokens: 0, contextWindow: 200_000 }));
  assert.equal(report.exhausted, null);
  assert.equal(report.windDownRequired, false);
  for (const reading of report.readings) {
    assert.equal(reading.state, 'WITHIN', reading.dimension);
    assert.equal(reading.remaining, reading.limit, reading.dimension);
    assert.notEqual(reading.remaining, null, `${reading.dimension} must report a remaining`);
  }
});

test('§1: each dimension trips on its own line and nothing else does', () => {
  const cases: Array<[AttemptBudgetDimension, Partial<AttemptSpend>]> = [
    ['CONTEXT', { contextTokens: 160_000, contextWindow: 200_000 }],
    ['WALL_CLOCK', { wallClockMs: 3_600_000 }],
    ['TURNS', { turns: 60 }],
    ['TOOL_CALLS', { toolCalls: 1_200 }],
    ['COST', { costMicros: 20_000_000 }],
    ['COORDINATOR_STEERS', { coordinatorSteers: 3 }],
  ];
  for (const [dimension, over] of cases) {
    const report = evaluateAttemptBudget(BUDGET, spend(over));
    assert.equal(report.exhausted, dimension, `${dimension} did not trip on its own limit`);
    const exhausted = report.readings.filter((r) => r.state === 'EXHAUSTED').map((r) => r.dimension);
    assert.deepEqual(exhausted, [dimension], `${dimension} took another dimension with it`);
    assert.equal(report.readings.find((r) => r.dimension === dimension)?.remaining, 0);
  }
});

test('§1 BD1: two lines crossed at once report ONE determinate dimension', () => {
  const report = evaluateAttemptBudget(BUDGET, spend({
    turns: 99,
    wallClockMs: 9_999_999,
    toolCalls: 9_999,
    costMicros: 99_000_000,
    contextTokens: 199_000,
    contextWindow: 200_000,
    coordinatorSteers: 9,
  }));
  assert.equal(report.exhausted, 'CONTEXT');
  // The order is the document's, top to bottom, and a replay of the same spend must not fork.
  const order = evaluateAttemptBudget(BUDGET, spend({ turns: 99, wallClockMs: 9_999_999 }));
  assert.equal(order.exhausted, 'WALL_CLOCK');
  assert.equal(
    evaluateAttemptBudget(BUDGET, spend({ turns: 99, toolCalls: 9_999 })).exhausted,
    'TURNS',
  );
});

test('§1 BD2: CONTEXT leads because a spent context cannot write the checkpoint TH2 asks for', () => {
  assert.equal(ATTEMPT_BUDGET_DIMENSIONS[0], 'CONTEXT');
  assert.match(rule('1', 'BD2'), /CONTEXT/);
  // 80% is a wind-down that still has room to write; 100% is one that does not.
  const room = evaluateAttemptBudget(BUDGET, spend({ contextTokens: 100, contextWindow: 1_000 }));
  assert.equal(room.exhausted, null);
});

test('§1 BD3: an unreported context window is UNMEASURED — not zero, not unbounded', () => {
  const report = evaluateAttemptBudget(BUDGET, spend({ contextTokens: null, contextWindow: null }));
  const context = report.readings.find((r) => r.dimension === 'CONTEXT');
  assert.equal(context?.state, 'UNMEASURED');
  assert.equal(context?.spent, null);
  assert.equal(context?.remaining, null);
  // Unmeasured does not trip...
  assert.equal(report.exhausted, null);
  // ...and does not disable the other five, so the attempt is still bounded.
  assert.equal(
    evaluateAttemptBudget(BUDGET, spend({ turns: 60 })).exhausted,
    'TURNS',
  );
  // A zero window is the same answer: a division by it would read as Infinity and declare an
  // attempt exhausted the instant it started, for a missing measurement rather than a spend.
  assert.equal(
    evaluateAttemptBudget(BUDGET, spend({ contextTokens: 10, contextWindow: 0 }))
      .readings.find((r) => r.dimension === 'CONTEXT')?.state,
    'UNMEASURED',
  );
});

test('§1: an unbounded dimension reads UNBOUNDED and never trips (OW4)', () => {
  const signed = resolveAttemptBudget(
    { maxTurns: null },
    { actor: 'USER', principal: 'wikova' },
  );
  const report = evaluateAttemptBudget(signed, spend({ turns: 10_000 }));
  const turns = report.readings.find((r) => r.dimension === 'TURNS');
  assert.equal(turns?.state, 'UNBOUNDED');
  assert.equal(turns?.remaining, null);
  assert.equal(report.exhausted, null);

  // An agent signing its own authorization is not a weaker authorization; the limit stays finite.
  const unsigned = resolveAttemptBudget(
    { maxTurns: null },
    { actor: 'COORDINATOR', principal: 'coordinator' },
  );
  assert.equal(unsigned.maxTurns, DEFAULT_ATTEMPT_BUDGET.maxTurns);
  assert.equal(evaluateAttemptBudget(unsigned, spend({ turns: 10_000 })).exhausted, 'TURNS');
});

test('§1 BD2: a spent steer budget does NOT ask the worker to wind down', () => {
  const report = evaluateAttemptBudget(BUDGET, spend({ coordinatorSteers: 3 }));
  assert.equal(report.exhausted, 'COORDINATOR_STEERS');
  assert.equal(report.windDownRequired, false, 'the coordinator ran out, not the worker');

  const worker = evaluateAttemptBudget(BUDGET, spend({ turns: 60 }));
  assert.equal(worker.windDownRequired, true);
});

test('§1 BD5: the frozen budget decides, so a policy edit cannot end or revive an attempt', () => {
  const frozen = evaluateAttemptBudget(BUDGET, spend({ turns: 59 }));
  assert.equal(frozen.exhausted, null);
  // The same spend against a tighter policy WOULD be over the line. An attempt judged by the live
  // policy would therefore end on somebody's PATCH rather than on what it spent.
  const tightened = evaluateAttemptBudget({ ...BUDGET, maxTurns: 10 }, spend({ turns: 59 }));
  assert.equal(tightened.exhausted, 'TURNS');
});

// -------------------------------------------------------------------------------------------
// §2: the close.
// -------------------------------------------------------------------------------------------

test('§2 NC2: the four outcomes are the document\'s, and CANCELLED is not one of them', () => {
  const stated = column(tableWith(DOC, '2', 'outcome'), 'outcome').map(bare);
  assert.deepEqual(stated, [...ATTEMPT_OUTCOMES]);
  assert.ok(!(ATTEMPT_OUTCOMES as readonly string[]).includes('CANCELLED'));
  // The type has no room for it either — this line is what would stop compiling.
  const outcomes: AttemptOutcome[] = ['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'BLOCKED'];
  assert.equal(outcomes.length, ATTEMPT_OUTCOMES.length);
});

test('§2 NC3: SUCCEEDED without an ACCEPTED checkpoint is refused', () => {
  const bare_ = planAttemptClose('OPEN', false, {
    outcome: 'SUCCEEDED', checkpoint: null, noCheckpointReason: null, classification: null,
  });
  assert.equal(bare_, 'ATTEMPT_CHECKPOINT_REQUIRED');

  const red = planAttemptClose('OPEN', false, {
    outcome: 'SUCCEEDED',
    checkpoint: { sha: 'abc', kind: 'WIP_RED', evidenceDigest: null },
    noCheckpointReason: null,
    classification: null,
  });
  assert.equal(red, 'ATTEMPT_CHECKPOINT_REQUIRED', 'a known-red experiment is not a success');

  const good = planAttemptClose('OPEN', false, {
    outcome: 'SUCCEEDED',
    checkpoint: { sha: 'abc', kind: 'ACCEPTED', evidenceDigest: 'tests:green' },
    noCheckpointReason: null,
    classification: null,
  });
  assert.notEqual(typeof good, 'string');
  assert.equal(typeof good === 'string' ? null : good.knownGoodSha, 'abc');
});

test('§2 NC3: a wind-down owes a checkpoint OR a reason, and a crash owes the reason', () => {
  const silent = planAttemptClose('WINDING_DOWN', true, {
    outcome: 'INTERRUPTED', checkpoint: null, noCheckpointReason: null, classification: null,
  });
  assert.equal(silent, 'ATTEMPT_CHECKPOINT_REQUIRED');

  const honest = planAttemptClose('WINDING_DOWN', true, {
    outcome: 'INTERRUPTED',
    checkpoint: null,
    noCheckpointReason: 'the runner went offline mid-turn; nothing was committed',
    classification: null,
  });
  assert.notEqual(typeof honest, 'string');
  // The reason is NOT a checkpoint: nothing is written back as known-good.
  assert.equal(typeof honest === 'string' ? 'x' : honest.knownGoodSha, null);

  const red = planAttemptClose('WINDING_DOWN', true, {
    outcome: 'FAILED',
    checkpoint: { sha: 'def', kind: 'WIP_RED', evidenceDigest: null },
    noCheckpointReason: null,
    classification: 'IN_SCOPE_DEFECT',
  });
  assert.notEqual(typeof red, 'string');
  assert.equal(typeof red === 'string' ? 'x' : red.knownGoodSha, null, 'WIP_RED is not known good');
});

test('§2: an attempt that was never asked to stop may close with neither', () => {
  const plain = planAttemptClose('OPEN', false, {
    outcome: 'FAILED', checkpoint: null, noCheckpointReason: null, classification: 'IN_SCOPE_DEFECT',
  });
  assert.notEqual(typeof plain, 'string');
});

test('§2 NC4: a closed attempt cannot be closed again', () => {
  assert.equal(
    planAttemptClose('CLOSED', true, {
      outcome: 'FAILED', checkpoint: null, noCheckpointReason: 'x', classification: null,
    }),
    'ATTEMPT_OUTCOME_IMMUTABLE',
  );
});

// -------------------------------------------------------------------------------------------
// §3: who may do what.
// -------------------------------------------------------------------------------------------

test('§3 AU2: another agent session cannot end a live attempt; the user and the worker can', () => {
  const attempt = { sessionId: 'worker', status: 'OPEN' as const };
  assert.equal(authorizeAttemptLifecycle({ kind: 'USER' }, attempt), 'ALLOWED');
  assert.equal(
    authorizeAttemptLifecycle({ kind: 'AGENT_SESSION', sessionId: 'worker' }, attempt),
    'ALLOWED',
  );
  assert.equal(
    authorizeAttemptLifecycle({ kind: 'AGENT_SESSION', sessionId: 'coordinator' }, attempt),
    'ATTEMPT_OUTCOME_IS_THE_WORKERS',
  );
  // A winding-down attempt is the one it matters most for: that is where the outcome is being
  // written, and completing it there is exactly the overwrite TH2 forbids.
  assert.equal(
    authorizeAttemptLifecycle(
      { kind: 'AGENT_SESSION', sessionId: 'coordinator' },
      { sessionId: 'worker', status: 'WINDING_DOWN' },
    ),
    'ATTEMPT_OUTCOME_IS_THE_WORKERS',
  );
  // Once it is closed there is no result left to overwrite.
  assert.equal(
    authorizeAttemptLifecycle(
      { kind: 'AGENT_SESSION', sessionId: 'coordinator' },
      { sessionId: 'worker', status: 'CLOSED' },
    ),
    'ALLOWED',
  );
});

test('§3 AU3: steering is bounded, and refused outright once the attempt is winding down', () => {
  const attempt = { sessionId: 'worker', status: 'OPEN' as const };
  const coordinator = { kind: 'AGENT_SESSION' as const, sessionId: 'coordinator' };
  for (let steers = 0; steers < 3; steers++) {
    assert.equal(authorizeSteer(coordinator, attempt, BUDGET, { coordinatorSteers: steers }),
      'ALLOWED', `steer ${steers + 1} of 3`);
  }
  assert.equal(
    authorizeSteer(coordinator, attempt, BUDGET, { coordinatorSteers: 3 }),
    'ATTEMPT_STEER_BUDGET_EXHAUSTED',
  );
  assert.equal(
    authorizeSteer(coordinator, { sessionId: 'worker', status: 'WINDING_DOWN' }, BUDGET,
      { coordinatorSteers: 0 }),
    'ATTEMPT_WINDING_DOWN',
  );
  // The person and the worker itself are never refused (AU1).
  assert.equal(
    authorizeSteer({ kind: 'USER' }, { sessionId: 'worker', status: 'WINDING_DOWN' }, BUDGET,
      { coordinatorSteers: 99 }),
    'ALLOWED',
  );
  assert.equal(
    authorizeSteer({ kind: 'AGENT_SESSION', sessionId: 'worker' }, attempt, BUDGET,
      { coordinatorSteers: 99 }),
    'ALLOWED',
  );
});

test('§3: the incident\'s shape — an unbounded steer loop terminates in a finite number of rounds', () => {
  const coordinator = { kind: 'AGENT_SESSION' as const, sessionId: 'coordinator' };
  const attempt = { sessionId: 'worker', status: 'OPEN' as const };
  let steers = 0;
  let rounds = 0;
  // The loop the incident actually ran: judge, steer "keep going", judge again. Three hundred
  // rounds of it were green on every liveness check because activity kept being produced.
  while (rounds < 300) {
    rounds++;
    if (authorizeSteer(coordinator, attempt, BUDGET, { coordinatorSteers: steers }) !== 'ALLOWED') {
      break;
    }
    steers++;
  }
  assert.equal(rounds, 4, 'the steer loop did not stop within the budget');
  assert.equal(steers, DEFAULT_ATTEMPT_BUDGET.maxCoordinatorSteers);
});

test('§3 AU4: the resolver\'s floor of 1 is documented rather than silently absorbed', () => {
  assert.equal(
    resolveAttemptBudget({ maxCoordinatorSteers: 0 }, null).maxCoordinatorSteers,
    DEFAULT_ATTEMPT_BUDGET.maxCoordinatorSteers,
  );
  assert.match(rule('3', 'AU4'), /下界是 1/);
  assert.equal(resolveAttemptBudget({ maxCoordinatorSteers: 1 }, null).maxCoordinatorSteers, 1);
});

// -------------------------------------------------------------------------------------------
// §4: opening the next one.
// -------------------------------------------------------------------------------------------

function previous(over: Partial<PreviousAttempt> = {}): PreviousAttempt {
  return {
    attemptGeneration: 1,
    hypothesisDigest: hypothesisDigest('rewrite the reducer'),
    status: 'CLOSED',
    outcome: 'FAILED',
    exhaustedDimension: null,
    classification: 'IN_SCOPE_DEFECT',
    ...over,
  };
}

test('§4 AT3: the same hypothesis is not attempted twice on one revision', () => {
  assert.equal(
    authorizeFreshAttempt('rewrite the reducer', previous()),
    'ATTEMPT_HYPOTHESIS_UNCHANGED',
  );
  // Reformatting one is not proposing a new one.
  assert.equal(
    authorizeFreshAttempt('  Rewrite   the REDUCER  ', previous()),
    'ATTEMPT_HYPOTHESIS_UNCHANGED',
  );
  assert.equal(authorizeFreshAttempt('bisect the regression instead', previous()), 'ALLOWED');
});

test('§4 GN2: a TRANSIENT close may retry the same hypothesis, and that exemption is bounded', () => {
  assert.equal(
    authorizeFreshAttempt('rewrite the reducer', previous({ classification: 'TRANSIENT' })),
    'ALLOWED',
  );
  // §3 CL2 is what bounds it: a chronically transient failure is re-classified after
  // `maxTransientRetries`, and the re-classified attempt then hits the rule above.
  assert.equal(
    authorizeFreshAttempt('rewrite the reducer', previous({ classification: 'IN_SCOPE_DEFECT' })),
    'ATTEMPT_HYPOTHESIS_UNCHANGED',
  );
});

test('§4: an attempt still running blocks the next one, and a hypothesis is required', () => {
  assert.equal(
    authorizeFreshAttempt('something else', previous({ status: 'OPEN', outcome: null })),
    'ATTEMPT_ALREADY_OPEN',
  );
  assert.equal(
    authorizeFreshAttempt('something else', previous({ status: 'WINDING_DOWN', outcome: null })),
    'ATTEMPT_ALREADY_OPEN',
  );
  assert.equal(authorizeFreshAttempt('   ', null), 'ATTEMPT_HYPOTHESIS_MISSING');
  assert.equal(authorizeFreshAttempt('first try', null), 'ALLOWED');
});

test('§4 GN1: the observation key is the caller\'s dispatch identity, verbatim', () => {
  assert.equal(attemptObservationKey('pc:v1:task:dispatch:7'), 'attempt:pc:v1:task:dispatch:7');
  // Stable across processes: the same dispatch computes the same key, which is what makes a
  // replay after a crash read its own row instead of opening a second generation.
  assert.equal(attemptObservationKey('k'), attemptObservationKey('k'));
});

// -------------------------------------------------------------------------------------------
// §5: what a fresh generation inherits.
// -------------------------------------------------------------------------------------------

const TASK = {
  taskId: 'task-1',
  scopeRevision: 2,
  scopeHash: 'a'.repeat(64),
  knownGoodSha: 'deadbeef',
};

test('§5: the seed carries the document\'s fields and NOTHING else (SD2)', () => {
  const stated = column(tableWith(DOC, '5', '字段'), '字段').map(bare);
  const seed = buildAttemptSeed(TASK, 3, 'bisect instead', previous({
    outcome: 'FAILED', exhaustedDimension: 'TURNS',
  }));
  // The document lists `scopeRevision / scopeHash` on one row; the code has them as two fields.
  const documented = stated.flatMap((cell) => cell.split(' / '));
  assert.deepEqual([...documented].sort(), [...ATTEMPT_SEED_FIELDS].sort());
  assert.deepEqual(Object.keys(seed).sort(), [...ATTEMPT_SEED_FIELDS].sort());
});

test('§5 SD1: evidence is inherited, the previous session is not', () => {
  const seed = buildAttemptSeed(TASK, 3, 'bisect instead', previous({
    outcome: 'FAILED', exhaustedDimension: 'CONTEXT', attemptGeneration: 2,
  }));
  assert.equal(seed.inheritedKnownGoodSha, 'deadbeef');
  assert.equal(seed.scopeRevision, 2);
  assert.equal(seed.scopeHash, TASK.scopeHash);
  assert.equal(seed.attemptGeneration, 3);
  assert.deepEqual(seed.previousOutcome, {
    attemptGeneration: 2,
    outcome: 'FAILED',
    exhaustedDimension: 'CONTEXT',
    classification: 'IN_SCOPE_DEFECT',
  });
  // Nothing in the seed is unbounded: the previous outcome is four scalars, not a transcript.
  const serialized = JSON.stringify(seed);
  assert.ok(serialized.length < 4_096, 'the seed grew into something unbounded');
  assert.ok(!/transcript|messages|runtimeSessionId|previousSessionId/i.test(serialized));
});

test('§5: the first attempt on a revision inherits no previous outcome', () => {
  const seed = buildAttemptSeed({ ...TASK, knownGoodSha: null }, 1, 'first try', null);
  assert.equal(seed.previousOutcome, null);
  assert.equal(seed.inheritedKnownGoodSha, null);
  // An attempt that is still running has no outcome to hand on either.
  const midflight = buildAttemptSeed(TASK, 2, 'next', previous({ status: 'OPEN', outcome: null }));
  assert.equal(midflight.previousOutcome, null);
});

test('§5 SD3: the new attempt\'s budget starts full, which is why the ABSOLUTE counters do not', () => {
  // The per-attempt budget resets — that is what makes a generation a fresh try...
  const fresh = evaluateAttemptBudget(BUDGET, spend());
  assert.equal(fresh.exhausted, null);
  // ...and it is exactly why §8's `attemptsOnRevision` and `verificationRounds` never reset: if
  // both halves reset, a revision could be attempted forever, one fresh budget at a time.
  const contract = section(CONTRACT, '8');
  assert.match(contract, /永不清零/);
});

// -------------------------------------------------------------------------------------------
// §6: crashes.
// -------------------------------------------------------------------------------------------

test('§6 CR1/CR2: a crash closes as INTERRUPTED and says there is no checkpoint', () => {
  const planned = planAttemptClose('OPEN', true, {
    outcome: 'INTERRUPTED',
    checkpoint: null,
    noCheckpointReason: 'runner went offline; the attempt held no committed work',
    classification: null,
  });
  assert.notEqual(typeof planned, 'string');
  assert.equal(typeof planned === 'string' ? 'x' : planned.knownGoodSha, null);
  assert.equal(typeof planned === 'string' ? 'x' : planned.outcome, 'INTERRUPTED');
});
