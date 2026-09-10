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
 * is left is the address, what happened to it, and two buttons that cannot be pressed.
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

/** The derived read: every proposal of one project that is still a question, oldest first. */
export interface PendingCriteriaDecisionQueue {
  readAt: string;
  projectId: string;
  count: number;
  oldestAgeSeconds: number | null;
  decidableCount: number;
  pending: PendingCriteriaDecisionRow[];
}

/** What the door returns once it has answered one — read back, not recomputed here. */
export interface CriteriaDecisionResult {
  intentId: string;
  decision: CriteriaDecision;
  decidedAt: string;
  baseSeal: string;
  resultingSeal: string;
  /** True for an APPROVE and only an APPROVE: whether any criterion actually moved. */
  applied: boolean;
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
/** The heading a card that can no longer be answered carries instead. */
export const CRITERIA_DECISION_STALE_HEADING = 'This decision is no longer yours to make';
/** And the one for a card that cannot say: this browser has not managed the read. */
export const CRITERIA_DECISION_UNREAD_HEADING = 'This card could not be re-read just now';
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
 *   * SUPERSEDED — the row is gone AND a proposal still pending names it as the one it displaced.
 *     Read off the supersession link rather than off timestamps, for the same reason the server
 *     does: two proposals can share a moment.
 *   * ALREADY_SETTLED — the row is gone and nothing pending claims to have displaced it. Somebody
 *     answered it, at another end, and the door would now refuse this card with its own code.
 *
 * `UNREAD` is the fifth and is not a state of the proposal at all — it is the state of this
 * browser: the read has not come back. A card that cannot re-derive itself must not offer an
 * action, because it has no idea whether that action would succeed.
 */
export type CriteriaDecisionStanding =
  | { state: 'DECIDABLE'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'BASE_SEAL_MOVED'; intentId: string; row: PendingCriteriaDecisionRow }
  | { state: 'SUPERSEDED'; intentId: string; replacement: PendingCriteriaDecisionRow }
  | { state: 'ALREADY_SETTLED'; intentId: string }
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
  const replacement =
    queue.pending.find((pending) => pending.supersededIntentId === intentId) ?? null;
  if (replacement) return { state: 'SUPERSEDED', intentId, replacement };
  return { state: 'ALREADY_SETTLED', intentId };
}

/** Whether the door would take an answer to this card: true for exactly one of the five. */
export function isAnswerable(standing: CriteriaDecisionStanding): boolean {
  return standing.state === 'DECIDABLE';
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
    case 'ALREADY_SETTLED':
      return (
        'Already answered. This proposal is no longer one of the project’s pending ones — the '
        + 'answer was recorded at another end, and a decision sent from this card now would be '
        + `refused with ${CRITERIA_DECISION_ALREADY_SETTLED}. Nothing on this card was applied by `
        + 'you, and nothing here can change what was.'
      );
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
 * question somebody else has already settled, or a card this browser could not re-derive.
 */
export function headingFor(standing: CriteriaDecisionStanding): string {
  if (standing.state === 'DECIDABLE') return CRITERIA_DECISION_HEADING;
  if (standing.state === 'UNREAD') return CRITERIA_DECISION_UNREAD_HEADING;
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
 * was written for: it looks like the live one and can do none of what the live one can.
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
    <div className="approval-card criteria-decision" id={`criteria-decision-${standing.intentId}`}>
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
 * What a decision leaves behind in the transcript: the event, said where it happened.
 *
 * The seals are the whole of the compare-and-set the door performed, in the door's own words, so a
 * reader a week later can tell which version was answered — and, for a refusal, that the version
 * did not move.
 */
export function criteriaApprovedLine(result: CriteriaDecisionResult): string {
  return (
    `You approved the weakening — the ruler moved, seal ${shortSeal(result.baseSeal)} → `
    + `${shortSeal(result.resultingSeal)}`
  );
}

export function criteriaRefusedLine(result: CriteriaDecisionResult): string {
  return (
    `You refused the weakening — nothing was applied, seal stays ${shortSeal(result.baseSeal)}`
  );
}

export function criteriaDecisionLine(result: CriteriaDecisionResult): string {
  return result.decision === 'APPROVE' ? criteriaApprovedLine(result) : criteriaRefusedLine(result);
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
 * Reloading the page forgets them, which is correct — a settled question needs no card.
 */
export function SessionCriteriaDecisionCard({
  projectId,
  onDecided,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  onDecided?: (line: string) => void;
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
      // The card that was answered HERE gives way to the line describing what it did: what is true
      // now is a fact about the criteria, and what happened is an event in this conversation. Left
      // on screen it would go stale into "answered at another end", which is the one reading of
      // its own answer this window can be sure is wrong.
      setSeen((previous) => previous.filter((intentId) => intentId !== result.intentId));
      onDecided?.(criteriaDecisionLine(result));
      void qc.invalidateQueries({
        queryKey: pendingCriteriaDecisionsQuery(projectId ?? '').queryKey,
      });
    },
  });

  if (!projectId || seen.length === 0) return null;
  return (
    <>
      {seen.map((intentId) => {
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
