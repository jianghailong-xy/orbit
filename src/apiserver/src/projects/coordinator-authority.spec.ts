import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SessionDispatchOrigin } from '@prisma/client';

import {
  AUTHORITY_REFUSAL_CODES,
  AUTHORITY_REQUIRED_ACTIONS,
  AUTHORITY_TIERS,
  COORDINATOR_ACTIONS,
  COORDINATOR_AUTHORITY,
  JUDGMENT_DISPATCH_ORIGIN,
  TASK_BUDGET_WINDOW_MS,
  authorityPrincipal,
  refuseHumanOnlyAction,
  refuseTaskOpening,
} from './coordinator-authority';

/**
 * Unit T6, as rules — the layer below anything that enforces them.
 *
 * The claim being tested here is narrow and worth stating: authority is a function of (principal,
 * action) and of NOTHING ELSE. Not of the project's automation level, not of how far along the
 * project is, not of which door the request came through. The service-level file next door
 * (`coordinator-authority-boundary.spec.ts`) asserts the same rules actually refuse real writes;
 * this one asserts the rules say what the unit says they say.
 */

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

// ── The vocabulary, and the one place it touches the database's ────────────────────────────────

// The module deliberately holds the dispatch origin as a literal so it can stay free of the Prisma
// client. That is only safe while somebody checks the literal still names something real: renaming
// the enum member would otherwise leave a boundary keyed on a value no session can ever have, and
// a boundary that never matches is one that never refuses.
test('the judgment dispatch origin names a real SessionDispatchOrigin member', () => {
  assert.equal(JUDGMENT_DISPATCH_ORIGIN, SessionDispatchOrigin.PROJECT_COORDINATOR);
});

test('every action is graded, and at a tier from the closed set', () => {
  assert.deepEqual(
    Object.keys(COORDINATOR_AUTHORITY).sort(),
    [...COORDINATOR_ACTIONS].sort(),
    'an action with no tier is an action nobody decided about',
  );
  for (const action of COORDINATOR_ACTIONS) {
    assert.ok(AUTHORITY_TIERS.includes(COORDINATOR_AUTHORITY[action]));
  }
});

// The whole point of the unit: dispatching ready work and recording that a goal was met are not
// the same kind of act, so they must not end up in the same tier. If this ever collapses to one
// value the table has stopped dividing anything.
test('the table separates the cheap acts from the irreversible ones', () => {
  assert.equal(COORDINATOR_AUTHORITY.DISPATCH_READY_TASK, 'AUTOMATIC');
  assert.equal(COORDINATOR_AUTHORITY.RETRY_TRANSIENT_FAILURE, 'AUTOMATIC');
  assert.equal(COORDINATOR_AUTHORITY.OPEN_TASK, 'COORDINATOR_BOUNDED');
  assert.equal(COORDINATOR_AUTHORITY.EDIT_ACCEPTANCE_CRITERIA, 'HUMAN_ONLY');
  assert.equal(COORDINATOR_AUTHORITY.CONCLUDE_VERDICT_PASS, 'HUMAN_ONLY');
  assert.equal(COORDINATOR_AUTHORITY.SETTLE_PROJECT_DONE, 'HUMAN_ONLY');
});

// §0's replacement claim, as a property of the source rather than of one call: the rules cannot
// read the three-level switch, because the switch is not an input to any of them. A grep, for the
// same reason the project's own "no timer" criterion is a grep — the absence of a reader is the
// fact, and a call-level assertion could only ever sample it.
test('no rule in this contract reads the project automation policy', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../src/projects/coordinator-authority.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/automationPolicy|automation_policy/.test(code));
  assert.ok(!/MANUAL|GUARDED_AUTO|\bAUTO\b/.test(code));
});

// ── §1: who is restricted ──────────────────────────────────────────────────────────────────────

test('only a PROJECT_COORDINATOR session is the judgment principal', () => {
  assert.equal(authorityPrincipal(SessionDispatchOrigin.PROJECT_COORDINATOR), 'JUDGMENT');
  // These are negative role classifications, not assertions that a human is present.
  assert.equal(authorityPrincipal(SessionDispatchOrigin.USER), 'NON_JUDGMENT');
  assert.equal(authorityPrincipal(SessionDispatchOrigin.LEGACY_SWEEP), 'NON_JUDGMENT');
  // No acting session at all — the user door, headless CLI, or a trusted internal caller. Keeping
  // this path is the compatibility decision; calling it NON_JUDGMENT is the honesty decision.
  assert.equal(authorityPrincipal(undefined), 'NON_JUDGMENT');
  assert.equal(authorityPrincipal(null), 'NON_JUDGMENT');
});

// ── The three HUMAN_ONLY rows ──────────────────────────────────────────────────────────────────

const HUMAN_ONLY = [
  ['EDIT_ACCEPTANCE_CRITERIA', 'ACCEPTANCE_CRITERIA_HUMAN_ONLY'],
  ['CONCLUDE_VERDICT_PASS', 'VERDICT_PASS_HUMAN_ONLY'],
  ['SETTLE_PROJECT_DONE', 'PROJECT_DONE_HUMAN_ONLY'],
] as const;

for (const [action, code] of HUMAN_ONLY) {
  test(`${action} is refused for a judgment session, and the refusal names that boundary`, () => {
    const refusal = refuseHumanOnlyAction('JUDGMENT', action);
    assert.ok(refusal, 'a HUMAN_ONLY action must not be allowed to a judgment session');
    // Which boundary, not just that there was one: a caller told only "forbidden" has to guess
    // which of the three it met, and the three have different answers.
    assert.equal(refusal.code, code);
    assert.equal(refusal.action, action);
    assert.equal(refusal.tier, 'HUMAN_ONLY');
    assert.equal(refusal.requiredAction, 'ASK_A_PERSON');
    assert.ok(AUTHORITY_REFUSAL_CODES.includes(refusal.code));
    assert.ok(AUTHORITY_REQUIRED_ACTIONS.includes(refusal.requiredAction));
    assert.match(refusal.message, /owner/);
    assert.match(refusal.message, /does not prove|not proof|does not attest/);
  });

  test(`${action} is untouched for a NON_JUDGMENT principal`, () => {
    assert.equal(refuseHumanOnlyAction('NON_JUDGMENT', action), null);
  });
}

test('the three boundaries do not share a code', () => {
  const codes = HUMAN_ONLY.map(([action]) => refuseHumanOnlyAction('JUDGMENT', action)!.code);
  assert.equal(new Set(codes).size, codes.length);
});

// ── OPEN_TASK: bounded rather than refused ─────────────────────────────────────────────────────

const OPENING = {
  declaredCriterionKey: KEY_A,
  statedCriterionKeys: [KEY_A, KEY_B],
  openedInWindow: 0,
  opening: 1,
  budgetPerDay: 5,
};

test('a judgment session opening a task must name the criterion it serves', () => {
  const refusal = refuseTaskOpening('JUDGMENT', { ...OPENING, declaredCriterionKey: undefined });
  assert.equal(refusal?.code, 'TASK_CRITERION_UNDECLARED');
  assert.equal(refusal?.action, 'OPEN_TASK');
  assert.equal(refusal?.tier, 'COORDINATOR_BOUNDED');
  assert.equal(refusal?.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
  // Whitespace is not a declaration.
  assert.equal(
    refuseTaskOpening('JUDGMENT', { ...OPENING, declaredCriterionKey: '   ' })?.code,
    'TASK_CRITERION_UNDECLARED',
  );
});

// The bound is "this project asked for it", not "the caller filled the field in". A key the
// project does not state today buys nothing — which is also what happens after the owner rewrites
// a criterion, since editing the text changes its key.
test('a criterion key the project does not state is refused, separately from naming none', () => {
  const refusal = refuseTaskOpening('JUDGMENT', {
    ...OPENING,
    declaredCriterionKey: 'c'.repeat(32),
  });
  assert.equal(refusal?.code, 'TASK_CRITERION_UNKNOWN');
  assert.equal(refusal?.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
  assert.notEqual(refusal?.code, 'TASK_CRITERION_UNDECLARED');
});

test('a project that states no criteria has nothing for new coordinator work to serve', () => {
  const refusal = refuseTaskOpening('JUDGMENT', { ...OPENING, statedCriterionKeys: [] });
  assert.equal(refusal?.code, 'TASK_CRITERION_UNKNOWN');
});

test('a declared criterion inside the daily budget is allowed', () => {
  assert.equal(refuseTaskOpening('JUDGMENT', { ...OPENING, openedInWindow: 4, opening: 1 }), null);
});

test('the day’s allowance counts what this call would open, not just what is already spent', () => {
  // 4 spent + 1 more = 5, the whole allowance: allowed. One more than that is not.
  assert.equal(refuseTaskOpening('JUDGMENT', { ...OPENING, openedInWindow: 4, opening: 1 }), null);
  const refusal = refuseTaskOpening('JUDGMENT', { ...OPENING, openedInWindow: 4, opening: 2 });
  assert.equal(refusal?.code, 'TASK_BUDGET_SPENT');
  assert.equal(refusal?.requiredAction, 'WAIT_FOR_THE_BUDGET_WINDOW');
  // A plan is judged whole. Three items against an empty budget of two is refused entire rather
  // than trimmed to the two that fit — half a plan is a shape nobody chose.
  assert.equal(
    refuseTaskOpening('JUDGMENT', { ...OPENING, budgetPerDay: 2, openedInWindow: 0, opening: 3 })
      ?.code,
    'TASK_BUDGET_SPENT',
  );
});

// The column's own meaning, kept rather than reinterpreted: `session_budget_per_day` documents
// NULL as no limit, and inventing a default here would be a second spelling of the same setting.
test('a project with no stated budget is not budget-refused', () => {
  assert.equal(
    refuseTaskOpening('JUDGMENT', { ...OPENING, budgetPerDay: null, openedInWindow: 9_999 }),
    null,
  );
});

// The criterion is asked FIRST. A caller over budget AND naming nothing is told the thing it can
// act on now, rather than told to wait and then refused again for a reason it was never given.
test('naming no criterion is reported ahead of the budget', () => {
  const refusal = refuseTaskOpening('JUDGMENT', {
    ...OPENING,
    declaredCriterionKey: null,
    openedInWindow: 99,
  });
  assert.equal(refusal?.code, 'TASK_CRITERION_UNDECLARED');
});

test('a NON_JUDGMENT principal opens tasks with no criterion and no budget', () => {
  assert.equal(
    refuseTaskOpening('NON_JUDGMENT', {
      ...OPENING,
      declaredCriterionKey: undefined,
      openedInWindow: 9_999,
      budgetPerDay: 1,
    }),
    null,
  );
});

test('the budget window is a rolling 24 hours', () => {
  assert.equal(TASK_BUDGET_WINDOW_MS, 24 * 60 * 60 * 1000);
});
