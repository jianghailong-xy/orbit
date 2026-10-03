/**
 * A confirmation request's review, as pure rules (docs/owner-confirmation-review-contract.md): the
 * state table (§4 T1–T3), the line Orbit writes at the top (§6 H2), what the owner's door does with a
 * card's review and answers (§7 Q3–Q4), what a reviewer may hand in (§3.5 row 7, §8 B1), and the turn
 * keys no caller may take (§10 G6). What the same rules do against PostgreSQL is
 * `owner-confirmation-review.pg.spec.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, type HttpException } from '@nestjs/common';
import type { ConfirmationNeedsYouItem, OwnerConfirmationReviewView } from '@orbit/shared';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import {
  decisionReview,
  readConfirmationReturnInput,
  readConfirmationReviewInput,
  reviewHeadline,
  reviewStateOf,
  storableBranchSha,
  type ReviewStateFacts,
} from './owner-confirmation-review';
import {
  confirmationReturnTurnId,
  confirmationReviewRetryTurnId,
  isConfirmationReviewContentTurn,
  ownerConfirmationAnswersTurnId,
  ownerConfirmationReviewTurnId,
  returnRecordIdOfTurn,
  reviewIdOfTurn,
} from './owner-confirmation-review-turn';

const ID = '0199a0b1-0000-7000-8000-000000000001';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = new Date('2026-10-03T10:00:00Z');

function facts(over: Partial<ReviewStateFacts> = {}): ReviewStateFacts {
  return {
    delivery: 'DELIVERED',
    deliveryRefusal: null,
    reviewerSessionExists: true,
    reviewerEndedAt: null,
    abandonedAt: null,
    deliveredTurn: { status: 'PENDING', deliveredAt: null },
    dueAt: new Date(NOW.getTime() + 60_000),
    hasReturn: false,
    review: null,
    requestIsNewest: true,
    runBranchSha: null,
    ...over,
  };
}

test('T1: the states, top to bottom, first hit wins', () => {
  assert.equal(reviewStateOf(facts(), NOW).state, 'UNDER_REVIEW');
  assert.equal(reviewStateOf(facts({ delivery: 'PENDING', deliveredTurn: null }), NOW).state, 'UNDER_REVIEW',
    'not delivered yet is still under review');
  // A record beats every NOT_REVIEWED condition: a late review makes the request reviewed again.
  assert.equal(reviewStateOf(facts({ review: { reviewedSha: null }, reviewerEndedAt: NOW }), NOW).state, 'REVIEWED');
  assert.equal(reviewStateOf(facts({ hasReturn: true, review: { reviewedSha: null } }), NOW).state, 'RETURNED');
  assert.deepEqual(reviewStateOf(facts({ review: { reviewedSha: SHA_A }, requestIsNewest: false }), NOW).outdated,
    { cause: 'NEWER_REPORT', branchSha: null }, 'a newer report comes first');
  assert.deepEqual(reviewStateOf(facts({ review: { reviewedSha: SHA_A }, runBranchSha: SHA_B }), NOW).outdated,
    { cause: 'BRANCH_MOVED', branchSha: SHA_B });
  assert.equal(reviewStateOf(facts({ review: { reviewedSha: SHA_A }, runBranchSha: SHA_A }), NOW).state, 'REVIEWED');
  assert.equal(reviewStateOf(facts({ review: { reviewedSha: null }, runBranchSha: SHA_B }), NOW).state, 'REVIEWED',
    'no commit on either side says nothing about a move');
});

test('T2: why a request was not reviewed, in its order', () => {
  const reason = (over: Partial<ReviewStateFacts>) => reviewStateOf(facts(over), NOW).notReviewedReason;
  assert.equal(reason({ delivery: 'REFUSED', deliveryRefusal: 'NO_COORDINATOR', reviewerEndedAt: NOW }), 'NO_COORDINATOR');
  for (const code of ['REVIEWER_ENDED', 'AUTOMATIC_OFF', 'COORDINATOR_PAUSED']) {
    assert.equal(reason({ delivery: 'REFUSED', deliveryRefusal: code }), code);
  }
  for (const code of ['REVIEWER_IS_THE_RUN', 'SESSION_UNAVAILABLE', 'SUPERSEDED', 'SENT_BACK']) {
    assert.equal(reason({ delivery: 'REFUSED', deliveryRefusal: code }), 'UNREACHABLE');
  }
  assert.equal(reason({ reviewerEndedAt: NOW, abandonedAt: NOW }), 'REVIEWER_ENDED');
  assert.equal(reason({ reviewerSessionExists: false }), 'REVIEWER_ENDED', 'a reviewer row that is gone has ended');
  assert.equal(reason({ abandonedAt: NOW, dueAt: NOW }), 'REVIEWER_STOPPED');
  assert.equal(reason({ deliveredTurn: null }), 'REVIEWER_STOPPED', 'the delivered turn was deleted unread');
  assert.equal(reason({ deliveredTurn: { status: 'ANSWERED', deliveredAt: null } }), 'REVIEWER_STOPPED',
    'the delivered turn was drained unread');
  assert.equal(reason({ deliveredTurn: { status: 'ANSWERED', deliveredAt: NOW } }), null,
    'a turn the engine read and answered is not a stop');
  assert.equal(reason({ dueAt: NOW }), 'TIMED_OUT', 'now >= due_at');
  assert.equal(reason({ dueAt: new Date(NOW.getTime() + 1) }), null);
});

const needs = (n: number): ConfirmationNeedsYouItem[] => Array.from({ length: n }, (_, i) => ({
  key: `n${i + 1}`,
  text: `Question ${i + 1}?`,
  options: [{ label: 'Yes' }, { label: 'No' }],
  recommendedOption: 1,
}));

test('H2: the first line counts the lists and never quotes the judgment', () => {
  assert.equal(reviewHeadline(null, null), null);
  assert.deepEqual(reviewHeadline({ needsYou: needs(3), notChecked: [] }, null),
    { kind: 'NEEDS_YOU', text: 'Question 1?', more: 2 });
  assert.deepEqual(reviewHeadline({ needsYou: [], notChecked: [{ key: 'x1', text: 'perf' }] }, null),
    { kind: 'NOTHING_NEEDS_YOU', notChecked: 1 });
  assert.deepEqual(reviewHeadline({ needsYou: needs(1), notChecked: [] }, { problems: [1, 2] }),
    { kind: 'PROBLEMS_AFTER_CONFIRM', problems: 2 }, 'problems found after a confirm come first');
});

function view(state: OwnerConfirmationReviewView<Date>['state'], needsYou = 0): OwnerConfirmationReviewView<Date> {
  return {
    reviewId: ID,
    state,
    notReviewedReason: null,
    outdated: null,
    reviewer: { kind: 'TASK_CREATOR', sessionId: ID, title: 'reviewer' },
    since: NOW,
    dueAt: NOW,
    windowSeconds: 1800,
    headline: null,
    review: state === 'REVIEWED' || state === 'OUTDATED'
      ? {
        recordId: 'current-record',
        recordedAt: NOW,
        reviewedSha: null,
        judgment: 'ok',
        checked: [],
        notChecked: [],
        needsYou: needs(needsYou),
        leftOpen: [],
      }
      : null,
    returned: null,
    problems: null,
  };
}

/** The refusal's code — or, for a 400 about a malformed input, which carries none, its message. */
function code(call: () => unknown, kind: typeof ConflictException | typeof BadRequestException): string {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${error}`);
    const body = (error as HttpException).getResponse() as { code?: string; message?: string };
    return body.code ?? (kind === BadRequestException ? 'MALFORMED' : String(body.message));
  }
  assert.fail(`expected ${kind.name}`);
}

test('Q3: a client older than reviews is never refused, and its unseen questions get the recommended answers', () => {
  const recorded = decisionReview({ decision: 'CONFIRM', answering: ID, review: view('REVIEWED', 2), reviewRecordId: undefined, answers: undefined });
  assert.equal(recorded.reviewState, 'REVIEWED');
  assert.equal(recorded.reviewRecordId, 'current-record');
  assert.deepEqual(recorded.answers, [
    { key: 'n1', option: 1, text: null, source: 'NOT_SHOWN' },
    { key: 'n2', option: 1, text: null, source: 'NOT_SHOWN' },
  ]);
  for (const state of ['UNDER_REVIEW', 'NOT_REVIEWED', 'OUTDATED'] as const) {
    const old = decisionReview({ decision: 'CONFIRM', answering: ID, review: view(state), reviewRecordId: undefined, answers: undefined });
    assert.equal(old.reviewState, state);
    assert.equal(old.answers, null);
  }
  assert.equal(decisionReview({ decision: 'CONFIRM', answering: ID, review: undefined, reviewRecordId: undefined, answers: undefined }).reviewState, 'NONE');
});

test('Q3: the table, for a client that knows about reviews', () => {
  const decide = (review: OwnerConfirmationReviewView<Date> | undefined, reviewRecordId: string | null, answers: unknown = []) =>
    () => decisionReview({ decision: 'CONFIRM', answering: ID, review, reviewRecordId, answers });
  // No bar, under review, not reviewed: null and no answers is accepted; anything else is stale.
  for (const review of [undefined, view('UNDER_REVIEW'), view('NOT_REVIEWED')]) {
    assert.equal(decide(review, null)().answers, null);
    assert.equal(code(decide(review, 'current-record'), ConflictException), 'OWNER_CONFIRMATION_REVIEW_STALE');
    assert.equal(code(decide(review, null, [{ key: 'n1', option: 0 }]), ConflictException), 'OWNER_CONFIRMATION_REVIEW_STALE');
  }
  // Reviewed, nothing to answer.
  assert.equal(decide(view('REVIEWED'), null)().reviewRecordId, null);
  assert.equal(decide(view('REVIEWED'), 'current-record')().reviewRecordId, 'current-record');
  assert.equal(code(decide(view('REVIEWED'), 'an-older-record'), ConflictException), 'OWNER_CONFIRMATION_REVIEW_STALE');
  assert.equal(code(decide(view('REVIEWED'), 'current-record', [{ key: 'n1', option: 0 }]), ConflictException),
    'OWNER_CONFIRMATION_REVIEW_STALE');
  // Reviewed, with questions.
  const answered = decide(view('REVIEWED', 2), 'current-record', [{ key: 'n1', option: 0 }, { key: 'n2', text: ' my words ' }])();
  assert.deepEqual(answered.answers, [
    { key: 'n1', option: 0, text: null, source: 'OWNER' },
    { key: 'n2', option: null, text: 'my words', source: 'OWNER' },
  ]);
  assert.equal(code(decide(view('REVIEWED', 2), 'current-record', [{ key: 'n1', option: 0 }]), ConflictException),
    'OWNER_CONFIRMATION_ANSWERS_REQUIRED');
  assert.equal(code(decide(view('REVIEWED', 2), null), ConflictException), 'OWNER_CONFIRMATION_ANSWERS_REQUIRED');
  assert.equal(code(decide(view('REVIEWED', 2), 'an-older-record'), ConflictException), 'OWNER_CONFIRMATION_REVIEW_STALE');
  // Outdated: null or the old record, without answers.
  assert.equal(decide(view('OUTDATED', 2), 'current-record')().reviewRecordId, 'current-record');
  assert.equal(decide(view('OUTDATED', 2), null)().answers, null);
  assert.equal(code(decide(view('OUTDATED', 2), 'current-record', [{ key: 'n1', option: 0 }]), ConflictException),
    'OWNER_CONFIRMATION_REVIEW_STALE');
});

test('Q3: malformed answers are 400, a send-back carries none and is never refused for a review', () => {
  const malformed = (answers: unknown) => () => decisionReview({
    decision: 'CONFIRM', answering: ID, review: view('REVIEWED', 2), reviewRecordId: 'current-record', answers,
  });
  for (const answers of [
    'n1',
    [{ key: 'n1', option: 0, text: 'both' }, { key: 'n2', option: 0 }],
    [{ key: 'n1' }, { key: 'n2', option: 0 }],
    [{ key: 'n1', option: 2 }, { key: 'n2', option: 0 }],
    [{ key: 'n1', option: 0 }, { key: 'n1', option: 1 }],
    [{ key: 'n9', option: 0 }, { key: 'n2', option: 0 }],
    [{ key: 'n1', option: 0, extra: true }, { key: 'n2', option: 0 }],
    [{ key: 'n1', text: '   ' }, { key: 'n2', option: 0 }],
  ]) {
    assert.equal(code(malformed(answers), BadRequestException), 'MALFORMED', JSON.stringify(answers));
  }
  assert.equal(code(() => decisionReview({
    decision: 'SEND_BACK', answering: ID, review: view('REVIEWED', 2), reviewRecordId: null, answers: [{ key: 'n1', option: 0 }],
  }), BadRequestException), 'MALFORMED');
  const sentBack = decisionReview({ decision: 'SEND_BACK', answering: ID, review: view('REVIEWED', 2), reviewRecordId: null, answers: undefined });
  assert.deepEqual([sentBack.reviewState, sentBack.reviewRecordId, sentBack.answers], ['REVIEWED', 'current-record', null]);
  // A panel confirmation answers no request: no state, and nothing about a review may ride on it.
  assert.equal(decisionReview({ decision: 'CONFIRM', answering: null, review: undefined, reviewRecordId: null, answers: [] }).reviewState, null);
  assert.equal(code(() => decisionReview({ decision: 'CONFIRM', answering: null, review: undefined, reviewRecordId: 'x', answers: [] }),
    ConflictException), 'OWNER_CONFIRMATION_REVIEW_STALE');
});

test('§3.5 row 7: a review is read field by field, keyed, and an unknown key is a 400', () => {
  const read = readConfirmationReviewInput({
    requestId: ID.toUpperCase(),
    reviewedSha: SHA_A,
    judgment: '  Ready.  ',
    checked: [{ text: 'suite', evidenceRefs: ['ci/1'] }, { text: 'lint' }],
    notChecked: [{ text: 'perf', whyNotProven: 'no bench', coordinatorChecked: 'read the code', criterionKey: 'k1' }],
    needsYou: [{ text: 'Flag?', options: [{ label: 'On' }, { label: 'Off', description: 'later' }], recommendedOption: 1 }],
  }, SHA_A);
  assert.equal(read.requestId, ID);
  assert.equal(read.judgment, 'Ready.');
  assert.deepEqual(read.lists.checked.map((item) => item.key), ['c1', 'c2']);
  assert.deepEqual(read.lists.notChecked[0], {
    key: 'x1', text: 'perf', criterionKey: 'k1', whyNotProven: 'no bench', coordinatorChecked: 'read the code',
  });
  assert.equal(read.lists.needsYou[0].key, 'n1');
  assert.deepEqual(read.lists.leftOpen, []);
  const bad = (input: Record<string, unknown>, sha: string | null = SHA_A) => () => readConfirmationReviewInput({
    requestId: ID, reviewedSha: SHA_A, judgment: 'ok', ...input,
  }, sha);
  for (const [why, input, sha] of [
    ['unknown top-level key', { verdict: 'yes' }, SHA_A],
    ['unknown item key', { checked: [{ text: 'a', key: 'c9' }] }, SHA_A],
    ['whyNotProven outside notChecked', { checked: [{ text: 'a', whyNotProven: 'b' }] }, SHA_A],
    ['options outside needsYou', { leftOpen: [{ text: 'a', options: [] }] }, SHA_A],
    ['one option', { needsYou: [{ text: 'q', options: [{ label: 'a' }], recommendedOption: 0 }] }, SHA_A],
    ['recommendedOption out of range', { needsYou: [{ text: 'q', options: [{ label: 'a' }, { label: 'b' }], recommendedOption: 2 }] }, SHA_A],
    ['text too long', { checked: [{ text: 'x'.repeat(301) }] }, SHA_A],
    ['too many lines', { needsYou: needs(11).map(({ key: _key, ...item }) => item) }, SHA_A],
    ['too many refs', { checked: [{ text: 'a', evidenceRefs: Array(11).fill('r') }] }, SHA_A],
    ['empty judgment', { judgment: '  ' }, SHA_A],
    ['sha missing', { reviewedSha: undefined }, SHA_A],
    ['sha not hex', { reviewedSha: 'A'.repeat(40) }, SHA_A],
    ['sha given with none to review', {}, null],
  ] as const) {
    assert.equal(code(bad(input as Record<string, unknown>, sha as string | null), BadRequestException), 'MALFORMED', why);
  }
});

test('§8 B1: a return needs a reason and 1–10 problems', () => {
  const read = readConfirmationReturnInput({ requestId: ID, reason: 'fix', problems: [{ text: 'broken', evidenceRefs: ['x'] }] }, null);
  assert.deepEqual(read.problems, [{ key: 'p1', text: 'broken', evidenceRefs: ['x'] }]);
  for (const input of [
    { requestId: ID, reason: 'fix', problems: [] },
    { requestId: ID, reason: '', problems: [{ text: 'a' }] },
    { requestId: ID, reason: 'fix', problems: Array(11).fill({ text: 'a' }) },
    { requestId: ID, reason: 'fix', problems: [{ text: 'a', whyNotProven: 'b' }] },
    { requestId: 'not-a-uuid', reason: 'fix', problems: [{ text: 'a' }] },
  ]) {
    assert.equal(code(() => readConfirmationReturnInput(input, null), BadRequestException), 'MALFORMED');
  }
});

test('G6: the three review turn keys are the platform\'s alone, and a re-send stays on its row', () => {
  for (const key of [ownerConfirmationReviewTurnId(ID), confirmationReturnTurnId(ID), ownerConfirmationAnswersTurnId(ID)]) {
    assert.throws(() => assertClientTurnIdNotReserved(key), BadRequestException, key);
    assert.equal(isOrbitAuthoredTurn(key), true, key);
  }
  assert.equal(reviewIdOfTurn(ownerConfirmationReviewTurnId(ID)), ID);
  assert.equal(returnRecordIdOfTurn(confirmationReturnTurnId(ID)), ID);
  const resent = confirmationReviewRetryTurnId(ownerConfirmationReviewTurnId(ID), 'n0nce');
  assert.equal(resent, `${ownerConfirmationReviewTurnId(ID)}:retry:n0nce`);
  assert.equal(reviewIdOfTurn(resent), ID, 'the re-send carries the same review');
  assert.equal(returnRecordIdOfTurn(confirmationReviewRetryTurnId(confirmationReturnTurnId(ID), 'x')), ID);
  assert.equal(confirmationReviewRetryTurnId('auto-retry:x', 'y'), null);
  assert.equal(isConfirmationReviewContentTurn(ownerConfirmationAnswersTurnId(ID)), false,
    'the answers turn carries its own words');
  assert.equal(reviewIdOfTurn(`${ownerConfirmationReviewTurnId('not-a-uuid')}`), null);
});

test('a branch tip is stored only in the one spelling the column holds', () => {
  assert.equal(storableBranchSha(SHA_A), SHA_A);
  for (const value of [undefined, null, '', 'abc', SHA_A.toUpperCase(), `${SHA_A}0`, 'c'.repeat(64)]) {
    assert.equal(storableBranchSha(value), undefined, String(value));
  }
});
