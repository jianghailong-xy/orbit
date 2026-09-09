import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { TaskStatus } from '@prisma/client';
import type { QuestionAnswers } from '@orbit/shared';

import {
  CONFIRM_OPTION,
  SEND_BACK_OPTION,
  buildEvidenceAsk,
  buildEvidenceAskProtocol,
  evidenceDecisionFromAnswers,
} from './coordinator-evidence-ask';
import type { PendingEvidenceJudgment } from './pending-evidence-judgments';

/**
 * What the send-back step of the protocol has to say, and the wire shape that makes it true.
 *
 * The step is the one place a turn learns where a note comes from. It used to say only "必须带 note"
 * and "人没说要什么就再问人", and a reader who had the reason in hand could satisfy both readings of
 * that: ask again for something already answered, or write a note of its own. Neither is a bug the
 * decision door catches — `task-evidence-decision.ts` refuses an ABSENT note and has nothing to say
 * about an invented one — so the step is the whole of the guard, and asserting on it is asserting on
 * the guard.
 *
 * The prose claim is paired with a runtime witness rather than left as a text scan: the assertion
 * that the protocol names the SECOND element would stay green over a build where the reason arrived
 * somewhere else, and then the message would be confidently wrong. So the same answers the cards
 * post are put through `evidenceDecisionFromAnswers` below, and the reason is read out of the
 * position the protocol names.
 */

const CLAIM = 'the protocol says where the reason comes from';
const CRITERION_TEXT = 'the send-back step names the element the reason arrives in';

function row(): PendingEvidenceJudgment {
  return {
    taskId: randomUUID(),
    title: '协议要说清：退回理由随 answers 回来',
    status: TaskStatus.IN_PROGRESS,
    projectId: randomUUID(),
    criterion: { key: 'abc123', text: CRITERION_TEXT },
    evidenceRevision: '2',
    submittedAt: new Date('2026-09-09T00:00:00.000Z'),
    ageSeconds: 60,
    claim: CLAIM,
    gaps: [],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
  };
}

function protocol(): string {
  const ask = buildEvidenceAsk({
    readAt: new Date('2026-09-09T00:01:00.000Z'),
    decidingSessionId: randomUUID(),
    count: 1,
    oldestAgeSeconds: 60,
    pending: [row()],
    waitingOnYou: [],
  });
  assert.ok(ask, 'a pending row produced no ask to state a protocol for');
  return buildEvidenceAskProtocol(ask, new Date('2026-09-09T00:01:00.000Z'));
}

/**
 * The send-back step alone, cut out by its own numbering.
 *
 * Bounded rather than searched for: every word below also appears somewhere else in this message —
 * `note` in the step that forbids inventing one, the option's own label in step 1's instruction to
 * offer it, the question body quoted at the end — so a bare `includes` over the whole string is
 * green whether or not the sentence is in the step that needs it.
 */
function sendBackStep(text: string): string {
  const from = text.indexOf(`3. 人选「${SEND_BACK_OPTION}」`);
  assert.notEqual(from, -1, 'the protocol has no send-back step; this spec is reading the wrong thing');
  const to = text.indexOf('4. 人自己写了字', from);
  assert.ok(to > from, 'the send-back step is not followed by the step after it');
  return text.slice(from, to);
}

test('the send-back step says the reason arrives as the second element and goes to note verbatim', () => {
  const step = sendBackStep(protocol());

  // The element, named as a position rather than gestured at: this is what a reader needs in order
  // to find the reason at all.
  assert.match(step, /第二个元素/, 'the step does not say which element carries the reason');
  // Where it goes, and that it goes there unchanged. A note the turn improved is a note the person
  // did not write, and the decision it is recorded against is the person's.
  assert.match(step, /原样传给 note/, 'the step does not say to pass the reason to note as it stands');
  assert.match(step, /别改写/, 'the step does not forbid rewriting the reason');

  // And the two clauses in the order a reader meets them. The failure being fixed is a turn that
  // reaches "再问人" while holding the answer, so the passthrough has to come FIRST and the
  // ask-again has to be the narrow case rather than the default.
  const secondElement = step.indexOf('第二个元素');
  const askAgain = step.indexOf('再问人');
  assert.ok(askAgain > secondElement, 'the step sends the reader back to the person before telling it where the reason is');
  assert.match(step, /只有那个数组除了标签什么都没有时/, 'the ask-again case is not stated as the narrow one');
  assert.match(step, /别自己编/, 'the step no longer forbids inventing a note');
});

test('the answers a decision card posts carry the reason exactly where the step says', () => {
  const ask = buildEvidenceAsk({
    readAt: new Date('2026-09-09T00:01:00.000Z'),
    decidingSessionId: randomUUID(),
    count: 1,
    oldestAgeSeconds: 60,
    pending: [row()],
    waitingOnYou: [],
  })!;
  const question = ask.questions[0]!;

  // What `ApprovalPanel.tsx`'s `EvidenceDecisionForm` and `EvidenceDecision.swift`'s
  // `answers(for:)` post: the server's own label, then the reason the card made required.
  const reason = 'name the artifact the command produced, and quote the line that names it';
  const answers: QuestionAnswers = { [question.question]: [SEND_BACK_OPTION, reason] };

  // The decision is still read the same way, and the extra string does not disturb it.
  assert.equal(evidenceDecisionFromAnswers(question, answers), 'SEND_BACK');
  // And the position the protocol names is the position the reason is in.
  assert.equal(answers[question.question]![1], reason);

  // The other pick posts one element, which is what makes "除了标签什么都没有" a case that happens
  // rather than a hypothetical: a confirm needs no note and sends none.
  const confirmed: QuestionAnswers = { [question.question]: [CONFIRM_OPTION] };
  assert.equal(evidenceDecisionFromAnswers(question, confirmed), 'CONFIRM');
  assert.equal(confirmed[question.question]!.length, 1);
});
