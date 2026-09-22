/**
 * The landing fold, without a database.
 *
 * Its module's pg spec answers whether the lane reaches the endpoint and reads the receipts the
 * product actually writes; that one costs a PostgreSQL instance per case, so it builds each
 * criterion with a single serving task. The shapes below are the ones that are cheap here and
 * awkward there — most of all the CONJUNCTION, which a criterion with one serving task can never
 * tell apart from a disjunction, and the project whose work is on its own branch and not yet on
 * main, which needs two branches and four criteria to tell three answers apart.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_LANDING_BRANCHES,
  branchName,
  criterionLanding,
  landingBranchesFor,
  receiptIsLandingEvidence,
  taskLanding,
  type CriterionWithLandingFacts,
  type LandingBranches,
} from './project-criterion-landing';

const MERGED_INTO_MAIN = { result: 'MERGED', targetBranch: 'main' };

/** A project that lands its finished work on its own branch first, and reaches main later. */
const PROJECT_BRANCH: LandingBranches = landingBranchesFor({
  upstreamRef: 'refs/heads/main',
  integrationRef: 'refs/heads/project/2PgH',
});
const MERGED_INTO_PROJECT_BRANCH = { result: 'MERGED', targetBranch: 'project/2PgH' };

/** And one that integrates straight into its upstream. */
const MAIN_LINE: LandingBranches = landingBranchesFor({
  upstreamRef: 'refs/heads/main',
  integrationRef: 'refs/heads/main',
});

/** The line's own branch, as a receipt names it. */
const ALREADY_MERGED_INTO_PROJECT_BRANCH = { result: 'ALREADY_MERGED', targetBranch: 'project/2PgH' };

/**
 * One serving task as the fold reads it: its receipts, and whether it declares it needs no code
 * (SR5's escape hatch) — the one fact that says a task has nothing to land.
 *
 * Every case below means real work unless it says otherwise, so a task that carries commits is the
 * default and the declaration is spelled out. A task that ran a branch HAS commits of its own
 * whatever its title says, so nothing here is inferred from what a task looks like.
 */
const serving = (
  receipts: Array<{ result: string; targetBranch: string }>,
  facts: { codeless?: boolean } = {},
) => ({
  codeless: facts.codeless ?? false,
  mergeReceipts: receipts,
});

/** One criterion, stated as the rows the fold reads. */
const criterion = (
  id: string,
  ...servingTasks: Array<Array<{ result: string; targetBranch: string }>>
): CriterionWithLandingFacts => ({ id, servingTasks: servingTasks.map((r) => serving(r)) });

test('a criterion is LANDED only when EVERY task serving it has landing evidence', () => {
  assert.deepEqual(
    criterionLanding([
      criterion('all', [MERGED_INTO_MAIN], [MERGED_INTO_MAIN]),
      criterion('one-of-two', [MERGED_INTO_MAIN], []),
      criterion('neither', [], []),
    ], LEGACY_LANDING_BRANCHES),
    [
      { definitionId: 'all', landing: 'LANDED' },
      { definitionId: 'one-of-two', landing: 'UNKNOWN' },
      { definitionId: 'neither', landing: 'UNKNOWN' },
    ],
    'two tasks serve a criterion and one of them merged: the criterion’s work is not on the '
      + 'default branch, and a fold that asked whether ANY of them landed would say it was',
  );
});

test('a criterion nobody serves is UNKNOWN, not vacuously landed', () => {
  assert.deepEqual(criterionLanding([criterion('unserved')], LEGACY_LANDING_BRANCHES),
    [{ definitionId: 'unserved', landing: 'UNKNOWN' }],
    '"every one of zero serving tasks landed" is true and says nothing; there is no evidence '
      + 'here to stand on, which is exactly what UNKNOWN means');
});

test('one task’s several receipts are searched, not just its latest', () => {
  assert.deepEqual(
    criterionLanding([criterion('retried', [
      { result: 'CONFLICT', targetBranch: 'main' },
      { result: 'MERGED', targetBranch: 'main' },
      { result: 'ERROR', targetBranch: 'main' },
    ])], LEGACY_LANDING_BRANCHES),
    [{ definitionId: 'retried', landing: 'LANDED' }],
    'a receipt is a statement about a moment and they are never rewritten, so a merge that '
      + 'happened stays true however many attempts were recorded after it',
  );
});

test('only the two landed results, and only into this project’s branches, are evidence', () => {
  for (const branch of ['main', 'master']) {
    assert.equal(receiptIsLandingEvidence({ result: 'MERGED', targetBranch: branch }, LEGACY_LANDING_BRANCHES), true);
    assert.equal(receiptIsLandingEvidence({ result: 'ALREADY_MERGED', targetBranch: branch }, LEGACY_LANDING_BRANCHES), true,
      'the external fast-forward case is a landing, and it is how most of this work lands');
  }
  for (const result of ['CONFLICT', 'ERROR']) {
    assert.equal(receiptIsLandingEvidence({ result, targetBranch: 'main' }, LEGACY_LANDING_BRANCHES), false);
  }
  assert.equal(receiptIsLandingEvidence({ result: 'MERGED', targetBranch: 'orbit/some-lane' }, LEGACY_LANDING_BRANCHES), false,
    'a merge into another branch is evidence about THAT branch — and the answer it leaves here '
      + 'is UNKNOWN, never a denial, because this read cannot see what else has landed');
});

test('a project with a binding reads its own branches; one without reads main or master', () => {
  assert.deepEqual(landingBranchesFor(null), LEGACY_LANDING_BRANCHES,
    'a project that never said where its code lives is read the way it always was');
  assert.deepEqual(PROJECT_BRANCH, { upstream: ['main'], integration: ['project/2PgH'] });
  assert.deepEqual(MAIN_LINE, { upstream: ['main'], integration: ['main'] },
    'a project that integrates straight into main names one branch in both places');

  assert.equal(branchName('refs/heads/project/2PgH'), 'project/2PgH',
    'a receipt names the branch, not the ref');
  assert.equal(branchName('refs/tags/v1'), 'refs/tags/v1',
    'not a branch anything merges into: it comes back whole, and no receipt matches it');

  assert.equal(receiptIsLandingEvidence({ result: 'MERGED', targetBranch: 'master' }, PROJECT_BRANCH), false,
    'master is where a project that never named an upstream might have landed — a project that '
      + 'named one gets no such fallback, and a merge into master is about somewhere else');
});

test('work on the project branch has landed, and is not on main', () => {
  assert.equal(taskLanding([MERGED_INTO_PROJECT_BRANCH], PROJECT_BRANCH), 'ON_INTEGRATION_LINE');
  assert.equal(taskLanding([MERGED_INTO_MAIN], PROJECT_BRANCH), 'ON_UPSTREAM');
  assert.equal(taskLanding([MERGED_INTO_PROJECT_BRANCH, MERGED_INTO_MAIN], PROJECT_BRANCH), 'ON_UPSTREAM',
    'the upstream outranks the integration line: work on main is already everywhere the project '
      + 'branch would ever carry it');
  assert.equal(taskLanding([{ result: 'CONFLICT', targetBranch: 'project/2PgH' }], PROJECT_BRANCH), 'NOT_KNOWN',
    'a conflict is not a landing, on either branch');
  assert.equal(taskLanding([], PROJECT_BRANCH), 'NOT_KNOWN');
});

test('a criterion is ON_INTEGRATION_LINE until all of its work is on the upstream', () => {
  assert.deepEqual(
    criterionLanding([
      criterion('on-the-branch', [MERGED_INTO_PROJECT_BRANCH], [MERGED_INTO_PROJECT_BRANCH]),
      criterion('half-way', [MERGED_INTO_MAIN], [MERGED_INTO_PROJECT_BRANCH]),
      criterion('all-the-way', [MERGED_INTO_MAIN], [MERGED_INTO_MAIN]),
      criterion('one-task-has-neither', [MERGED_INTO_PROJECT_BRANCH], []),
    ], PROJECT_BRANCH),
    [
      { definitionId: 'on-the-branch', landing: 'ON_INTEGRATION_LINE' },
      { definitionId: 'half-way', landing: 'ON_INTEGRATION_LINE' },
      { definitionId: 'all-the-way', landing: 'LANDED' },
      { definitionId: 'one-task-has-neither', landing: 'UNKNOWN' },
    ],
    'LANDED is the whole criterion on main. The half-landed one is the case the project DONE '
      + 'projection must not read as done, and the last one still has a task no receipt mentions',
  );
});

test('a project that integrates straight into main never reads ON_INTEGRATION_LINE', () => {
  assert.equal(taskLanding([MERGED_INTO_MAIN], MAIN_LINE), 'ON_UPSTREAM');
  assert.deepEqual(criterionLanding([criterion('straight', [MERGED_INTO_MAIN])], MAIN_LINE),
    [{ definitionId: 'straight', landing: 'LANDED' }],
    'its integration line IS its upstream, so "landed, but not on main" is not a state it has');
});

test('work that declares it needs no code does not withhold LANDED', () => {
  assert.deepEqual(criterionLanding([
    // Two pieces landed, and a third that is an acceptance task whose deliverable is evidence: it
    // resolves no SOURCE, so it has no branch, no commit of its own and no receipt. The criterion is
    // on main as far as anything can be landed.
    { id: 'with-an-evidence-task', servingTasks: [
      serving([MERGED_INTO_MAIN]), serving([MERGED_INTO_MAIN]), serving([], { codeless: true }),
    ] },
    // The same declaration on a task that DID run a branch, which is the shape the finished
    // acceptance task of 2026-09-22 actually has: a receipt names the project line, and the
    // declaration is what says none of that branch was its own work. §1.1 reads the declaration as
    // authoritative wherever it reads it, and this lane does the same.
    { id: 'codeless-beside-a-line-receipt', servingTasks: [
      serving([MERGED_INTO_MAIN]), serving([ALREADY_MERGED_INTO_PROJECT_BRANCH], { codeless: true }),
    ] },
    // Served only by such work: all of zero commits are on the upstream, which is §2.5 J9's answer
    // one level down — "nothing left to wait for". A criterion NOBODY serves stays UNKNOWN.
    { id: 'only-such-work', servingTasks: [serving([], { codeless: true })] },
  ], PROJECT_BRANCH), [
    { definitionId: 'with-an-evidence-task', landing: 'LANDED' },
    { definitionId: 'codeless-beside-a-line-receipt', landing: 'LANDED' },
    { definitionId: 'only-such-work', landing: 'LANDED' },
  ], 'before this rule the first criterion could not be LANDED at any time, by any receipt: it '
    + 'was waiting for a commit that was never going to exist, which left every project holding one '
    + 'unable to reach DONE');
});

test('work that ran a branch is not let out of the roll-up, whoever it is', () => {
  assert.deepEqual(criterionLanding([
    // The third task ran a branch, so it carries commits of its own — and its only receipt puts them
    // on the project branch. This is the shape a real finished acceptance task has, and the read
    // cannot tell it apart from a branch whose work is on the line, so it may not guess: only the
    // task's own declaration that it needs no code gets it out of the conjunction.
    { id: 'own-work-on-the-line', servingTasks: [
      serving([MERGED_INTO_MAIN]), serving([ALREADY_MERGED_INTO_PROJECT_BRANCH]),
    ] },
    // A branch that landed nothing anywhere is not landed either, and no exemption reaches it.
    { id: 'ran-a-branch-nowhere', servingTasks: [serving([]), serving([])] },
  ], PROJECT_BRANCH), [
    { definitionId: 'own-work-on-the-line', landing: 'ON_INTEGRATION_LINE' },
    { definitionId: 'ran-a-branch-nowhere', landing: 'UNKNOWN' },
  ], 'a task that ran a branch HAS commits of its own, whatever its title says and whatever a '
    + 'receipt says about where they are: reading LANDED for either of these is the false green '
    + 'this lane exists to break up');
});
