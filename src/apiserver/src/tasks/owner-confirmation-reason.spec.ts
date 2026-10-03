import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_OWNER_CONFIRMATION_REASON_NOTE_CHARS,
  OWNER_CONFIRMATION_REASONS,
  normaliseOwnerConfirmationReasonNote,
  ownerConfirmationReasonRequiredBody,
  ownerConfirmationReasonShapeError,
  ownerConfirmationReasonsInWords,
} from './owner-confirmation-reason';

test('the four reasons are the owner’s whole list, in the order the rule names them', () => {
  assert.deepEqual(OWNER_CONFIRMATION_REASONS,
    ['DEPLOY', 'IRREVERSIBLE', 'OWNER_DEVICE_OR_ACCOUNT', 'OWNER_TRADE_OFF']);
  const words = ownerConfirmationReasonsInWords();
  for (const reason of OWNER_CONFIRMATION_REASONS) assert.match(words, new RegExp(`${reason} \\(`));
  assert.match(words, /live database/);
  assert.match(words, /DROP/);
  assert.match(words, /keys/);
  assert.match(words, /trade-off/);
});

test('the 409 points at EVIDENCE_JUDGMENT and carries what a caller needs to act on it', () => {
  const outside = ownerConfirmationReasonRequiredBody(null, false);
  assert.equal(outside.code, 'OWNER_CONFIRMATION_REASON_REQUIRED');
  assert.equal(outside.kind, 'REFUSAL');
  assert.equal(outside.requiredAction, 'DECLARE_EVIDENCE_JUDGMENT_THE_DISPATCHING_SESSION_SETTLES');
  assert.equal(outside.itemIndex, null);
  assert.equal(outside.suggestedCriterion, 'EVIDENCE_JUDGMENT');
  assert.equal(outside.reasonField, 'ownerConfirmationReason');
  assert.deepEqual(outside.reasons, [...OWNER_CONFIRMATION_REASONS]);
  assert.match(outside.message, /nothing was written\./);
  assert.doesNotMatch(outside.message, /batch/);
  assert.match(outside.message, /declare EVIDENCE_JUDGMENT, state in acceptanceCriteria/);
  assert.match(outside.message, /delivered to the session that dispatched the work — this one — to decide with task_evidence_decide/);
  assert.match(outside.message, /30 minutes/);

  const batchItem = ownerConfirmationReasonRequiredBody(2, true);
  assert.equal(batchItem.itemIndex, 2);
  assert.match(batchItem.message, /no item of this batch was/);
  assert.match(batchItem.message, /quoting the project criterion it serves/);
  assert.match(batchItem.message, /Automatic is off/);
  assert.doesNotMatch(batchItem.message, /30 minutes/);
});

test('a reason explains OWNER_CONFIRMED only, and its sentence the reason only', () => {
  assert.equal(ownerConfirmationReasonShapeError({ completionCriterion: 'OWNER_CONFIRMED', reason: 'DEPLOY', note: null }), null);
  assert.equal(ownerConfirmationReasonShapeError({ completionCriterion: 'OWNER_CONFIRMED', reason: 'DEPLOY', note: 'why' }), null);
  assert.equal(ownerConfirmationReasonShapeError({ completionCriterion: 'OWNER_CONFIRMED', reason: null, note: null }), null,
    'whether a reason is REQUIRED is the write door’s question, about who is writing');
  assert.equal(ownerConfirmationReasonShapeError({ completionCriterion: 'EVIDENCE_JUDGMENT', reason: null, note: null }), null);
  for (const completionCriterion of ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'] as const) {
    assert.match(
      ownerConfirmationReasonShapeError({ completionCriterion, reason: 'IRREVERSIBLE', note: null })!,
      new RegExp(`explains an OWNER_CONFIRMED declaration, and this task would be ${completionCriterion}`),
    );
  }
  assert.match(
    ownerConfirmationReasonShapeError({ completionCriterion: 'OWNER_CONFIRMED', reason: null, note: 'why' })!,
    /ownerConfirmationReasonNote is the sentence that goes with ownerConfirmationReason/,
  );
  assert.match(
    ownerConfirmationReasonShapeError({
      completionCriterion: 'OWNER_CONFIRMED', reason: 'DEPLOY', note: 'x'.repeat(MAX_OWNER_CONFIRMATION_REASON_NOTE_CHARS + 1),
    })!,
    /at most 500 characters/,
  );
});

test('the sentence is trimmed once, and blank is no sentence', () => {
  assert.equal(normaliseOwnerConfirmationReasonNote('  ships 1.4  '), 'ships 1.4');
  assert.equal(normaliseOwnerConfirmationReasonNote('   '), null);
  assert.equal(normaliseOwnerConfirmationReasonNote(null), null);
  assert.equal(normaliseOwnerConfirmationReasonNote(undefined), null);
});
