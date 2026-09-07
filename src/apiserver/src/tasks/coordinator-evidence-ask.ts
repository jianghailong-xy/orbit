import { uuidToBase62, type QuestionAnswers } from '@orbit/shared';

import type { EvidenceDecisionValue } from './task-evidence-decision';
import type {
  PendingEvidenceJudgment,
  PendingEvidenceJudgmentQueue,
} from './pending-evidence-judgments';

/**
 * The turn a completion-evidence revision puts in the coordinator's inbox, as a QUESTION FOR A
 * PERSON.
 *
 * WHY THE COORDINATOR IS NOT THE DECIDER
 * ======================================
 * The delivery that lands this turn (`coordinator-delivery.service.ts`) hands a model a fact its
 * own §1.1 says is a notification. What the fact needs is a JUDGMENT — whether some work is
 * finished — and the one thing `task-evidence-decision.ts` says a CONFIRM is worth is that it came
 * from somebody who did not do the work. A coordinator answering out of its own reading would
 * satisfy that check (its session never touched the task) and settle nothing: the account owner is
 * the party whose "yes" this criterion is asking for. So the turn's job is to ASK, and the tool for
 * asking a person mid-turn is `AskUserQuestion` — the same card the browser already renders for a
 * pending approval.
 *
 * The coordinator is still the one that RECORDS it: `task_evidence_decide` binds a decision to the
 * session it was made in, and the coordinator session is the one holding the answer. That session
 * has no `taskId` and has submitted no evidence, so `decidingSessionDisqualification` returns null
 * for it and the independence check passes on the facts rather than on an exemption.
 *
 * WHAT THE CARD SAYS, AND IN WHICH ORDER
 * ======================================
 * Three fields, and the order is the reader's rather than the row's:
 *
 *  1. the CLAIM, because "is this done" is a question about what somebody says they did, and a card
 *     that opened with the standard would make the reader hold it in mind with nothing to hold it
 *     against;
 *  2. the criterion it is measured against, quoted as the evidence quoted it;
 *  3. the gaps the submitter DECLARED — the field most likely to change the answer, for the reason
 *     `DecisionRail.tsx` never folds it: a submission saying what it did not establish is telling
 *     the reader where to look.
 *
 * The two options are `DecisionRail.tsx`'s two, word for word. A person who answers this card in
 * the transcript and the same person who answers it on the decision rail are answering one
 * question, and a second vocabulary for it would be two questions that happen to write the same
 * row.
 */

/** The tool the turn is told to ask with — `Approval.toolName` for the row this raises. */
export const EVIDENCE_ASK_TOOL = 'AskUserQuestion';

/** `DecisionRail.tsx`'s labels. Copied rather than imported: the web bundle is a separate package,
 *  and the invariant is that the WORDS match, which the spec asserts by comparing the strings. */
export const CONFIRM_OPTION = 'Confirm completion';
export const SEND_BACK_OPTION = 'Send back';

/** The chip above the card. AskUserQuestion caps a header at 12 characters. */
export const EVIDENCE_ASK_HEADER = 'Completion';

export interface EvidenceQuestionOption {
  label: string;
  description: string;
}

/** One card, in the shape `AskUserQuestion` takes and the browser's approval panel renders. */
export interface EvidenceQuestion {
  question: string;
  header: string;
  options: EvidenceQuestionOption[];
  multiSelect: false;
}

/** The tool input for a whole delivery: one question per row the coordinator may answer. */
export interface EvidenceAsk {
  questions: EvidenceQuestion[];
}

/**
 * The card's body: claim, standard, gaps — and then which version of which task it is about.
 *
 * That last line is not decoration. `answers` comes back keyed by the QUESTION TEXT, so two rows
 * whose claims and criteria happen to read alike would collapse onto one key and one of the two
 * answers would be lost. The task and the revision make the key what it has to be, and they are at
 * the END because they are the identity of the question rather than the substance of it.
 */
export function evidenceQuestionBody(row: PendingEvidenceJudgment): string {
  const claim = row.claim.trim() === ''
    ? 'This revision states no claim.'
    : row.claim.trim();
  const criterion = row.criterion
    ? `Against criterion ${row.criterion.key}: ${row.criterion.text}`
    : 'This evidence quotes no stated criterion.';
  const gaps = row.gaps.length === 0
    ? 'Declared gaps: the submitter declared none.'
    : `Declared gaps:\n${row.gaps.map((gap) => `- ${gap}`).join('\n')}`;
  return `${claim}\n\n${criterion}\n\n${gaps}\n\n`
    + `${row.title} — task ${uuidToBase62(row.taskId)}, evidence rev ${row.evidenceRevision}`;
}

/** One row's card. */
export function buildEvidenceQuestion(row: PendingEvidenceJudgment): EvidenceQuestion {
  return {
    question: evidenceQuestionBody(row),
    header: EVIDENCE_ASK_HEADER,
    options: [
      {
        label: CONFIRM_OPTION,
        description:
          `This evidence settles the criterion it quotes. Recorded as CONFIRM against rev `
          + `${row.evidenceRevision}, which is what derives DONE.`,
      },
      {
        label: SEND_BACK_OPTION,
        description:
          'It does not settle it. Recorded as SEND_BACK with a note saying what the next revision '
          + 'has to show; the task stays open and nothing else changes.',
      },
    ],
    multiSelect: false,
  };
}

/**
 * The whole tool call, or null when this coordinator has nothing it may answer.
 *
 * Only `pending` is asked about, because only `pending` is a question addressed to this reader:
 * `waitingOnYou` is a row the door refuses whatever anybody presses, and putting one on a card
 * would be the third version of the bug the queue's own grouping exists to stop.
 */
export function buildEvidenceAsk(queue: PendingEvidenceJudgmentQueue): EvidenceAsk | null {
  if (queue.pending.length === 0) return null;
  return { questions: queue.pending.map(buildEvidenceQuestion) };
}

/**
 * The person's pick, read back as the decision it is — or null when it is not one.
 *
 * Null is a real answer and the caller is told to treat it as one: `AskUserQuestion` always lets a
 * person type their own reply instead of picking, and a typed reply is a message rather than a
 * verdict. Guessing which of the two it meant would be this turn deciding the thing it was sent to
 * ask about. Both labels picked at once reaches the same null for the same reason.
 */
export function evidenceDecisionFromAnswers(
  question: EvidenceQuestion,
  answers: QuestionAnswers | null | undefined,
): EvidenceDecisionValue | null {
  const picked = answers?.[question.question] ?? [];
  const confirm = picked.includes(CONFIRM_OPTION);
  const sendBack = picked.includes(SEND_BACK_OPTION);
  if (confirm === sendBack) return null;
  return confirm ? 'CONFIRM' : 'SEND_BACK';
}

/**
 * What the turn is told to do, and it is a protocol rather than a briefing.
 *
 * The rows are copied in — the one message in this file's neighbourhood that carries state, and it
 * is deliberate. Nothing a coordinator session can call reads the pending queue: `task_evidence_*`
 * is per task, and the queue is "which of this account's tasks is waiting", which no task-scoped
 * tool can express. A turn told to go and read it would go looking for a tool that is not there.
 * So the read happens where it can — at delivery, on the server — and what arrives is its answer,
 * stamped with when it was taken.
 *
 * The staleness that buys is bounded by the door rather than by this message: `task_evidence_decide`
 * compares the revision being answered against the task's latest and refuses anything else, so a
 * question that moved between the read and the answer is refused rather than mis-recorded. The
 * message says so, because a turn that met that refusal without expecting it would report a
 * failure of the delivery instead of re-reading the task.
 */
export function buildEvidenceAskProtocol(ask: EvidenceAsk, readAt: Date): string {
  const cards = ask.questions
    .map((question, index) => (
      `【${index + 1}/${ask.questions.length}】\n${question.question}`
    ))
    .join('\n\n');
  return (
    `这一轮要做的事，按顺序：\n`
    + `1. 下面 ${ask.questions.length} 条是这条会话现在可以裁决的待决完成证据（服务端发这条消息时读的`
    + `待决队列，读于 ${readAt.toISOString()}）。用 ${EVIDENCE_ASK_TOOL} 把它们问给人：`
    + `一条证据一个问题，问题正文照抄下面那一段，两个选项就是「${CONFIRM_OPTION}」和「${SEND_BACK_OPTION}」。`
    + `别改写正文、别把几条并成一个问题、更别替人选。\n`
    + `2. 人选「${CONFIRM_OPTION}」：task_evidence_decide，decision=CONFIRM，`
    + `evidenceRevision 传那一条的版本号。\n`
    + `3. 人选「${SEND_BACK_OPTION}」：decision=SEND_BACK 必须带 note，写清下一版证据要给出什么；`
    + `不带 note 会被拒，什么都不会写。人没说要什么就再问人，别自己编。\n`
    + `4. 人自己写了字、没选这两个之一：那不是裁决。别写 task_evidence_decide，按人写的做。\n\n`
    + `这几条是发消息那一刻的快照。真正的检查在裁决那道门上：evidenceRevision 必须还是任务当下的最新版，`
    + `被 EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED 拒了就重读 task_evidence_list 再答当下那一版。\n\n`
    + `—— 要问的问题 ——\n\n${cards}`
  );
}
