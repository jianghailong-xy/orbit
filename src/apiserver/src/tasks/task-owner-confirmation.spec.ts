/**
 * The fourth completion criterion's door, as pure rules: who may record an owner decision, what a
 * send-back has to carry, and which question a decision is allowed to be an answer to.
 *
 * Everything here is asked of plain values, so every rule is a row of a table. What the same rules
 * do against PostgreSQL — the row, the DONE the fence admits, the message a send-back files — is
 * `task-owner-confirmation.pg.spec.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { taskCompletionRequiredAction } from './task-completion-criterion';
import {
  MAX_OWNER_DECISION_NOTE_CHARS,
  NOT_DECLARED_CODE,
  NOTHING_TO_SEND_BACK_CODE,
  REQUIRES_ACCOUNT_OWNER_CODE,
  SEND_BACK_REASON_CODE,
  STALE_CODE,
  TASK_SETTLED_CODE,
  assertOwnerConfirmationPrincipal,
  ownerConfirmationPrincipalRefusal,
  ownerDecisionNote,
  ownerDecisionRefusal,
  ownerSendBackClientTurnId,
  throwOwnerConfirmationRefusal,
  waitingOwnerConfirmation,
  type OwnerConfirmationStanding,
  type OwnerDecisionValue,
} from './task-owner-confirmation';

const OWNER = '01920000-0000-7000-8000-000000000001';
const SOMEBODY_ELSE = '01920000-0000-7000-8000-000000000002';
const TASK_RUN_SESSION = '01920000-0000-7000-8000-0000000000a1';
const COORDINATOR_SESSION = '01920000-0000-7000-8000-0000000000c1';
const REPORT = '01920000-0000-7000-8000-0000000000f1';
const LATER_REPORT = '01920000-0000-7000-8000-0000000000f2';

function standing(over: Partial<OwnerConfirmationStanding> = {}): OwnerConfirmationStanding {
  return {
    completionCriterion: 'OWNER_CONFIRMED',
    status: 'OPEN',
    verifiesTaskId: null,
    latestRequest: null,
    ...over,
  };
}

const waitingOn = (id: string, decided = false) => ({
  latestRequest: { id, sessionId: TASK_RUN_SESSION, decided },
});

test('only the account owner, from the app with no session header, may record an owner decision', () => {
  // The one caller the door takes: the owner's credential and nothing that makes it a session.
  assert.equal(ownerConfirmationPrincipalRefusal(OWNER, { door: 'USER', userId: OWNER }), null);
  assert.equal(
    ownerConfirmationPrincipalRefusal(OWNER, { door: 'USER', userId: OWNER, actingSessionId: null }),
    null,
  );
  assert.equal(
    ownerConfirmationPrincipalRefusal(OWNER, { door: 'USER', userId: OWNER, actingSessionId: '  ' }),
    null,
    'a blank header names no session',
  );

  const refused: Array<[string, Parameters<typeof ownerConfirmationPrincipalRefusal>[1], RegExp]> = [
    ['the task\'s own run, over the runner protocol',
      { door: 'RUNNER', userId: OWNER, actingSessionId: TASK_RUN_SESSION },
      new RegExp(`agent session ${TASK_RUN_SESSION} over the runner protocol`, 'u')],
    ['a project coordinator, over the runner protocol',
      { door: 'RUNNER', userId: OWNER, actingSessionId: COORDINATOR_SESSION },
      new RegExp(COORDINATOR_SESSION, 'u')],
    ['the runner protocol with no session at all',
      { door: 'RUNNER', userId: OWNER },
      /runner protocol, which is how agents reach Orbit/u],
    ['the owner\'s own credential carrying a session header',
      { door: 'USER', userId: OWNER, actingSessionId: COORDINATOR_SESSION },
      /session header of .*so an agent session is making it/u],
    ['a credential of another account',
      { door: 'USER', userId: SOMEBODY_ELSE },
      /does not belong to the account that owns the task/u],
  ];
  for (const [label, principal, why] of refused) {
    const refusal = ownerConfirmationPrincipalRefusal(OWNER, principal);
    assert.ok(refusal, `${label} must be refused`);
    assert.equal(refusal.code, REQUIRES_ACCOUNT_OWNER_CODE, label);
    assert.equal(refusal.kind, 'REFUSAL', label);
    // The same remedy a direct DONE gets, so an agent is told one thing wherever it tries.
    assert.equal(
      refusal.requiredAction,
      taskCompletionRequiredAction('OWNER_CONFIRMED').requiredAction,
      label,
    );
    assert.equal(refusal.requiredAction, 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP', label);
    assert.match(refusal.message, why, label);
    assert.match(refusal.message, /nothing was written/u, label);
    assert.match(refusal.message, /coordinator/u, `${label}: the coordinator is named, not implied`);
  }

  assert.throws(
    () => assertOwnerConfirmationPrincipal(OWNER, { door: 'RUNNER', userId: OWNER, actingSessionId: TASK_RUN_SESSION }),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenException, `expected a 403, got ${error}`);
      assert.equal((error.getResponse() as { code?: string }).code, REQUIRES_ACCOUNT_OWNER_CODE);
      return true;
    },
  );
  assert.doesNotThrow(() => assertOwnerConfirmationPrincipal(OWNER, { door: 'USER', userId: OWNER }));
});

test('a send-back needs a reason, and a confirmation may carry one', () => {
  for (const blank of [undefined, null, '', '   ', '\r\n\t']) {
    assert.throws(() => ownerDecisionNote('SEND_BACK', blank), (error: unknown) => {
      assert.ok(error instanceof BadRequestException, `expected a 400 for ${JSON.stringify(blank)}`);
      const body = error.getResponse() as { code?: string; requiredAction?: string; message?: string };
      assert.equal(body.code, SEND_BACK_REASON_CODE);
      assert.equal(body.requiredAction, 'SAY_WHAT_IS_MISSING');
      assert.match(body.message ?? '', /next message and the task stays open/u);
      return true;
    });
    assert.equal(ownerDecisionNote('CONFIRM', blank), null);
  }
  assert.equal(
    ownerDecisionNote('SEND_BACK', '  The 09-17 invoice still has no amount.\r\n'),
    'The 09-17 invoice still has no amount.',
  );
  assert.equal(ownerDecisionNote('SEND_BACK', 'line one\r\nline two'), 'line one\nline two');
  assert.equal(ownerDecisionNote('CONFIRM', ' checked by hand '), 'checked by hand');

  const tooLong = 'x'.repeat(MAX_OWNER_DECISION_NOTE_CHARS + 1);
  for (const decision of ['CONFIRM', 'SEND_BACK'] as const) {
    assert.throws(() => ownerDecisionNote(decision, tooLong), BadRequestException);
    assert.equal(ownerDecisionNote(decision, 'x'.repeat(MAX_OWNER_DECISION_NOTE_CHARS))?.length,
      MAX_OWNER_DECISION_NOTE_CHARS);
  }
});

test('what waits on the owner is the newest request that no decision answers yet', () => {
  assert.equal(waitingOwnerConfirmation({ latestRequest: null }), null, 'a run that never reported');
  assert.equal(waitingOwnerConfirmation(waitingOn(REPORT, true)), null, 'a report already decided');
  assert.deepEqual(waitingOwnerConfirmation(waitingOn(REPORT)), {
    requestId: REPORT,
    sessionId: TASK_RUN_SESSION,
  });
});

test('a task that does not declare OWNER_CONFIRMED is refused with its own criterion\'s remedy', () => {
  for (const decision of ['CONFIRM', 'SEND_BACK'] as const) {
    const executable = ownerDecisionRefusal(
      standing({ completionCriterion: 'EXECUTABLE', ...waitingOn(REPORT) }),
      decision,
      REPORT,
    );
    assert.equal(executable?.code, NOT_DECLARED_CODE);
    assert.equal(executable?.requiredAction, 'RUN_ACCEPTANCE_COMMAND');
    assert.match(executable?.message ?? '', /declares EXECUTABLE/u);

    const evidence = ownerDecisionRefusal(standing({ completionCriterion: 'EVIDENCE_JUDGMENT' }), decision, null);
    assert.equal(evidence?.code, NOT_DECLARED_CODE);
    assert.equal(evidence?.requiredAction, 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION');

    const verifier = ownerDecisionRefusal(
      standing({ completionCriterion: 'VERIFICATION', verifiesTaskId: 'subject' }),
      decision,
      null,
    );
    assert.equal(verifier?.requiredAction, 'RECORD_VERIFICATION_VERDICT');
  }
});

test('a settled task has nothing left to confirm or send back', () => {
  for (const status of ['DONE', 'CANCELLED', 'FAILED']) {
    for (const decision of ['CONFIRM', 'SEND_BACK'] as const) {
      const refusal = ownerDecisionRefusal(standing({ status, ...waitingOn(REPORT) }), decision, REPORT);
      assert.equal(refusal?.code, TASK_SETTLED_CODE, `${status} ${decision}`);
      assert.match(refusal?.message ?? '', new RegExp(`this task is ${status}`, 'u'));
    }
  }
  // IN_PROGRESS is unsettled, like OPEN.
  assert.equal(ownerDecisionRefusal(standing({ status: 'IN_PROGRESS', ...waitingOn(REPORT) }), 'CONFIRM', REPORT), null);
});

/**
 * The compare-and-set, as a table: every combination of what is waiting and what the press
 * answered. A card answers the report it was drawn for; the panel answers "nothing is waiting".
 */
test('a confirmation or a send-back answers exactly what is waiting, and nothing else', () => {
  const rows: Array<{
    label: string;
    facts: Partial<OwnerConfirmationStanding>;
    decision: OwnerDecisionValue;
    answering: string | null;
    code: string | null;
    because?: RegExp;
  }> = [
    { label: 'never ran: the panel confirms', facts: {}, decision: 'CONFIRM', answering: null, code: null },
    { label: 'never ran: a card that cannot exist', facts: {}, decision: 'CONFIRM', answering: REPORT,
      code: STALE_CODE, because: /already been decided/u },
    { label: 'never ran: nothing to send back to', facts: {}, decision: 'SEND_BACK', answering: null,
      code: NOTHING_TO_SEND_BACK_CODE },
    { label: 'waiting: the card confirms its own report', facts: waitingOn(REPORT), decision: 'CONFIRM',
      answering: REPORT, code: null },
    { label: 'waiting: the card sends back its own report', facts: waitingOn(REPORT),
      decision: 'SEND_BACK', answering: REPORT, code: null },
    { label: 'waiting: the panel may not confirm around the card', facts: waitingOn(REPORT),
      decision: 'CONFIRM', answering: null, code: STALE_CODE, because: /card in that run's session/u },
    { label: 'waiting: a send-back that names no report', facts: waitingOn(REPORT),
      decision: 'SEND_BACK', answering: null, code: STALE_CODE },
    { label: 'a later run reported while the card was being read', facts: waitingOn(LATER_REPORT),
      decision: 'CONFIRM', answering: REPORT, code: STALE_CODE, because: /later run of this task/u },
    { label: 'a later run reported before the send-back arrived', facts: waitingOn(LATER_REPORT),
      decision: 'SEND_BACK', answering: REPORT, code: STALE_CODE, because: /later run of this task/u },
    { label: 'sent back and running again: the panel may confirm', facts: waitingOn(REPORT, true),
      decision: 'CONFIRM', answering: null, code: null },
    { label: 'sent back: the same card pressed twice', facts: waitingOn(REPORT, true),
      decision: 'CONFIRM', answering: REPORT, code: STALE_CODE, because: /already been decided/u },
    { label: 'sent back: nothing is waiting to send back again', facts: waitingOn(REPORT, true),
      decision: 'SEND_BACK', answering: REPORT, code: NOTHING_TO_SEND_BACK_CODE },
  ];
  for (const row of rows) {
    const refusal = ownerDecisionRefusal(standing(row.facts), row.decision, row.answering);
    assert.equal(refusal?.code ?? null, row.code, row.label);
    if (row.because) assert.match(refusal?.message ?? '', row.because, row.label);
    if (refusal) {
      assert.equal(refusal.kind, 'REFUSAL', row.label);
      assert.match(refusal.message, /nothing was written/u, row.label);
      assert.ok(refusal.requiredAction.length > 0, `${row.label}: a refusal names what to do instead`);
    }
  }
});

test('each refusal is thrown as the HTTP error its code means', () => {
  const as = (code: string) => {
    try {
      throwOwnerConfirmationRefusal({ code, kind: 'REFUSAL', requiredAction: 'X', message: 'm' });
    } catch (error) {
      return error;
    }
    return null;
  };
  assert.ok(as(REQUIRES_ACCOUNT_OWNER_CODE) instanceof ForbiddenException);
  assert.ok(as(SEND_BACK_REASON_CODE) instanceof BadRequestException);
  for (const code of [NOT_DECLARED_CODE, TASK_SETTLED_CODE, STALE_CODE, NOTHING_TO_SEND_BACK_CODE]) {
    assert.ok(as(code) instanceof ConflictException, code);
  }
});

test('a send-back\'s message is filed under a client turn id that names its decision', () => {
  assert.equal(ownerSendBackClientTurnId('d-1'), 'owner-send-back:d-1');
  assert.notEqual(ownerSendBackClientTurnId('d-1'), ownerSendBackClientTurnId('d-2'),
    'two decisions are two messages, never one replayed');
});
