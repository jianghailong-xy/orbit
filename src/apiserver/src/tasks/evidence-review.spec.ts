import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
import {
  EVIDENCE_REVIEW_WINDOW_SECONDS,
  evidenceIdOfReviewTurn,
  evidenceReviewRetryTurnId,
  evidenceReviewTurnId,
  isEvidenceReviewTurn,
  ownerEvidenceCard,
} from './evidence-review';
import { OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS } from './owner-confirmation-review';
import {
  confirmationReviewRetryTurnId,
  isConfirmationReviewContentTurn,
} from './owner-confirmation-review-turn';

const EVIDENCE = '0199a3f2-7c1e-7d2a-9f00-1234567890ab';

test('a revision is delivered under a key derived from it, and a re-send carries the same revision', () => {
  const key = evidenceReviewTurnId(EVIDENCE);
  assert.equal(key, `evidence-review:v1:${EVIDENCE}`);
  assert.equal(evidenceIdOfReviewTurn(key), EVIDENCE);
  assert.equal(isEvidenceReviewTurn(key), true);
  const retry = evidenceReviewRetryTurnId(key, 'nonce');
  assert.equal(retry, `${key}:retry:nonce`);
  assert.equal(evidenceIdOfReviewTurn(retry), EVIDENCE, 'a re-send is still that revision’s');
  for (const other of [null, undefined, '', 'evidence-review:v1:', 'evidence-review:v1:not-a-uuid',
    `owner-confirmation-review:v1:${EVIDENCE}`, 'hello']) {
    assert.equal(isEvidenceReviewTurn(other), false, String(other));
    assert.equal(evidenceReviewRetryTurnId(other, 'n'), null, String(other));
  }
});

test('every door that asks about a platform content turn answers for an evidence review too', () => {
  const key = evidenceReviewTurnId(EVIDENCE);
  assert.equal(isConfirmationReviewContentTurn(key), true, 'queued, listed and handed out as nobody’s words');
  assert.equal(confirmationReviewRetryTurnId(key, 'n'), `${key}:retry:n`, 're-sent as itself');
  assert.equal(isOrbitAuthoredTurn(key), true, 'nothing goes back to a composer');
  assert.throws(() => assertClientTurnIdNotReserved(key), BadRequestException, 'and no caller takes the key');
  assert.doesNotThrow(() => assertClientTurnIdNotReserved('my-own-key'));
});

test('the window is the 30 minutes a confirmation review gets outside a project', () => {
  assert.equal(EVIDENCE_REVIEW_WINDOW_SECONDS, 1_800);
  assert.equal(EVIDENCE_REVIEW_WINDOW_SECONDS, OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS);
});

test('the owner’s card is drawn where the work was dispatched, or in its run once that is in Trash', () => {
  const live = { id: 'dispatcher', deletedAt: null };
  const trashed = { id: 'dispatcher', deletedAt: new Date() };
  const run = { id: 'run', deletedAt: null };
  assert.deepEqual(ownerEvidenceCard(live, run), { sessionId: 'dispatcher', decidingSessionId: 'dispatcher' });
  assert.deepEqual(ownerEvidenceCard(live, null), { sessionId: 'dispatcher', decidingSessionId: 'dispatcher' });
  assert.deepEqual(ownerEvidenceCard(trashed, run), { sessionId: 'run', decidingSessionId: 'dispatcher' },
    'decided in the dispatching session’s name: the run did the work');
  assert.equal(ownerEvidenceCard(trashed, { id: 'run', deletedAt: new Date() }), null);
  assert.equal(ownerEvidenceCard(trashed, null), null);
  assert.equal(ownerEvidenceCard(null, run), null, 'a task nobody dispatched has no card here');
});
