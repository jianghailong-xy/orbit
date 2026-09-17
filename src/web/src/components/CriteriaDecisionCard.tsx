import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { CardActionButton, CardActions } from './CardAction';
import { api } from '../api';
import { pendingCriteriaDecisionsQuery } from '../lib/queries';

/**
 * The card that asks the account owner whether this project's ruler may move, in the conversation
 * the question was delivered to.
 *
 * WHY THIS CARD CARRIES A PROVENANCE MARK
 * ---------------------------------------
 * The whole security argument is that THIS CARD IS NOT THE AGENT'S TYPING. A coordinator session
 * cannot approve a loosening of its own project's criteria — the door refuses every call that
 * carries an acting session — so the only way the ruler moves is a person pressing something the
 * SERVER authorised. But a transcript is a place where an agent's words appear, and an agent can
 * write a paragraph that reads exactly like a decision card. So the mark is not decoration: it is
 * the one visible difference between "Orbit is asking you" and "something in the conversation is
 * asking you", and a reader has to be able to make that difference at a glance. Everything above
 * the actions is a field of the server's derived row or a statement about the mechanism; nothing
 * on this card is composed from anything an agent said.
 *
 * THE BUTTONS GO STRAIGHT TO THE DOOR, WITH THE READER'S OWN CREDENTIAL
 * --------------------------------------------------------------------
 * `api()` is the browser's authenticated fetch, so a press is the ACCOUNT OWNER answering
 * `POST /projects/:id/acceptance/criteria-decisions/:intentId` and nothing is relayed through the
 * agent — which is the same rule stated from the other side: the party asking for a looser ruler
 * must not be the party that moves it. The proposal's one-time `commitToken` is the second key and
 * rides with the press; the proposer never receives it.
 *
 * NOTHING IS FROZEN INTO THE FRAME EXCEPT THE ADDRESS
 * ---------------------------------------------------
 * A delivered card is a frame that exists for as long as the conversation does, and the question
 * it was about can be answered in another window, displaced by a newer proposal, or stranded by a
 * ruler that moved underneath it. So this card keeps ONE thing across renders — the proposal's id,
 * which is what was delivered — and reads everything else out of `readPendingCriteriaDecisions` on
 * every render. `criteriaDecisionStanding` below is the whole of that: the three stale states are
 * conclusions about the derived read rather than local state somebody has to remember to clear.
 *
 * A consequence worth stating, because it looks like a bug until it is read as the design: a card
 * that has gone stale shows NO diff. The derived read drops a proposal the moment it is settled or
 * displaced, so the proposed criteria are genuinely not published any more, and a card that still
 * displayed them would be displaying a frozen copy — the exact thing this card does not keep. What
 * is left is the address, what happened to it, and two buttons that cannot be pressed. For a
 * proposal answered at another end, "what happened" includes WHICH answer: the read publishes the
 * recent answers beside the questions (`settled`) — the outcome, its seals, and what the proposal
 * asked for. The last of those is the RECEIPT's, not this card's: a card whose question has moved
 * on is not the place to lay out words nobody is being asked about any more.
 */

/** One criterion as the proposal states it. `id` is null for one the proposal is adding. */
export interface ProposedCriterion {
  id: string | null;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
}

/**
 * WHAT THE CARD DRAWS, AND WHY IT IS NOT `proposed`
 * -------------------------------------------------
 * A criteria edit is a whole-collection replacement, so a proposal that reworded three criteria out
 * of eight arrives stating all eight, and five of them are the words already on record. This card
 * used to lay out all eight, which buried the three that moved inside a 360px scroll box: the
 * reader could not see which ones the decision was about, and scrolling to the end did not tell
 * them either.
 *
 * So the card renders the DIFF and folds the rest away behind a count. The diff is the server's:
 * `readPendingCriteriaDecisions` compares the restatement against the definitions in force inside
 * the transaction that decided the proposal was pending. Nothing here compares anything — a client
 * that fetched the criteria in force and diffed them itself would be making the card's central
 * claim a conclusion IT reached, from two reads taken at two moments, and would have to reach it
 * again in every client.
 */
export type CriteriaProposalChange = 'SAME' | 'CHANGED' | 'NEW' | 'REMOVED';

/** The fields a rewrite can move: all three a criterion carries, not just the assertion. */
export type CriteriaProposalField =
  | 'text'
  | 'verificationMethod'
  | 'completionCriterionOverrideReason';

/** One criterion's words, on either side of the comparison. */
export interface CriterionWording {
  text: string;
  verificationMethod: string | null;
  completionCriterionOverrideReason: string | null;
}

/**
 * One run of a rewritten field, and what the rewrite does with it — the server's cut.
 *
 * Saying which criteria moved was only half of it: a rewrite still arrived as two whole paragraphs
 * and a reader had to compare ninety characters of Chinese against ninety more to find the clause
 * that changed. So the comparison is taken down to the level the change happened at, on the
 * SERVER, for the same reason the criterion-level one is (see above) — a client that cut the two
 * texts itself would be reaching the card's central claim on its own, twice, in two languages.
 *
 * The runs are in reading order and one merged sequence: the words ON RECORD are the `KEPT` and
 * `REMOVED` runs, the words PROPOSED are the `KEPT` and `ADDED` ones. One line renders both.
 */
export type CriterionSegmentSide = 'KEPT' | 'REMOVED' | 'ADDED';

export interface CriterionSegment {
  side: CriterionSegmentSide;
  text: string;
}

/** One field of a rewrite, cut up. One per entry in `changed`, in that same order. */
export interface CriterionFieldRewrite {
  field: CriteriaProposalField;
  segments: CriterionSegment[];
}

/** What this proposal does to one criterion: which one, which way, and both sets of words. */
export interface CriteriaProposalChangeEntry {
  change: CriteriaProposalChange;
  /** The definition this is about; null for one the proposal is adding, which names none. */
  definitionId: string | null;
  /** Its place in the proposed set — or, for one being dropped, in the set on record. */
  ordinal: number;
  /** The proposal's words. Null for `REMOVED`. */
  proposed: CriterionWording | null;
  /** The words it replaces, off the definition in force. Null for `NEW`. */
  onRecord: CriterionWording | null;
  /** Which fields differ. Empty except on `CHANGED`. */
  changed: CriteriaProposalField[];
  /** Each of those fields cut into what the rewrite keeps, drops and adds, in `changed` order. */
  rewrites: CriterionFieldRewrite[];
}

/** The whole of what a proposal would do to the ruler, and how much of it it leaves alone. */
export interface CriteriaProposalDiff {
  entries: CriteriaProposalChangeEntry[];
  sameCount: number;
  changedCount: number;
  newCount: number;
  removedCount: number;
}

/** Whether the door would record a decision about this proposal right now — the server's answer. */
export interface CriteriaDecisionDecidability {
  decidable: boolean;
  /** The door's own refusal code, null when decidable. */
  refusal: string | null;
  /** What would clear it, in the vocabulary the refusal carries. */
  requiredAction: string | null;
}

/**
 * One held proposal, as `readPendingCriteriaDecisions` publishes it to the owner.
 *
 * `commitToken` is on the OWNER's read of this row and on no other: it is the proposal's one-time
 * key, and the session that filed the proposal is never given it.
 */
export interface PendingCriteriaDecisionRow {
  intentId: string;
  projectId: string;
  commitToken: string;
  actionDigest: string;
  filedAt: string;
  ageSeconds: number;
  /** The seal of the standard set this proposal was composed against. */
  baselineSeal: string;
  /** The seal standing now. Equal to `baselineSeal` exactly when the proposal is decidable. */
  currentSeal: string;
  proposed: ProposedCriterion[];
  /** The same restatement read against the criteria in force — what this card is drawn from. */
  diff: CriteriaProposalDiff;
  /** The proposal this one displaced, or null when it displaced nothing. */
  supersededIntentId: string | null;
  decidability: CriteriaDecisionDecidability;
}

/** What an answered proposal did to one criterion, in the vocabulary both ends say it in. */
export type SettledCriterionChange = 'REWORDED' | 'ADDED' | 'DROPPED';

/**
 * One criterion an answered proposal moved — the half of it the record still holds.
 *
 * Not `CriteriaProposalChangeEntry`: there is no `onRecord` side and no cut, because the words a
 * rewrite REPLACED were never stored. `ordinal` and `text` are both null on a DROPPED one for that
 * same reason — what was dropped is entirely words-before.
 */
export interface SettledCriterionEntry {
  change: SettledCriterionChange;
  definitionId: string | null;
  /** Its place in the proposed set. Null for a DROPPED one, which the proposal gives no place. */
  ordinal: number | null;
  /** The words the answer was given about. Null for DROPPED. */
  text: string | null;
}

/** What one answered proposal asked for: what it moved, and how much it left alone. */
export interface SettledProposalMaterial {
  changed: SettledCriterionEntry[];
  rewordedCount: number;
  addedCount: number;
  droppedCount: number;
  /** How many criteria the proposal restated with the words already sealed. */
  unchangedCount: number;
}

/**
 * One proposal the read says WAS answered: which answer, what it did to the seal, and what it asked
 * for.
 *
 * Only the card that was pressed is handed the door's response. Every other card for the same
 * proposal used to go stale knowing only that somebody had answered — the account owner refused one
 * in a browser on 2026-09-11 and found the phone's card dimmed with no way to tell which answer it
 * had been given. The answer is a committed row, so it arrives on the same derived read as the rest
 * of the card.
 *
 * `proposal` is the words, which this read withheld until 2026-09-17 — so approving turned a card
 * showing a word-by-word diff into one line of receipt, and the account owner's report was the
 * plain consequence: after approving, what the change had been was no longer anywhere. It is one
 * side only: what a rewrite replaced is stored nowhere, so a card built on this must not be read as
 * a before-and-after, and `SETTLED_NO_BEFORE_WORDS` below is where it says so.
 */
export interface SettledCriteriaDecision {
  intentId: string;
  decision: CriteriaDecision;
  decidedAt: string;
  /** The seal the answer was given against. */
  baseSeal: string;
  /** The seal standing afterwards: `baseSeal` again for a refusal, moved by an approval. */
  resultingSeal: string;
  /**
   * What the answer was about — the version that took effect on an approval, the one that did not
   * on a refusal. Absent from a server older than this bundle, and null for a proposal row the
   * server could not read; either way the receipt draws its line and no fold.
   */
  proposal?: SettledProposalMaterial | null;
}

/** The derived read: every proposal of one project that is still a question, oldest first. */
export interface PendingCriteriaDecisionQueue {
  readAt: string;
  projectId: string;
  count: number;
  oldestAgeSeconds: number | null;
  decidableCount: number;
  pending: PendingCriteriaDecisionRow[];
  /**
   * The proposals most recently answered, newest first. Absent from a server older than this
   * bundle — and a card whose answer is not here says only that it was answered.
   */
  settled?: SettledCriteriaDecision[];
}

/** Why the answer did not reach the session that proposed the change — the door's own code. */
export type CriteriaDecisionReplyUnsent =
  | 'SESSION_GONE'
  | 'SESSION_ENDED_WITHOUT_TASK'
  | 'DELIVERY_FAILED';

/**
 * Where Orbit sent the answer to the session that asked for the change: a turn on that session, a
 * comment on its task when the session had already ended, or nowhere, with the reason.
 */
export type CriteriaDecisionReply =
  | { channel: 'SESSION'; sessionId: string; sessionTitle: string; turnId: string; sentAt: string }
  | {
      channel: 'TASK_COMMENT';
      sessionId: string;
      taskId: string;
      taskTitle: string;
      commentId: string;
      sentAt: string;
    }
  | { channel: 'NOT_SENT'; sessionId: string; reason: CriteriaDecisionReplyUnsent };

/** What the door returns once it has answered one — read back, not recomputed here. */
export interface CriteriaDecisionResult {
  intentId: string;
  decision: CriteriaDecision;
  decidedAt: string;
  baseSeal: string;
  resultingSeal: string;
  /** True for an APPROVE and only an APPROVE: whether any criterion actually moved. */
  applied: boolean;
  /**
   * Where the answer went. Null when the owner filed the change with no session, so nobody was
   * waiting on it; absent from a server older than this bundle.
   */
  reply?: CriteriaDecisionReply | null;
}

/** The two answers the door takes. There is deliberately no third that leaves it pending. */
export type CriteriaDecision = 'APPROVE' | 'REJECT';

/** The door's refusal codes, in the door's spelling, so the card can say which one it would meet. */
export const CRITERIA_DECISION_BASE_SEAL_MOVED = 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED';
export const CRITERIA_DECISION_ALREADY_SETTLED = 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED';

/** The mark. Short, and the only thing on the card claiming who wrote it. */
export const PROVENANCE_LABEL = 'FROM ORBIT';
export const PROVENANCE_TITLE =
  'Orbit composed this card and authorised its buttons. An agent asked for the change; nothing an '
  + 'agent typed can appear here, and pressing a button here does not go through one.';

export const CRITERIA_DECISION_HEADING =
  'A weakening change to this project’s ruler needs your decision';
/**
 * What the receipt carries instead: the question is answered, and this is the record of the answer.
 *
 * The receipt outlives the press — it is drawn from the read, so it appears on every reload and on
 * every device, including the ones that never saw the card — and a record that still said "needs
 * your decision" over a line reading "✓ Approved by you" would be telling its reader to decide
 * something already decided.
 */
export const CRITERIA_DECISION_RECORDED_HEADING = 'Decision recorded';
/** The heading a card that can no longer be answered carries instead. */
export const CRITERIA_DECISION_STALE_HEADING = 'This decision is no longer yours to make';
/** And the one for a card that cannot say: this browser has not managed the read. */
export const CRITERIA_DECISION_UNREAD_HEADING = 'This card could not be re-read just now';
/**
 * The two a card carries instead of the stale heading once the read names the answer given at
 * another end — the verdict first, because "which was it?" is the question a dimmed card was left
 * unable to answer.
 */
export const CRITERIA_DECISION_REFUSED_HEADING = 'Refused at another end — the ruler did not move';
export const CRITERIA_DECISION_APPROVED_HEADING = 'Approved at another end — the ruler moved';
export const APPROVE_LABEL = 'Approve & re-seal';
export const REFUSE_LABEL = 'Refuse';

/**
 * What is NOT at stake, said on the card because it is the thing readers get wrong.
 *
 * A held proposal changes nothing while it is held: the criteria on record are the ones in force,
 * and the session that proposed the change was told to go on working against them. So refusing
 * stops the ruler from moving and stops nothing else — which is what makes `Refuse` an ordinary
 * answer rather than a way of blocking somebody's work.
 */
export const NOTHING_IS_ON_HOLD =
  'Nothing is on hold. The criteria on record are the ones in force and the session that proposed '
  + 'this was told to keep working against them, so refusing stops the ruler from moving, not the '
  + 'work.';

/**
 * THE WORDS THE DIFF IS SAID IN, ON BOTH CLIENTS.
 *
 * One vocabulary for the three things a proposal can do to a criterion, so the badge on a row, the
 * one-line summary above the list, and the fold over the untouched ones are all saying the same
 * word about the same thing. `CriteriaDecisionCopyParityTests.swift` reads these declarations out
 * of this file and compares them with OrbitKit's, because nothing in either build catches a phrase
 * re-worded at one end only.
 */
export const CRITERION_REWORDED_WORD = 'reworded';
export const CRITERION_DROPPED_WORD = 'dropped';
export const CRITERION_ADDED_WORD = 'added';

/** The badge on one row of the diff, in the same words the summary counts them in. */
export const CRITERION_REWORDED_LABEL = 'reworded by this proposal';
export const CRITERION_ADDED_LABEL = 'new in this proposal';
export const CRITERION_DROPPED_LABEL = 'dropped by this proposal';

/**
 * WHAT THE TWO MARKS ON A REWRITTEN LINE MEAN, SPELLED OUT ONCE.
 *
 * A rewrite used to be two paragraphs, the second labelled `on record now`, and that label was the
 * whole of how a reader knew which half was which. It is one line now — the words that stayed,
 * with the dropped run struck through and the new run underlined in place — so the label has
 * nothing left to point at and this legend takes its job: it is the only thing on the card that
 * says what a strikethrough means, and without it the marks are decoration.
 *
 * Kept to one short line because it costs one, on a card whose whole problem was height.
 */
export const INLINE_DIFF_LEGEND = 'struck through is dropped · underlined is added';
/** On the runs themselves, for a pointer and for a screen reader that skips the legend. */
export const DROPPED_RUN_TITLE = 'dropped by this rewrite';
export const ADDED_RUN_TITLE = 'added by this rewrite';
/** And the second field, shown only when the proposal moved it. */
export const METHOD_LABEL = 'how it is judged';

/**
 * The line that says how much of the ruler this proposal leaves alone.
 *
 * IT IS WHY THE UNTOUCHED ONES ARE FOLDED AND NOT HIDDEN. The question this card answers is not
 * only "what changes" but "how much of the ruler is being rewritten" — a reader who is shown three
 * rows and nothing else cannot tell a proposal that reworded three criteria from one that replaced
 * the whole set with three. So the count is always on screen, and the words behind it are one
 * disclosure away.
 */
export const UNCHANGED_SUFFIX_ONE = 'criterion is unchanged by this proposal';
export const UNCHANGED_SUFFIX_MANY = 'criteria are unchanged by this proposal';

export function unchangedLine(count: number): string {
  return `${count} ${count === 1 ? UNCHANGED_SUFFIX_ONE : UNCHANGED_SUFFIX_MANY}`;
}

/** What a proposal nothing could be read out of says instead of a diff. */
export const CHANGE_SUMMARY_UNREADABLE = 'nothing this reader could read';
/** And what a restatement that moved nothing says — every criterion came back word for word. */
export const CHANGE_SUMMARY_NOTHING_MOVES = 'nothing moves';

/** The size of the decision in one line: what moves, and how much did not. */
export function changeSummary(diff: CriteriaProposalDiff): string {
  if (diff.entries.length === 0) return CHANGE_SUMMARY_UNREADABLE;
  const moved: string[] = [];
  if (diff.changedCount > 0) moved.push(`${diff.changedCount} ${CRITERION_REWORDED_WORD}`);
  if (diff.removedCount > 0) moved.push(`${diff.removedCount} ${CRITERION_DROPPED_WORD}`);
  if (diff.newCount > 0) moved.push(`${diff.newCount} ${CRITERION_ADDED_WORD}`);
  const head = moved.length === 0 ? CHANGE_SUMMARY_NOTHING_MOVES : moved.join(', ');
  return `${head}, ${diff.sameCount} unchanged`;
}

/** The badge one row carries, or null for the untouched ones, which carry none. */
export function changeLabel(change: CriteriaProposalChange): string | null {
  switch (change) {
    case 'CHANGED':
      return CRITERION_REWORDED_LABEL;
    case 'NEW':
      return CRITERION_ADDED_LABEL;
    case 'REMOVED':
      return CRITERION_DROPPED_LABEL;
    case 'SAME':
      return null;
  }
}

/** The rows a reader is shown by default: everything this proposal would move. */
export function movedEntries(diff: CriteriaProposalDiff): CriteriaProposalChangeEntry[] {
  return diff.entries.filter((entry) => entry.change !== 'SAME');
}

/** And the ones behind the fold. Read off `change` rather than off `sameCount` so the list and
 *  the count cannot disagree about which rows they are talking about. */
export function unmovedEntries(diff: CriteriaProposalDiff): CriteriaProposalChangeEntry[] {
  return diff.entries.filter((entry) => entry.change === 'SAME');
}

/** Whether anything on this card is drawn with the two marks, and so whether to explain them. A
 *  proposal that only adds and drops criteria has no struck-through words on it, and a legend for
 *  marks that are not there is a line of height spent on nothing. */
export function hasRewrite(diff: CriteriaProposalDiff): boolean {
  return diff.entries.some((entry) => entry.change === 'CHANGED');
}

/** A seal as a reader compares it: enough to tell two apart, never the whole 64 characters. */
export function shortSeal(seal: string): string {
  return seal === '' ? '(unreadable)' : seal.slice(0, 12);
}

/**
 * Where one delivered card stands RIGHT NOW, derived from the read and from nothing else.
 *
 * The four terminal shapes a delivered proposal can be in, and how each is read off the queue:
 *
 *   * DECIDABLE — the row is in the read and the server says the door would take an answer.
 *   * BASE_SEAL_MOVED — the row is in the read and the server says it would not: the ruler this
 *     proposal was composed against is not the one in force. The read returns it precisely so this
 *     can be explained rather than left as a card that vanished.
 *   * SUPERSEDED — the row is gone AND a proposal still pending names it as the one it displaced,
 *     and the read names no answer to it. Read off the supersession link rather than off
 *     timestamps, for the same reason the server does: two proposals can share a moment.
 *   * ALREADY_SETTLED — the row is gone and somebody answered it, at another end, and the door would
 *     now refuse this card with its own code. `settled` is that answer when the read names it, and
 *     null when it does not (a server older than this bundle, or an answer older than the ones the
 *     read carries) — a card that can then say only that it was answered. The answer is looked for
 *     BEFORE the supersession link: the door takes an answer from a card that had not re-read yet,
 *     so a displaced proposal can still have been answered, and then the answer is what happened.
 *
 * `UNREAD` is the fifth and is not a state of the proposal at all — it is the state of this
 * browser: the read has not come back. A card that cannot re-derive itself must not offer an
 * action, because it has no idea whether that action would succeed.
 */
export type CriteriaDecisionStanding =
  | { state: 'DECIDABLE'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'BASE_SEAL_MOVED'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'SUPERSEDED'; intentId: string; replacement: PendingCriteriaDecisionRow }
  | { state: 'ALREADY_SETTLED'; intentId: string; settled: SettledCriteriaDecision | null }
  | { state: 'UNREAD'; intentId: string };

export function criteriaDecisionStanding(
  queue: PendingCriteriaDecisionQueue | null | undefined,
  intentId: string,
): CriteriaDecisionStanding {
  if (!queue) return { state: 'UNREAD', intentId };
  const row = queue.pending.find((pending) => pending.intentId === intentId) ?? null;
  if (row) {
    return row.decidability.decidable
      ? { state: 'DECIDABLE', intentId, row }
      : { state: 'BASE_SEAL_MOVED', intentId, row };
  }
  const settled = (queue.settled ?? []).find((answer) => answer.intentId === intentId) ?? null;
  if (settled) return { state: 'ALREADY_SETTLED', intentId, settled };
  const replacement =
    queue.pending.find((pending) => pending.supersededIntentId === intentId) ?? null;
  if (replacement) return { state: 'SUPERSEDED', intentId, replacement };
  return { state: 'ALREADY_SETTLED', intentId, settled: null };
}

/** Whether the door would take an answer to this card: true for exactly one of the five. */
export function isAnswerable(standing: CriteriaDecisionStanding): boolean {
  return standing.state === 'DECIDABLE';
}

/**
 * Whether the card is drawn dimmed, whole: exactly the three states whose question has moved on —
 * the ones headed `CRITERIA_DECISION_STALE_HEADING` — which is the account owner's call of
 * 2026-09-11 and iOS's `CriteriaDecisions.isDimmed`. `UNREAD` offers no action either and is still
 * not one of them: it is this browser not knowing, not the proposal being gone, and a card dimmed
 * on a failed read would be showing an answer nobody gave.
 */
export function isStale(standing: CriteriaDecisionStanding): boolean {
  return (
    standing.state === 'BASE_SEAL_MOVED'
    || standing.state === 'SUPERSEDED'
    || standing.state === 'ALREADY_SETTLED'
  );
}

/**
 * Why this card cannot be answered, addressed to the reader looking at its dead buttons.
 *
 * Each sentence names the refusal the door would give, because that is the fact — a reader told
 * only "you cannot" has been told the button is broken, and a reader told which refusal can go and
 * look at what happened.
 */
export function staleExplanation(standing: CriteriaDecisionStanding): string | null {
  switch (standing.state) {
    case 'DECIDABLE':
      return null;
    case 'BASE_SEAL_MOVED': {
      const { row } = standing;
      return (
        `The base seal moved. This proposal was composed against ${shortSeal(row.baselineSeal)} and `
        + `the standard set in force is now ${shortSeal(row.currentSeal)}, so the decision door `
        + `refuses every answer to it with `
        + `${row.decidability.refusal ?? CRITERIA_DECISION_BASE_SEAL_MOVED}. Nothing was applied. `
        + `What clears it is ${row.decidability.requiredAction ?? 'a proposal against the current '
          + 'standard set'} — by the party that proposed it, which is not you.`
      );
    }
    case 'SUPERSEDED':
      return (
        'Superseded. A later proposal against this project replaced this one, and a project holds '
        + 'at most one pending proposal at a time, so what you would be approving here is not what '
        + 'anybody is asking for any more. Nothing was applied. The replacement is the proposal '
        + `now waiting for a decision, composed against ${shortSeal(standing.replacement.baselineSeal)}.`
      );
    case 'ALREADY_SETTLED': {
      // The answer, when the read names one, in the seals the door compared: a refusal moved
      // nothing, and an approval moved the ruler from one seal to another.
      const { settled } = standing;
      if (settled?.decision === 'REJECT') {
        return (
          `Refused at another end. Nothing was applied: the criteria on record stayed as they were, `
          + `and the seal stayed ${shortSeal(settled.baseSeal)}. A decision sent from this card now `
          + `would be refused with ${CRITERIA_DECISION_ALREADY_SETTLED}.`
        );
      }
      if (settled?.decision === 'APPROVE') {
        return (
          `Approved at another end. The weakening was applied: the ruler moved, and the seal went `
          + `from ${shortSeal(settled.baseSeal)} to ${shortSeal(settled.resultingSeal)}. A decision `
          + `sent from this card now would be refused with ${CRITERIA_DECISION_ALREADY_SETTLED}.`
        );
      }
      return (
        'Already answered. This proposal is no longer one of the project’s pending ones — the '
        + 'answer was recorded at another end, and a decision sent from this card now would be '
        + `refused with ${CRITERIA_DECISION_ALREADY_SETTLED}. Nothing on this card was applied by `
        + 'you, and nothing here can change what was.'
      );
    }
    case 'UNREAD':
      return (
        'This card could not be re-read just now, so what it is asking about cannot be shown. It '
        + 'holds no copy of the proposal: everything on it is derived on each render, and an '
        + 'action nobody can say the door would accept is not offered. The proposal itself is '
        + 'untouched by this.'
      );
  }
}

/**
 * The card's heading, which says which of three things the reader is looking at: a question, a
 * question somebody else has already settled — with the answer they gave, when the read names it —
 * or a card this browser could not re-derive.
 */
export function headingFor(standing: CriteriaDecisionStanding): string {
  if (standing.state === 'DECIDABLE') return CRITERIA_DECISION_HEADING;
  if (standing.state === 'UNREAD') return CRITERIA_DECISION_UNREAD_HEADING;
  if (standing.state === 'ALREADY_SETTLED' && standing.settled) {
    return standing.settled.decision === 'APPROVE'
      ? CRITERIA_DECISION_APPROVED_HEADING
      : CRITERIA_DECISION_REFUSED_HEADING;
  }
  return CRITERIA_DECISION_STALE_HEADING;
}

/**
 * The runs one rewritten field is drawn from: the server's cut, or the whole of both versions.
 *
 * The fallback is not for a server that failed to cut — it is for one that is OLDER than this
 * client, which is a shape that exists because iOS ships on its own release train and a browser
 * bundle does not. An entry that says a field moved and carries no cut of it still has both
 * versions on it, so it is drawn as one struck-through run and one added run: the same shape, at
 * the coarsest possible resolution, rather than a blank row or a second layout to maintain.
 */
export function rewriteRuns(
  entry: CriteriaProposalChangeEntry,
  field: CriteriaProposalField,
): CriterionSegment[] {
  const cut = (entry.rewrites ?? []).find((each) => each.field === field);
  if (cut && cut.segments.length > 0) return cut.segments;
  const dropped = entry.onRecord?.[field] ?? '';
  const added = entry.proposed?.[field] ?? '';
  return [
    ...(dropped === '' ? [] : [{ side: 'REMOVED' as const, text: dropped }]),
    ...(added === '' ? [] : [{ side: 'ADDED' as const, text: added }]),
  ];
}

/**
 * One rewritten field as ONE line: what survived, with what it dropped struck through in place and
 * what it gained marked beside it.
 *
 * `<del>` and `<ins>` rather than two styled spans, because that is what they mean — the elements
 * exist for exactly this and carry it to a screen reader, which a class name does not.
 */
function RewrittenWords({ runs }: { runs: CriterionSegment[] }): JSX.Element {
  return (
    <>
      {runs.map((run, index) => {
        if (run.side === 'REMOVED') {
          return (
            <del key={index} className="criteria-decision-cut" title={DROPPED_RUN_TITLE}>
              {run.text}
            </del>
          );
        }
        if (run.side === 'ADDED') {
          return (
            <ins key={index} className="criteria-decision-add" title={ADDED_RUN_TITLE}>
              {run.text}
            </ins>
          );
        }
        return <span key={index}>{run.text}</span>;
      })}
    </>
  );
}

/**
 * One row of the diff: what the proposal says — and, where it rewrites words, the two versions
 * merged into one line rather than laid out one after the other.
 *
 * WHY MERGED. Two paragraphs per rewrite is what put 483px of content in a 360px scroll box: three
 * rewrites of ninety-character Chinese cost six long blocks, of which about sixty characters
 * actually differed. Read against each other they also asked the reader to do the comparison the
 * server had already done. One line says the same thing in the space of one.
 *
 * `value` on the `<li>` is the server's ordinal rather than the row's position in this list, which
 * is the whole point of showing three rows out of eight: `1.`, `2.`, `4.` tells a reader WHICH of
 * the criteria moved, and a list that renumbered them `1. 2. 3.` would be inventing a set nobody
 * proposed.
 */
function ChangedCriterion({ entry }: { entry: CriteriaProposalChangeEntry }): JSX.Element {
  const badge = changeLabel(entry.change);
  const words = entry.proposed ?? entry.onRecord;
  const textMoved = entry.change === 'CHANGED' && entry.changed.includes('text');
  const methodMoved = entry.changed.includes('verificationMethod');
  return (
    <li value={entry.ordinal} className="criteria-decision-entry">
      <span className="criteria-decision-text">
        {textMoved
          ? <RewrittenWords runs={rewriteRuns(entry, 'text')} />
          : words?.text ?? ''}
      </span>
      {badge ? <span className="criteria-decision-new">{badge}</span> : null}
      {methodMoved ? (
        <span className="criteria-decision-method">
          {`${METHOD_LABEL}: `}
          <RewrittenWords runs={rewriteRuns(entry, 'verificationMethod')} />
        </span>
      ) : null}
    </li>
  );
}

/**
 * The proposal as a DIFF: the criteria it moves, and a count of the ones it leaves alone.
 *
 * `<details>` and not a piece of state, because there is nothing to remember: a card that is
 * re-derived on every render has no business keeping a second thing across renders, and the
 * element opens and closes without this component knowing about it.
 */
function ProposedChanges({ diff }: { diff: CriteriaProposalDiff }): JSX.Element {
  const moved = movedEntries(diff);
  const unmoved = unmovedEntries(diff);
  return (
    <>
      {moved.length > 0 ? (
        <ol className="criteria-decision-proposed">
          {moved.map((entry, index) => (
            <ChangedCriterion key={entry.definitionId ?? `added-${index}`} entry={entry} />
          ))}
        </ol>
      ) : null}
      {unmoved.length > 0 ? (
        <details className="criteria-decision-unchanged">
          <summary>{unchangedLine(unmoved.length)}</summary>
          <ol className="criteria-decision-proposed criteria-decision-proposed--quiet">
            {unmoved.map((entry, index) => (
              <li value={entry.ordinal} key={entry.definitionId ?? `same-${index}`}>
                <span className="criteria-decision-text">{entry.proposed?.text ?? ''}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

/**
 * The card. Presentational: it takes the standing and issues no request, so a static render can
 * assert what each of the five states puts on screen.
 *
 * The actions are `CardAction`'s, under `CardAction`'s one rule — an action that cannot succeed is
 * `disabled` rather than lit-and-refused — and `Approve & re-seal` is the primary tone, which
 * loses its fill as well as its strength while it is disabled. A stale card is the state that rule
 * was written for: it keeps the live one's layout, dimmed whole (`is-stale`, see `isStale`), and
 * can do none of what the live one can.
 */
export function CriteriaDecisionCard({
  standing,
  busy = false,
  error = null,
  onDecide,
}: {
  standing: CriteriaDecisionStanding;
  busy?: boolean;
  error?: Error | null;
  onDecide: (decision: CriteriaDecision) => void;
}): JSX.Element {
  const answerable = isAnswerable(standing);
  const stale = staleExplanation(standing);
  const row =
    standing.state === 'DECIDABLE' || standing.state === 'BASE_SEAL_MOVED' ? standing.row : null;
  return (
    <div
      className={`approval-card criteria-decision${isStale(standing) ? ' is-stale' : ''}`}
      id={`criteria-decision-${standing.intentId}`}
    >
      <div className="approval-head criteria-decision-head">
        <span className="criteria-decision-heading">{headingFor(standing)}</span>
        {/* The mark, and the reason it exists is in its own title rather than in a footnote
            somebody has to find: this card is the server's, and the agent's turn is not where it
            came from. */}
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>

      <div className="approval-body criteria-decision-body">
        {row ? (
          <>
            <div className="criteria-decision-kv">
              <span className="criteria-decision-k">Base seal</span>
              <span className="criteria-decision-v">
                <code>{shortSeal(row.baselineSeal)}</code>
                {row.baselineSeal === row.currentSeal
                  ? ' · unchanged since this was drafted'
                  : ` · the set in force is now ${shortSeal(row.currentSeal)}`}
              </span>
            </div>
            <div className="criteria-decision-kv">
              <span className="criteria-decision-k">Proposed</span>
              {/* The legend rides on the summary's line rather than taking one of its own. On a
                  card whose whole problem is height, a row spent saying what a strikethrough
                  means is a row not spent on the criteria — and this is the line a reader is
                  already on when they meet the first one. */}
              <span className="criteria-decision-v">
                {changeSummary(row.diff)}
                {hasRewrite(row.diff)
                  ? <span className="criteria-decision-legend">{INLINE_DIFF_LEGEND}</span>
                  : null}
              </span>
            </div>
            <ProposedChanges diff={row.diff} />
            <p className="criteria-decision-hold">{NOTHING_IS_ON_HOLD}</p>
          </>
        ) : standing.state === 'UNREAD' ? null : (
          // Deliberately blank of content: see the file header. A settled or displaced proposal is
          // not published any more, and this card kept no copy of it.
          <p className="criteria-decision-gone">
            {'This card holds the proposal’s address and nothing else — what it was asking about '
              + 'is no longer published by the pending read.'}
          </p>
        )}
      </div>

      {/* Above the dead row, so it reads as the reason the buttons are dead. */}
      {stale ? <p className="approval-stale">{stale}</p> : null}

      {error ? (
        <Alert
          className="criteria-decision-error"
          type="error"
          showIcon
          message="That decision was not recorded"
          description={error.message}
        />
      ) : null}

      <CardActions className="approval-actions criteria-decision-actions">
        <CardActionButton
          tone="primary"
          disabled={busy || !answerable}
          onClick={() => onDecide('APPROVE')}
        >
          {APPROVE_LABEL}
        </CardActionButton>
        <CardActionButton
          tone="secondary"
          disabled={busy || !answerable}
          onClick={() => onDecide('REJECT')}
        >
          {REFUSE_LABEL}
        </CardActionButton>
        {/* The second key, named but never shown: what the reader is being told is that the press
            carries one, which is why an agent quoting this card cannot reproduce it. */}
        <span className="criteria-decision-bound">
          {`intent ${standing.intentId.slice(0, 8)} · ${
            answerable ? 'commit token bound' : 'no key of this card is live'
          }`}
        </span>
      </CardActions>
    </div>
  );
}

/**
 * The request one press makes, as data, so what goes to the door can be asserted without a network.
 *
 * Three bindings and they are not the same kind of thing: `commitToken` says WHAT is being decided
 * (the proposal's own one-time key), the credential `api()` carries says WHO decided, and
 * `baseSeal` says WHEN — the version of the standard set this answer was composed against, which
 * is why the door has a separate refusal for it.
 */
export function criteriaDecisionRequest(
  row: PendingCriteriaDecisionRow,
  decision: CriteriaDecision,
): { path: string; body: { commitToken: string; decision: CriteriaDecision; baseSeal: string } } {
  return {
    path:
      `/projects/${encodeURIComponent(row.projectId)}/acceptance/criteria-decisions/`
      + `${encodeURIComponent(row.intentId)}`,
    body: { commitToken: row.commitToken, decision, baseSeal: row.baselineSeal },
  };
}

/** The write, with the reader's own credential — no agent between the press and the door. */
export function decideCriteriaChange(
  row: PendingCriteriaDecisionRow,
  decision: CriteriaDecision,
): Promise<CriteriaDecisionResult> {
  const request = criteriaDecisionRequest(row, decision);
  return api<CriteriaDecisionResult>(request.path, { method: 'POST', body: request.body });
}

/**
 * WHAT AN ANSWERED PROPOSAL LEAVES IN THE CONVERSATION IT WAS ASKED IN
 * --------------------------------------------------------------------
 * The session that asked for the change is waiting on this answer, and the door sends it there
 * itself. This is the other reader: the conversation the card was delivered to, which keeps the
 * receipt of what its owner did — what was recorded, and where the proposing session was told (a
 * turn on that session, a comment on its task when the session had already ended, or why it could
 * not be told at all).
 *
 * Drawn from the READ, not from the window that pressed (`criteriaDecisionReceiptRows`). Kept in
 * the pressing window it lasted exactly as long as the page did, so a reload took the decision out
 * of the conversation altogether — the account owner's report, 2026-09-16. The clause about the
 * proposing session is the one part only the door's response carries, and it is the part a press in
 * another window or on another device has never had.
 */
export const REPLY_SENT_TO_SESSION = 'sent to the proposing session';
export const REPLY_WRITTEN_ON_TASK = 'the proposing session had ended — written on its task';
export const REPLY_NOT_SENT: Record<CriteriaDecisionReplyUnsent, string> = {
  SESSION_GONE: 'not sent — the proposing session no longer exists',
  SESSION_ENDED_WITHOUT_TASK: 'not sent — the proposing session had ended and ran no task',
  DELIVERY_FAILED: 'not sent — the reply could not be delivered',
};

/** A receipt's clock: hours and minutes, as the evidence receipt says it. */
export function receiptClock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What was recorded, and when: the first half of the receipt line. */
export function criteriaVerdictReceipt(
  settled: { decision: CriteriaDecision; decidedAt: string },
): string {
  const verdict = settled.decision === 'APPROVE' ? 'Approved' : 'Refused';
  return `✓ ${verdict} by you at ${receiptClock(settled.decidedAt)}`;
}

/** Where the proposing session was told, as the second half of the line, or null for nobody. */
function ReplyReceipt({ reply }: { reply: CriteriaDecisionReply | null }): JSX.Element | null {
  if (reply?.channel === 'SESSION') {
    return (
      <>
        {' · '}
        <b>{REPLY_SENT_TO_SESSION}</b>
        {` (${reply.sessionTitle}) at ${receiptClock(reply.sentAt)}`}
      </>
    );
  }
  if (reply?.channel === 'TASK_COMMENT') {
    return (
      <>
        {' · '}
        <b>{REPLY_WRITTEN_ON_TASK}</b>
        {` (${reply.taskTitle}) at ${receiptClock(reply.sentAt)}`}
      </>
    );
  }
  if (reply?.channel === 'NOT_SENT') {
    return <>{` · ${REPLY_NOT_SENT[reply.reason] ?? 'not sent'}`}</>;
  }
  return null;
}

/**
 * WHAT A RECEIPT SAYS THE DECISION WAS ABOUT.
 *
 * The receipt was one line — `Decision recorded`, `✓ Approved by you at 09:15` — and pressing the
 * button was therefore the moment the change became unreadable: the card above it had the diff, and
 * the receipt that replaced it had the outcome. The account owner's words, 2026-09-17: after
 * approving, you can no longer see what the change was.
 *
 * So the receipt carries the proposal's own side of it, folded. `What this approved` leads, because
 * an approval and a refusal publish the SAME material and only the answer says whether any of it
 * took effect — a list of criteria under a refusal, unled, reads as what the project now states.
 */
export const SETTLED_APPROVED_LEAD = 'What this approved';
export const SETTLED_REFUSED_LEAD = 'What this refused';
/** And the tail of that line: how much of the ruler the decision left exactly as it was. */
export const SETTLED_UNCHANGED_ONE = 'criterion unchanged';
export const SETTLED_UNCHANGED_MANY = 'criteria unchanged';

/**
 * THE SENTENCE THAT KEEPS THIS FROM BEING READ AS A DIFF.
 *
 * Nothing stores the words a rewrite replaced: the proposal states what it asks for, and the
 * baseline it names records the set it was composed against as hashes. So the fold can say WHICH
 * criteria moved and what they say now, and cannot say what they said before — and a reader shown
 * one version of a sentence, on a card whose live form shows two, will read it as both unless it
 * is told otherwise. It is one quiet line rather than a warning, because this is a limit of the
 * record and not a fault of the decision.
 */
export const SETTLED_NO_BEFORE_WORDS =
  'This is the proposal’s own wording. The words it replaced were never stored, so what is here is '
  + 'one side of the change and not a before-and-after.';
/** The half a refusal has to say first: these words are on record, and nothing else is. */
export const SETTLED_NOTHING_APPLIED =
  'None of this was applied — the criteria on record stayed exactly as they were.';
/** A dropped criterion's row, which has no words of its own to show. */
export const SETTLED_DROPPED_WORDS_GONE = 'its words are not on record';

/** Which lead the fold carries, which is the whole of how a refusal reads differently. */
export function settledLead(decision: CriteriaDecision): string {
  return decision === 'APPROVE' ? SETTLED_APPROVED_LEAD : SETTLED_REFUSED_LEAD;
}

/** One entry's badge, in the same three words the live card's summary counts them in. */
export function settledChangeWord(change: SettledCriterionChange): string {
  switch (change) {
    case 'REWORDED':
      return CRITERION_REWORDED_WORD;
    case 'ADDED':
      return CRITERION_ADDED_WORD;
    case 'DROPPED':
      return CRITERION_DROPPED_WORD;
  }
}

/**
 * The folded line: which answer this was, what it moved, and how much it left alone.
 *
 * A decision that moved exactly ONE criterion names it — `criterion 5 reworded` — because that is
 * the whole answer and a count of one is a worse way of saying it. Anything more is counted, the
 * way the live card's `changeSummary` counts, and the ordinals are one disclosure away.
 */
export function settledSummary(settled: SettledCriteriaDecision): string {
  const proposal = settled.proposal;
  const lead = settledLead(settled.decision);
  if (!proposal) return lead;
  const only = proposal.changed.length === 1 ? proposal.changed[0] : null;
  const counts: string[] = [];
  if (proposal.rewordedCount > 0) counts.push(`${proposal.rewordedCount} ${CRITERION_REWORDED_WORD}`);
  if (proposal.droppedCount > 0) counts.push(`${proposal.droppedCount} ${CRITERION_DROPPED_WORD}`);
  if (proposal.addedCount > 0) counts.push(`${proposal.addedCount} ${CRITERION_ADDED_WORD}`);
  const moved = only && only.ordinal !== null
    ? `criterion ${only.ordinal} ${settledChangeWord(only.change)}`
    : counts.length === 0 ? CHANGE_SUMMARY_NOTHING_MOVES : counts.join(', ');
  const unchanged = proposal.unchangedCount === 1 ? SETTLED_UNCHANGED_ONE : SETTLED_UNCHANGED_MANY;
  return `${lead} · ${moved} · ${proposal.unchangedCount} ${unchanged}`;
}

/**
 * The proposal a receipt was about, folded away by default.
 *
 * `<details>` and not a piece of state, for the same reason `ProposedChanges` is one: a receipt
 * drawn from the read on every render has no business keeping a second thing across renders, and
 * the element opens and closes without this component knowing about it. Closed by default because
 * the receipt's job is to say the decision was recorded; what it was about is the question a reader
 * asks second.
 *
 * TWO LISTS, AND THE SECOND ONE IS NOT NUMBERED. `value` on an `<li>` is the SERVER's ordinal — the
 * criterion's place in the proposed set — so `2.`, `4.` says which of fourteen moved, exactly as on
 * the live card. A dropped criterion has no place in that set at all, and putting it in the
 * numbered list would hand it the next number going: a position in the very collection it was being
 * taken out of.
 */
function SettledProposal({ settled }: { settled: SettledCriteriaDecision }): JSX.Element | null {
  const proposal = settled.proposal;
  if (!proposal) return null;
  const placed = proposal.changed.filter((entry) => entry.ordinal !== null);
  const dropped = proposal.changed.filter((entry) => entry.ordinal === null);
  return (
    <details className="criteria-decision-unchanged">
      <summary>{settledSummary(settled)}</summary>
      {placed.length > 0 ? (
        <ol className="criteria-decision-proposed">
          {placed.map((entry, index) => (
            <li
              key={entry.definitionId ?? `placed-${index}`}
              value={entry.ordinal ?? undefined}
              className="criteria-decision-entry"
            >
              <span className="criteria-decision-text">{entry.text ?? ''}</span>
              <span className="criteria-decision-new">{settledChangeWord(entry.change)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {dropped.length > 0 ? (
        <ul className="criteria-decision-proposed">
          {dropped.map((entry, index) => (
            <li key={entry.definitionId ?? `dropped-${index}`} className="criteria-decision-entry">
              <span className="criteria-decision-text">{SETTLED_DROPPED_WORDS_GONE}</span>
              <span className="criteria-decision-new">{settledChangeWord(entry.change)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="criteria-decision-hold">
        {settled.decision === 'REJECT' ? `${SETTLED_NOTHING_APPLIED} ` : ''}
        {SETTLED_NO_BEFORE_WORDS}
      </p>
    </details>
  );
}

export function CriteriaDecisionReceipt({
  settled,
  reply = null,
}: {
  /** The answer as the read publishes it: which way, when, and against which two seals. */
  settled: SettledCriteriaDecision;
  /** Where the answer went — known only to the window that pressed. See the note above. */
  reply?: CriteriaDecisionReply | null;
}): JSX.Element {
  return (
    <div
      className="approval-card criteria-decision is-answered"
      id={`criteria-decision-${settled.intentId}`}
    >
      <div className="approval-head criteria-decision-head">
        <span className="criteria-decision-heading">{CRITERIA_DECISION_RECORDED_HEADING}</span>
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <p className="criteria-decision-receipt">
        <span className="criteria-decision-verdict">{criteriaVerdictReceipt(settled)}</span>
        <ReplyReceipt reply={reply} />
      </p>
      {/* In the live card's own body, so the fold sits under the same padding and the same 360px
          cap the diff it is a record of was read in. */}
      {settled.proposal ? (
        <div className="approval-body criteria-decision-body">
          <SettledProposal settled={settled} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The wired cards: one per proposal this window has been shown, each re-derived on every render.
 *
 * WHY THE WINDOW REMEMBERS THE ADDRESS AND NOTHING ELSE
 * ----------------------------------------------------
 * A card is a delivery: it appeared in this conversation because a proposal was filed, and it stays
 * there afterwards the way any delivered thing does. If the cards were built from `pending` alone
 * they would silently VANISH the moment the question was answered in another window — which is
 * indistinguishable, to somebody halfway through reading one, from a render that broke. So the ids
 * seen here are kept, and only the ids: the content, the decidability and the three ways a card
 * goes stale are all conclusions about the read as it stands right now.
 *
 * Reloading the page forgets them, which is correct — a settled question needs no card. What a
 * reload must NOT forget is the ANSWER, and that is not this component's: it is a committed row
 * the read publishes (`settled`), drawn as a receipt in the conversation at the moment it was
 * decided, which is why this component only ever has to say that its card is no longer one of
 * them. Opening another conversation forgets the addresses too: WorkspaceView keys this component
 * by the session, since the view outlives navigation and an address shown in one project's
 * conversation, looked up in another project's read, would be drawn there as a proposal already
 * answered.
 */
export function SessionCriteriaDecisionCard({
  projectId,
  onDecided,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /**
   * The door's response to a press made in this window. The one fact only this window holds is
   * where the answer went; the read carries the rest, and `WorkspaceView` draws the receipt.
   */
  onDecided?: (result: CriteriaDecisionResult) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const [seen, setSeen] = useState<string[]>([]);
  const pending = useQuery({
    ...pendingCriteriaDecisionsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const queue = pending.data ?? null;
  useEffect(() => {
    if (!queue) return;
    const arrived = queue.pending.map((row) => row.intentId);
    setSeen((previous) => {
      const fresh = arrived.filter((intentId) => !previous.includes(intentId));
      return fresh.length === 0 ? previous : [...previous, ...fresh];
    });
  }, [queue]);

  const answer = useMutation({
    mutationFn: ({ row, decision }: { row: PendingCriteriaDecisionRow; decision: CriteriaDecision }) =>
      decideCriteriaChange(row, decision),
    onSuccess: (result) => {
      // What the door said went where: the receipt this conversation draws is re-derived from the
      // read, and only the window that pressed was handed the reply — so it is handed on before the
      // read comes back and the card gives way to that receipt.
      onDecided?.(result);
      void qc.invalidateQueries({
        queryKey: pendingCriteriaDecisionsQuery(projectId ?? '').queryKey,
      });
    },
  });

  if (!projectId || seen.length === 0) return null;
  // An answer the read publishes is drawn in the transcript as its receipt, where it was decided,
  // so its card goes — the one just pressed included, which would otherwise sit beside that
  // receipt saying the same thing, or go stale into "answered at another end" about its own answer.
  // An answer the read does NOT name (older than the ones it carries, or a server that does not
  // publish them) still has no receipt, and its card stays where it was, dimmed, saying so.
  const receipted = new Set((pending.isError ? [] : queue?.settled ?? []).map((each) => each.intentId));
  return (
    <>
      {seen.filter((intentId) => !receipted.has(intentId)).map((intentId) => {
        const standing = criteriaDecisionStanding(pending.isError ? null : queue, intentId);
        return (
          <CriteriaDecisionCard
            key={intentId}
            standing={standing}
            busy={answer.isPending}
            error={answer.isError ? (answer.error as Error) : null}
            onDecide={(decision) => {
              if (standing.state !== 'DECIDABLE') return;
              answer.mutate({ row: standing.row, decision });
            }}
          />
        );
      })}
    </>
  );
}
