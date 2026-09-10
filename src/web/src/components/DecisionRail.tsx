import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Typography } from 'antd';
import {
  shortSeal,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
} from './CriteriaDecisionCard';
import { pendingCriteriaDecisionsQuery, pendingDecisionsQuery } from '../lib/queries';

/**
 * What is TRUE right now about this session's open questions, pinned under the header.
 *
 * STATE IS PINNED; WHAT HAPPENED STAYS IN THE TRANSCRIPT
 * ------------------------------------------------------
 * The transcript is a record of what happened. This is not that: it is recomputed from the ledger
 * on every read, and a row leaves it because a decision now exists, not because a frame arrived.
 * Putting it in the vertical flow of the transcript put a thing that changes every turn between
 * two things that never change again, with no boundary of its own — it read as a message nobody
 * sent. So the two kinds of content are separated by kind: what is true now is pinned here and
 * does not scroll, and what HAPPENED scrolls with the conversation it happened in.
 *
 * NOTHING IS WRITTEN INTO THAT RECORD FROM HERE
 * ---------------------------------------------
 * Not by this file and not by the view that mounts it. Answering the card DELIVERS an answer to
 * the engine; it is the engine's `task_evidence_decide` that reaches the door, so a sentence
 * written from the browser at the moment of the click would be this tab asserting a compare-and-set
 * it did not witness — right when the door agreed and a lie when it refused. It would also be a
 * third copy of what the server has already written twice: the answered card, which names the task
 * and the revision and marks the option the person picked, and the call beneath it, which is the
 * only one of the three that can report whether the door agreed at all.
 *
 * ONE DECISION SURFACE, AND THIS IS NOT IT
 * ----------------------------------------
 * This strip used to carry `Confirm completion` and `Send back` and post them itself. That made
 * two surfaces for one fact, neither knowing about the other, and the account paid for it on
 * 2026-09-09: a coordinator recording a judgment came back `EVIDENCE_JUDGMENT_ALREADY_DECIDED`
 * because the same evidence had been answered from the other one first. Whoever got there first
 * won, and the loser found out from an error.
 *
 * So the buttons are gone and no request is written from this file at all — a decision is made on
 * the `AskUserQuestion` card the coordinator session raises, and nowhere else. What is kept is the
 * one thing that surface cannot do: say, at a glance and without a live turn, how many are waiting.
 * The rows are POINTERS. Pressing one takes the reader to the card, which is a navigation and not
 * an answer, and `DecisionRail.test.tsx` asserts over the rendered output that nothing here
 * answers anything — absence, not `disabled`, because a disabled button is still a second door
 * with a lock somebody can take off.
 *
 * A POINTER THAT CANNOT POINT SAYS SO
 * -----------------------------------
 * A pointer is only worth having if it arrives somewhere. There are four ways a waiting row has no
 * card to arrive at — the coordinator session is not running, it is running but has not reached
 * the call yet, the turn that raised the card is over so the card can no longer be answered, and
 * the card was answered seconds ago while this strip is still holding a 20s-old read. The caller
 * collapses all four into one fact it computes from rows it already holds (`answerableDecisionCards`
 * in `ApprovalPanel.tsx`): is there a card for this row, on screen, that could still be answered.
 *
 * A row with one is a control. A row without one is NOT a control: it is text, and it carries the
 * sentence saying what has to happen before there is anywhere to go. Trading a button that worked
 * for a pointer that does nothing when pressed would have been worse than changing nothing.
 *
 * ONE LINE UNTIL ASKED
 * --------------------
 * Collapsed is two numbers and nothing else. This blocks no turn, so it must not look like the
 * approval card, which does; expanding is a deliberate act. The same judgment the iOS Needs-you
 * banner was settled on: one signal and one way through to the thing, never a cascade of badges
 * saying the same fact in four places.
 *
 * NOTHING IS SHOWN TO SOMEBODY WHO CANNOT ACT ON IT
 * ------------------------------------------------
 * `NEEDS YOUR DECISION` lists rows THIS session may answer and nothing else. The server already
 * scopes its read that way; the filter here is the second half of the same rule rather than a
 * second opinion about it — it reads `independence.independent`, which is the decision door's own
 * answer carried on the row, and it is what keeps the count and the list from ever disagreeing.
 * A row a reader may not answer under a heading that says DECIDE is the same broken promise this
 * card was fixed for once already.
 *
 * TWO GROUPS, BECAUSE THE DOOR HAS TWO ANSWERS
 * --------------------------------------------
 * A card that says DECISION REQUIRED and whose primary action is refused every time it is pressed
 * is worse than no card: it teaches the reader that the screen does not know what the server will
 * do. That is what this rail was doing to evidence quoting no live stated criterion — the queue
 * listed it and the decision door refused it, both correctly and neither knowing about the other.
 * The server hands those rows over separately and only to the run that can clear them:
 * `waitingOnYou`, where this session filed the submission, so the sentence about what the next
 * revision must quote is an instruction to the reader rather than news about somebody else. No
 * other session is sent them at all. A greyed group repeating the same stall on every open window
 * was the same broadcast one heading further down — being able to see a stall is not the same as
 * being told one, and the stalled population belongs in the report that exists for it.
 *
 * NOTHING IS DELIVERED HERE
 * -------------------------
 * The rows come from `GET /tasks/evidence-decisions/pending`, which re-derives them from the
 * ledger on every read. That is why this can be a plain query with no local list to reconcile: a
 * question answered in another window is gone from the next read, rather than lingering as a card
 * whose answer arrived on a live-only frame this tab never heard.
 *
 * NOT `Mark complete`. Nothing here writes anything at all — not a status, and since the decision
 * moved to the card, not a decision either.
 */

export interface PendingDecisionCitation {
  kind: string;
  ref: string;
  resolved: boolean;
  reason: string | null;
  /** The cited row in words, when the server has better than the ref: the tool's name and the
   *  command it ran. Null for a citation that did not resolve — nothing was found to describe —
   *  and for the kinds whose ref is already readable. */
  label: string | null;
}

export interface PendingDecisionIndependence {
  independent: boolean;
  disqualification: string | null;
  requiredAction: string | null;
}

/** Whether the decision door would record ANY answer about this row — independent of who asks. */
export interface PendingDecisionDecidability {
  decidable: boolean;
  refusal: string | null;
  requiredAction: string | null;
}

export interface PendingDecisionRow {
  taskId: string;
  title: string;
  criterion: { key: string; text: string } | null;
  evidenceRevision: string;
  ageSeconds: number;
  claim: string;
  gaps: string[];
  citations: PendingDecisionCitation[];
  decidability: PendingDecisionDecidability;
  independence: PendingDecisionIndependence;
}

export interface PendingDecisionQueue {
  decidingSessionId: string;
  /** How many rows this session is asked to decide — `pending` only, never the groups summed.
   *  On the wire, and not what the strip renders: every number on screen is read off the list it
   *  sits above, so the two can never come apart. */
  count: number;
  oldestAgeSeconds: number | null;
  pending: PendingDecisionRow[];
  /** Rows waiting on a revision THIS session is the one to file. */
  waitingOnYou?: PendingDecisionRow[];
}

/** The strip's own name, for the reader of a screen reader and for a test asking "is it there". */
export const STRIP_LABEL = 'Open questions';
/** The group that asks something of this reader. Nothing else goes under it. */
export const NEEDS_DECISION_LABEL = 'NEEDS YOUR DECISION';
/** The group this reader is the one to clear, by submitting another revision. */
export const WAITING_ON_YOU_LABEL = 'WAITING ON YOU';
/**
 * The two option labels the decision ask is raised with.
 *
 * Nothing in this file renders them any more — they are the WIRE vocabulary now, declared here
 * because this is where the row they are about is defined, and read by `ApprovalPanel.tsx` to
 * recognise which `AskUserQuestion` is a completion decision. A rail that rendered either of them
 * would be the second decision surface again.
 */
export const CONFIRM_LABEL = 'Confirm completion';
export const SEND_BACK_LABEL = 'Send back';

/**
 * ── THE SECOND ROW TYPE: A HELD CRITERIA WEAKENING ───────────────────────────────────────────
 *
 * The strip has always listed one kind of question — a completion decision about one task's
 * evidence. This adds the other: a proposal to make this project's ruler LOOSER, which the account
 * owner answers and nobody else can.
 *
 * WHY IT IS A ROW HERE AND NOT A SECOND STRIP
 * -------------------------------------------
 * Because it is the same fact this strip already exists to state: what is open, recomputed from the
 * ledger every read. The proposal's own card is delivered into the conversation and can be missed —
 * the reader is asleep, the engine abandons the turn, the tab was closed — and none of that writes
 * anything, so the question is still there on the next read. That is what this row is: the floor
 * under a card that may never be answered, and it comes from the same derived read the card does
 * (`readPendingCriteriaDecisions`), so the two can never disagree about what is pending.
 *
 * ONLY THE ONES A READER CAN ACTUALLY ANSWER
 * ------------------------------------------
 * A proposal whose base seal has moved is undecidable for everybody: the door refuses every answer
 * to it, and what clears it is the PROPOSER refiling against the ruler in force. Listing it under a
 * heading that says DECIDE would be the exact bug this card was fixed for once already — so it is
 * not listed, and the explanation of why lives on its card, where the reader met the question. The
 * count above the list is read off the list, as every number here is.
 */
export const CRITERIA_ROW_LABEL = 'A weakening of this project’s criteria is waiting for you';
/** The row's second line: what is proposed, against which ruler, and how long it has waited. */
export function criteriaRowDetail(row: PendingCriteriaDecisionRow): string {
  return (
    `${row.proposed.length} criteria proposed · base seal ${shortSeal(row.baselineSeal)} · filed `
    + `${formatAge(row.ageSeconds)} ago`
  );
}
/** The affordance that takes the reader to the card in the conversation. */
export const CRITERIA_ROW_OPEN = 'Open';


/** The two numbers the collapsed line is made of, and the only two it may carry. */
export function needsDecisionCount(rows: number): string {
  return `${rows} needs your decision`;
}
export function waitingOnYouCount(rows: number): string {
  return `${rows} waiting on you`;
}

/**
 * How a row here and a card over there name the same thing.
 *
 * Task AND revision, because a decision is a compare-and-set against one version of the evidence:
 * a card raised about rev 1 is not somewhere to send a reader holding a row that says rev 2, and a
 * key of task alone would send them there anyway. When the two disagree the row simply has no
 * target, which is the conservative direction — it says so instead of pointing at the wrong card.
 */
export function decisionRowKey(row: Pick<PendingDecisionRow, 'taskId' | 'evidenceRevision'>): string {
  return `${row.taskId}@${row.evidenceRevision}`;
}

/** What the pointer offers, said as the destination rather than as the act. */
export const POINTER_HINT = 'Answer in the conversation ↓';

/**
 * What a row says when there is no card to send anybody to.
 *
 * One sentence for all four ways it happens, because the reader does the same thing in every one
 * of them and a screen that guessed which one it was would be wrong some of the time. It names
 * where a decision IS made, so the absence reads as "not here, not yet" rather than as a failure.
 */
export const NO_CARD_NOTE =
  'No question card for this one in the conversation right now. A decision is made on the card '
  + 'the coordinator session raises, so there is nothing to press here until it does.';

/**
 * What has to happen before this row becomes answerable, addressed to the party who can do it.
 *
 * There is one such party and this row is only ever shown to it: nothing the reader can press
 * changes it, because the decision door checks the criterion before it looks at which decision was
 * asked for, so a send-back is refused here exactly as a confirmation is. Saying "send it back"
 * would be a fourth version of the bug this card was fixed for.
 */
export const WAITING_ON_YOU_ACTION =
  'This is your own submission, and you are the one who can clear it: submit another evidence '
  + 'revision quoting the project criterion this work serves. Until you do, no decision can be '
  + 'recorded here — not by this session and not by any other.';

/**
 * Take the reader to the card this row is about.
 *
 * The card publishes `data-decision-row` from `decisionRowKey`, so the handle is a pure function
 * of the row and there is no map between the two to keep in step. Returns whether it arrived: the
 * caller only offers the pointer when `answerableDecisionCards` says there is one, and a `false`
 * here means that answer went stale between the render and the press.
 */
export function revealDecisionCard(
  row: Pick<PendingDecisionRow, 'taskId' | 'evidenceRevision'>,
  scope: ParentNode = document,
): boolean {
  const key = decisionRowKey(row);
  const card = scope.querySelector<HTMLElement>(`[data-decision-row="${key}"]`);
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}

/** Age as a reader reads it. Whole units only: a queue is not a stopwatch. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** The four facts a row leads with, in both of the shapes a row can take. */
function RowFacts({ row }: { row: PendingDecisionRow }) {
  return (
    <>
      <span className="decision-rail-task">{row.title}</span>
      <span className="decision-rail-criterion">
        {row.criterion ? row.criterion.key : 'no stated criterion'}
      </span>
      <span className="decision-rail-rev">{`rev ${row.evidenceRevision}`}</span>
      <span className="decision-rail-age">{formatAge(row.ageSeconds)}</span>
    </>
  );
}

/**
 * One group's rows: a pointer where there is somewhere to point, and a sentence where there is not.
 *
 * Extracted so both groups share one row renderer: a group that grew its own would be a second
 * place for "what a row shows" to drift, and the difference between the groups is which rows are
 * in them, never how a row reads.
 */
function DecisionRows({
  group,
  hasCard,
  onReveal,
}: {
  group: PendingDecisionRow[];
  hasCard: (row: PendingDecisionRow) => boolean;
  onReveal: (row: PendingDecisionRow) => void;
}) {
  return (
    <ul className="decision-rail-list">
      {group.map((row) => {
        // Both halves of the door's own answer, and then whether the card exists. A row the door
        // would refuse has nowhere to go by construction — no ask is ever raised over one — so
        // this says the same thing twice on purpose: the pointer appears only for a row that could
        // be answered by this reader on a card that is on screen.
        const pointable =
          hasCard(row) && row.decidability.decidable && row.independence.independent;
        return (
          <li className="decision-rail-row" key={row.taskId}>
            {pointable ? (
              <button
                className="decision-rail-summary decision-rail-pointer"
                type="button"
                onClick={() => onReveal(row)}
              >
                <RowFacts row={row} />
                <span className="decision-rail-goto">{POINTER_HINT}</span>
              </button>
            ) : (
              <>
                {/* Not a button. There is nowhere to go, and a control that goes nowhere is the
                    thing this round replaced a working button with if it is left pressable. */}
                <div className="decision-rail-summary decision-rail-inert">
                  <RowFacts row={row} />
                </div>
                <div className="decision-rail-why">
                  {row.decidability.decidable ? (
                    <Typography.Text type="secondary">{NO_CARD_NOTE}</Typography.Text>
                  ) : (
                    <>
                      <Typography.Text type="warning">
                        {row.decidability.refusal
                          ?? 'no decision can be recorded about this evidence'}
                      </Typography.Text>
                      <div>
                        <Typography.Text>{WAITING_ON_YOU_ACTION}</Typography.Text>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The held proposals, as rows: what is being asked, and one way through to the card that asks it.
 *
 * The row answers nothing itself. There is one decision surface for a proposal — the card the
 * server delivered into the conversation — and a second set of buttons here would be two faces
 * racing for one answer, which this account has already paid for once. So the row states the fact
 * and opens the card; the ONE RULE is met by having no action that could be refused at all.
 */
function CriteriaDecisionRows({
  rows,
  onOpen,
}: {
  rows: PendingCriteriaDecisionRow[];
  onOpen?: (row: PendingCriteriaDecisionRow) => void;
}) {
  return (
    <ul className="decision-rail-list decision-rail-criteria">
      {rows.map((row) => (
        <li className="decision-rail-row" key={row.intentId}>
          <button
            className="decision-rail-summary decision-rail-criteria-summary"
            type="button"
            onClick={() => onOpen?.(row)}
          >
            <span className="decision-rail-task">{CRITERIA_ROW_LABEL}</span>
            <span className="decision-rail-criterion">{criteriaRowDetail(row)}</span>
            <span className="decision-rail-open">{CRITERIA_ROW_OPEN}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The proposals a reader at this screen could actually answer — see the row type's note above.
 */
export function decidableCriteriaRows(
  criteria: PendingCriteriaDecisionQueue | null | undefined,
): PendingCriteriaDecisionRow[] {
  return (criteria?.pending ?? []).filter((row) => row.decidability.decidable);
}


/**
 * The strip itself: presentational, pinned, and one line until somebody asks for more.
 *
 * It takes the whole payload as a prop and issues no request, so a static render can assert what
 * each state puts on screen — including the states that are about absence.
 *
 * `NEEDS YOUR DECISION` is built from the rows this session may answer and from nothing else, and
 * the count on the collapsed line is the length of that same array. One array, so the number a
 * reader decides to stop on cannot promise more than the list under it delivers — and a row this
 * reader may not answer can never appear under a heading that says it should.
 */
export function DecisionStrip({
  queue,
  criteria = null,
  open,
  hasCard = () => false,
  onToggle,
  onReveal = () => {},
  onOpenCriteria,
}: {
  queue: PendingDecisionQueue;
  /** The held criteria proposals of the project this session coordinates, when it coordinates one.
   *  Null for every ordinary session, which has no ruler of its own to move. */
  criteria?: PendingCriteriaDecisionQueue | null;
  /** Expanded is a deliberate act; the default is the one line. */
  open: boolean;
  /** Whether this row's decision card is on screen and could still be answered. The default is
   *  the honest one for a caller that does not know: no pointer, and the sentence saying why. */
  hasCard?: (row: PendingDecisionRow) => boolean;
  onToggle: (open: boolean) => void;
  onReveal?: (row: PendingDecisionRow) => void;
  /** Where the reader goes to answer a proposal: its card, in the conversation it was sent to. */
  onOpenCriteria?: (row: PendingCriteriaDecisionRow) => void;
}) {
  // The door's own answer, carried on the row and read here rather than re-derived: a row this
  // session may not answer is not a question put to this session.
  const decisions = queue.pending.filter((row) => row.independence.independent);
  // Oldest first is the order the server sends, so the age this group leads with is the first row's
  // rather than the payload's `oldestAgeSeconds`. Same reason the count comes from `decisions`:
  // every number on screen is read off the list under it, so there is no second value to drift.
  const yours = queue.waitingOnYou ?? [];
  const proposals = decidableCriteriaRows(criteria);
  if (decisions.length === 0 && yours.length === 0 && proposals.length === 0) return null;
  // Two lists under one heading, so the age it leads with is the oldest of everything under it.
  const oldest = Math.max(
    ...[...proposals, ...decisions].map((row) => row.ageSeconds),
    0,
  );

  const rowsFor = (group: PendingDecisionRow[]) => (
    <DecisionRows group={group} hasCard={hasCard} onReveal={onReveal} />
  );

  return (
    <div className="decision-strip" aria-label={STRIP_LABEL}>
      {/* The collapsed state, and the whole of it: at most two numbers, on one line, with no
          control that answers anything. It blocks no turn and must not look like the approval card,
          which does. */}
      <button
        className="decision-strip-line"
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        {decisions.length + proposals.length === 0 ? null : (
          <span className="decision-strip-dot" aria-hidden="true" />
        )}
        {decisions.length + proposals.length === 0 ? null : (
          <span className="decision-strip-count">
            {needsDecisionCount(decisions.length + proposals.length)}
          </span>
        )}
        {decisions.length + proposals.length === 0 || yours.length === 0 ? null : (
          <span className="decision-strip-sep" aria-hidden="true">·</span>
        )}
        {yours.length === 0 ? null : (
          <span className="decision-strip-count decision-strip-quiet">
            {waitingOnYouCount(yours.length)}
          </span>
        )}
        <span className="decision-strip-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="decision-strip-body">
          {/* The questions for a decider, and the only group that points anywhere.
              The proposals come first: a held one is a question about the ruler everything under
              it is measured with, and answering an evidence row against a ruler that is about to
              move is the one order of reading this group can get wrong. */}
          {decisions.length + proposals.length === 0 ? null : (
            <section className="decision-rail-group" aria-label={NEEDS_DECISION_LABEL}>
              <div className="decision-rail-head">
                <span className="decision-rail-label">{NEEDS_DECISION_LABEL}</span>
                <span className="decision-rail-oldest">{`oldest ${formatAge(oldest)}`}</span>
              </div>
              {proposals.length === 0 ? null : (
                <CriteriaDecisionRows rows={proposals} onOpen={onOpenCriteria} />
              )}
              {decisions.length === 0 ? null : rowsFor(decisions)}
            </section>
          )}

          {/* The submissions this session is the one to fix, and the only undecidable rows that
              reach any session at all. Not greyed, because the sentence about the next revision is
              an instruction to the reader rather than news about somebody else. */}
          {yours.length === 0 ? null : (
            <section className="decision-rail-group decision-rail-mine" aria-label={WAITING_ON_YOU_LABEL}>
              <div className="decision-rail-head">
                <span className="decision-rail-label">{WAITING_ON_YOU_LABEL}</span>
                <span className="decision-rail-count">{`${yours.length} to resubmit`}</span>
              </div>
              {rowsFor(yours)}
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The wired strip: one query, the fold, and a pointer per row that has somewhere to point.
 *
 * There is no mutation. The only thing this component can do to the server is read from it, which
 * is the whole of what this round was about: `decideEvidence` and the two buttons that called it
 * were deleted rather than disabled, so there is no second decision door left to unlock.
 */
export function SessionDecisionStrip({
  sessionId,
  projectId,
  cards,
  onOpenCriteria,
}: {
  sessionId: string;
  /** The project this session coordinates, when it coordinates one. Its held criteria proposals
   *  are the strip's second row type; an ordinary session reads nothing extra. */
  projectId?: string | null;
  /** The rows whose decision card is on screen and still answerable, by `decisionRowKey`. Computed
   *  by the page, which is the only place that holds both the queue and the live approvals. */
  cards?: ReadonlySet<string>;
  onOpenCriteria?: (row: PendingCriteriaDecisionRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = useQuery({
    ...pendingDecisionsQuery(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: 20_000,
  });
  // The same read the card in the transcript uses, through the same factory, so the floor and the
  // card cannot be looking at two different moments.
  const criteria = useQuery({
    ...pendingCriteriaDecisionsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });

  // A read that failed is not "nothing is waiting". Saying so in one muted line is the smallest
  // thing that keeps a reader from mistaking a broken query for an empty queue; the strip is
  // otherwise silent while the first read is in flight, so it never flashes.
  if (pending.isError) {
    return (
      <div className="decision-strip decision-strip-unread" role="status">
        {`${STRIP_LABEL}: this queue could not be read.`}
      </div>
    );
  }
  if (!pending.data) return null;
  return (
    <DecisionStrip
      queue={pending.data}
      criteria={criteria.data ?? null}
      onOpenCriteria={onOpenCriteria}
      open={open}
      hasCard={(row) => cards?.has(decisionRowKey(row)) ?? false}
      onToggle={setOpen}
      onReveal={(row) => revealDecisionCard(row)}
    />
  );
}
