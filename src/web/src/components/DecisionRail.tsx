import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Typography } from 'antd';
import { ACCEPTANCE_CONFIRMATION_TITLE } from './AcceptanceConfirmationCard';
import {
  CRITERIA_DECISION_HEADING,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
} from './CriteriaDecisionCard';
import { pendingCriteriaDecisionsQuery, pendingDecisionsQuery } from '../lib/queries';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';

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
 * Not by this file and not by the view that mounts it. A decision is pressed on the evidence card
 * (`EvidenceDecisionCard.tsx`), which posts straight to the decision door and keeps the door's own
 * receipt on itself. A line written into the transcript as well would be a second copy of that
 * receipt, in the record of what the conversation did, about something no turn of the conversation
 * took part in.
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
 * the evidence card Orbit draws into the conversation (`EvidenceDecisionCard.tsx`), and nowhere
 * else. Until 2026-09-10 that card was an `AskUserQuestion` a coordinator turn raised; it is drawn
 * from the same read as these rows now, and no question an agent asks is taken for it. What is kept
 * here is the one thing the card cannot do: stay pinned while the conversation scrolls, and say at
 * a glance how many are waiting. The line is a POINTER. Pressing it takes the reader to a card,
 * which is a navigation and not an answer, and `DecisionRail.test.tsx` asserts over the rendered
 * output that nothing here answers anything — absence, not `disabled`, because a disabled button is
 * still a second door with a lock somebody can take off.
 *
 * A QUESTION IS COUNTED WHERE ITS CARD IS
 * ---------------------------------------
 * A pointer is only worth having if it arrives somewhere. The card is drawn from the same read as
 * these rows and waits on no turn, so what a waiting row can lack is a card in THIS conversation:
 * one is drawn only in the coordinator session of the project the row's task is filed under. An
 * ordinary session draws none, and a coordinator draws none for another project's task or for a
 * task in no project. The caller answers it with the card's own filter over the read it already
 * holds (`evidenceDecisionCardRows` in `EvidenceDecisionCard.tsx`): is there a card for this row
 * on screen.
 *
 * A row without one is not counted here. It used to be listed, as text saying where its card was
 * drawn instead, and every coordinator in the account then led with the same number about other
 * projects' tasks — a count this conversation could clear none of. The row is still open, and the
 * strip of the conversation that draws its card counts it.
 *
 * ONE LINE, AND PRESSING IT IS THE WAY THROUGH
 * --------------------------------------------
 * The line is the signal and pressing it goes to the card: the judgment the iOS Needs-you banner was
 * settled on, one signal and one way through to the thing, never a cascade of badges saying the
 * same fact in four places. A phone had it first (project instruction #8); every screen has it now.
 * It blocks no turn, so it must not look like the approval card, which does.
 *
 * With several questions no list opens under it, and the line does not lead with a bare number
 * either (the owner's calls, 2026-09-12). The cards already are that list, drawn together in the
 * conversation, and a second copy pinned above them was one more thing to read before reaching the
 * one to answer; a count said how many without saying what. So the line names ONE question in its
 * card's own words — the oldest, with weakenings ahead of evidence and the settlement question last —
 * with how long it has waited and where it stands among the rest. Each press goes to the next card
 * and the line names the one it went to, back to the first after the last. Where it went is kept as
 * that card's key rather than as an index, so a card answered in between is simply not there any
 * more, and the line names the first again. The count itself is said to a screen reader.
 *
 * What only a sentence can carry — the resubmission a WAITING ON YOU row asks its submitter for —
 * stays on the wider screens, where it has room, as the one fold left. A phone has no line for it.
 *
 * NOTHING IS SHOWN TO SOMEBODY WHO CANNOT ACT ON IT
 * ------------------------------------------------
 * The line counts questions THIS session may answer and nothing else. The server already scopes its
 * read that way; the filter here is the second half of the same rule rather than a second opinion
 * about it — it reads `independence.independent`, which is the decision door's own answer carried on
 * the row, and it is what keeps the count and the cards a press reaches from ever disagreeing. A
 * number that says DECIDE over a question the reader may not answer is the same broken promise this
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
  /** The project the task is filed under, or null for a task in none. A conversation draws an
   *  evidence card only for its own project's rows (`EvidenceDecisionCard.tsx`). */
  projectId: string | null;
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
   *  On the wire, and not what the strip renders: every number on screen is read off what it
   *  counts, so the two can never come apart. */
  count: number;
  oldestAgeSeconds: number | null;
  pending: PendingDecisionRow[];
  /** Rows waiting on a revision THIS session is the one to file. */
  waitingOnYou?: PendingDecisionRow[];
}

/** The strip's own name, for the reader of a screen reader and for a test asking "is it there". */
export const STRIP_LABEL = 'Open questions';
/** The group this reader is the one to clear, by submitting another revision. */
export const WAITING_ON_YOU_LABEL = 'WAITING ON YOU';

/**
 * Take the reader to the settlement card: the third kind of question the line counts.
 *
 * Whether this project's criteria, together, are what "done" means is the question Orbit draws into
 * the coordinator conversation (`AcceptanceConfirmationCard.tsx`) once it is the last thing the
 * project's DONE waits on. The card stays where it was drawn while the conversation goes on, and
 * nothing pinned said it was there.
 *
 * It is counted while that card is on screen and still a question, which is how iOS's needs-you bar
 * counts it (`openQuestionRowIDs`, `AcceptanceConfirmations.isOpen`) — and the card is what says so.
 * Neither half can be read back off the standing: a delivered card stays when the criteria move, Not
 * yet takes it away, and a set confirmed at another end leaves it on screen but no longer asking. So
 * nothing here decides when that card is drawn; the page passes on what the card reported. The
 * confirmation binds a version of the set and is pressed on the card with that set readable under
 * the button, so a press here scrolls to the card and asks the server nothing.
 *
 * A conversation draws at most one, so its class is the handle. Returns whether it arrived, as
 * `revealDecisionCard` does.
 */
export function revealSettlementCard(scope: ParentNode = document): boolean {
  const card = scope.querySelector<HTMLElement>('.settlement-card');
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  markReached(card);
  return true;
}

/** Take the reader to a held weakening's card, which carries its intent in its id. Returns whether
 *  it arrived, as `revealDecisionCard` does. */
export function revealCriteriaCard(intentId: string, scope: Document = document): boolean {
  const card = scope.getElementById(`criteria-decision-${intentId}`);
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  markReached(card);
  return true;
}

/** How long the mark takes to fade once the card it is on has stopped moving. */
const REACHED_FADE_MS = 1400;
/** Frames the card must hold still after it has moved to count as arrived; frames it may sit
 *  unmoved before that counts as "it was there already"; and the most a press waits for either. */
const REST_FRAMES = 6;
const UNMOVED_FRAMES = 30;
const MAX_REST_WAIT_FRAMES = 300;

/**
 * Mark the card a press took the reader to: a ring held while the conversation scrolls to it, which
 * fades once the card has arrived.
 *
 * The cards are drawn together at the foot of the conversation, so the scroll alone often does not
 * say which one a press meant: the last of them cannot be centred, and the next one is usually on
 * screen already. A mark that began fading at the press was gone by the time a long scroll landed,
 * so it is held until the card stops moving — and a smooth scroll can take several frames to start,
 * so a card that has not moved yet is not taken to have arrived until it has sat still for longer.
 * It is an animation of its own rather than a class, so it touches nothing React renders and starts
 * over cleanly when the same card is reached again.
 */
function markReached(card: HTMLElement): void {
  if (typeof card.animate !== 'function') return;
  const accent = getComputedStyle(card).getPropertyValue('--accent').trim() || '#3b82f6';
  const ring = card.animate(
    [{ boxShadow: `0 0 0 2px ${accent}` }, { boxShadow: '0 0 0 2px transparent' }],
    { duration: REACHED_FADE_MS, easing: 'ease-out' },
  );
  ring.pause();
  let lastTop = card.getBoundingClientRect().top;
  let moved = false;
  let still = 0;
  let frames = 0;
  const waitForRest = () => {
    const top = card.getBoundingClientRect().top;
    // A shift of a pixel or two is the page settling around the card — the line above re-laid out
    // with another question's words — and not the scroll.
    if (Math.abs(top - lastTop) <= 2) {
      still += 1;
    } else {
      moved = true;
      still = 0;
    }
    lastTop = top;
    frames += 1;
    const arrived = still >= (moved ? REST_FRAMES : UNMOVED_FRAMES);
    if (arrived || frames >= MAX_REST_WAIT_FRAMES) ring.play();
    else requestAnimationFrame(waitForRest);
  };
  requestAnimationFrame(waitForRest);
}


/** What the line says: how many questions a press can reach, and how many submissions wait on the
 *  reader's own revision. */
export function needsDecisionCount(rows: number): string {
  return `${rows} needs your decision`;
}
export function waitingOnYouCount(rows: number): string {
  return `${rows} waiting on you`;
}
/** Which of several cards the last press went to, in the order the conversation draws them. */
export function wayPosition(at: number, of: number): string {
  return `${at} of ${of}`;
}
/** What pressing the line does, said as the destination rather than as the act. */
export const GO_TO_CARD_HINT = 'Go to its card';
export const GO_TO_NEXT_CARD_HINT = 'Go to the next card';

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
 * line only counts a row the card's own filter says has a card, and a `false` here means that answer
 * went stale between the render and the press.
 */
export function revealDecisionCard(
  row: Pick<PendingDecisionRow, 'taskId' | 'evidenceRevision'>,
  scope: ParentNode = document,
): boolean {
  const key = decisionRowKey(row);
  const card = scope.querySelector<HTMLElement>(`[data-decision-row="${key}"]`);
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  markReached(card);
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

/** The four facts a row leads with. */
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
 * Whether the line can take the reader to this row's card: both halves of the door's own answer,
 * and then whether the card exists. A row the door would refuse has nowhere to go by construction —
 * no card is ever drawn for one — so this says the same thing twice on purpose: the line counts a
 * row only if it could be answered by this reader on a card that is on screen.
 */
function pointsAtCard(
  row: PendingDecisionRow,
  hasCard: (row: PendingDecisionRow) => boolean,
): boolean {
  return hasCard(row) && row.decidability.decidable && row.independence.independent;
}

/**
 * The rows waiting on this reader's own resubmission: the facts, and the sentence saying what clears
 * them. Not a control. No card is drawn for one of these anywhere, and a control that goes nowhere
 * is worse than none.
 */
function DecisionRows({ group }: { group: PendingDecisionRow[] }) {
  return (
    <ul className="decision-rail-list">
      {group.map((row) => (
        <li className="decision-rail-row" key={row.taskId}>
          <div className="decision-rail-summary decision-rail-inert">
            <RowFacts row={row} />
          </div>
          <div className="decision-rail-why">
            <Typography.Text type="warning">
              {row.decidability.refusal
                ?? 'no decision can be recorded about this evidence'}
            </Typography.Text>
            <div>
              <Typography.Text>{WAITING_ON_YOU_ACTION}</Typography.Text>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The held weakenings a reader at this screen could actually answer: the second kind of question the
 * line counts.
 *
 * A proposal to make this project's ruler LOOSER is answered by the account owner and nobody else.
 * Its card is delivered into the conversation and can be missed — the reader is asleep, the engine
 * abandons the turn, the tab was closed — and none of that writes anything, so the question is
 * still there on the next read. The count comes from the same derived read the card does
 * (`readPendingCriteriaDecisions`), so the two can never disagree about what is pending.
 *
 * A proposal whose base seal has moved is undecidable for everybody: the door refuses every answer
 * to it, and what clears it is the PROPOSER refiling against the ruler in force. Counting it under a
 * line that says DECIDE would be the exact bug this card was fixed for once already — so it is not
 * counted, and the explanation of why lives on its card, where the reader met the question.
 */
export function decidableCriteriaRows(
  criteria: PendingCriteriaDecisionQueue | null | undefined,
): PendingCriteriaDecisionRow[] {
  return (criteria?.pending ?? []).filter((row) => row.decidability.decidable);
}


/** Oldest first: the order the line names questions in, within each kind. */
function oldestFirst<T extends { ageSeconds: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.ageSeconds - a.ageSeconds);
}

/**
 * The strip itself: presentational, pinned, and one line that goes to the cards.
 *
 * It takes the whole payload as a prop and issues no request, so a static render can assert what
 * each state puts on screen — including the states that are about absence. The one thing it keeps
 * is which card the last press went to, so the line can name it and the next press can go on.
 *
 * The line names one question — the oldest, until a press has gone somewhere — and its count is the
 * length of the array of cards a press can reach, and of nothing else: the questions this session
 * may answer on a card in this conversation. One array, so the number cannot promise more than the
 * presses deliver — and a question this reader may not answer, or may answer only in another
 * conversation, is never counted or named.
 */
export function DecisionStrip({
  queue,
  criteria = null,
  confirmation = false,
  open,
  phone = false,
  hasCard = () => false,
  onToggle,
  onReveal = () => {},
  onOpenCriteria,
  onRevealConfirmation = () => {},
}: {
  queue: PendingDecisionQueue;
  /** The held criteria proposals of the project this session coordinates, when it coordinates one.
   *  Null for every ordinary session, which has no ruler of its own to move. */
  criteria?: PendingCriteriaDecisionQueue | null;
  /** Whether this conversation's settlement card is on screen and still a question: the card's own
   *  report, passed on by the page. False wherever no such card is drawn. */
  confirmation?: boolean;
  /** Whether the WAITING ON YOU rows are unfolded: the one fold left, and a deliberate act. */
  open: boolean;
  /** A phone, which has no line for the WAITING ON YOU sentence (ONE LINE, above). */
  phone?: boolean;
  /** Whether this row's decision card is on screen and could still be answered. The default is
   *  the honest one for a caller that does not know: the row is not counted. */
  hasCard?: (row: PendingDecisionRow) => boolean;
  onToggle: (open: boolean) => void;
  onReveal?: (row: PendingDecisionRow) => void;
  /** Where the reader goes to answer a proposal: its card, in the conversation it was sent to. */
  onOpenCriteria?: (row: PendingCriteriaDecisionRow) => void;
  /** Where the reader goes to answer the settlement question: its card. */
  onRevealConfirmation?: () => void;
}) {
  const [at, setAt] = useState<string | null>(null);
  // The door's own answer, carried on the row and read here rather than re-derived: a row this
  // session may not answer is not a question put to this session. Nor is one whose card another
  // conversation draws: that coordinator's strip counts it, and this one could clear none of it.
  const decisions = queue.pending.filter((row) => pointsAtCard(row, hasCard));
  const yours = phone ? [] : (queue.waitingOnYou ?? []);
  // Every card a press can reach, oldest first within each kind, each named in the words its card
  // uses and kept under a key that outlives a re-read of the queue. Weakenings lead: a held one is a
  // question about the ruler everything else is measured with, and deciding evidence against a ruler
  // about to move is the one order of reading that can go wrong. The settlement question has no age
  // to give, and comes last, as its card does.
  const ways: Array<{ key: string; label: string; ageSeconds: number | null; go: () => void }> = [
    ...(onOpenCriteria
      ? oldestFirst(decidableCriteriaRows(criteria)).map((row) => ({
        key: `weakening:${row.intentId}`,
        label: CRITERIA_DECISION_HEADING,
        ageSeconds: row.ageSeconds,
        go: () => onOpenCriteria(row),
      }))
      : []),
    ...oldestFirst(decisions).map((row) => ({
      key: `evidence:${decisionRowKey(row)}`,
      label: row.title,
      ageSeconds: row.ageSeconds,
      go: () => onReveal(row),
    })),
    ...(confirmation
      ? [{ key: 'settlement', label: ACCEPTANCE_CONFIRMATION_TITLE, ageSeconds: null, go: onRevealConfirmation }]
      : []),
  ];
  if (ways.length === 0 && yours.length === 0) return null;
  // Where the last press went, while that card is still one to go to. Until a press has gone
  // anywhere the line names the first, which is where the first press goes.
  const here = ways.findIndex((way) => way.key === at);
  const shown = ways[Math.max(here, 0)];
  const step = () => {
    const way = ways[(here + 1) % ways.length];
    way.go();
    setAt(way.key);
  };

  return (
    <div className="decision-strip" aria-label={STRIP_LABEL}>
      {/* The whole of what the questions get: the one the line is on, how long it has waited, where
          it stands among the rest, and the way to its card — with no control that answers anything.
          The count is said to a screen reader, which cannot glance down at the cards. */}
      {shown === undefined ? null : (
        <button
          className="decision-strip-line"
          type="button"
          aria-label={`${needsDecisionCount(ways.length)}: ${shown.label}`}
          title={here < 0 || ways.length < 2 ? GO_TO_CARD_HINT : GO_TO_NEXT_CARD_HINT}
          onClick={step}
        >
          <span className="decision-strip-dot" aria-hidden="true" />
          <span className="decision-strip-title">{shown.label}</span>
          {shown.ageSeconds === null ? null : (
            <span className="decision-strip-quiet">{formatAge(shown.ageSeconds)}</span>
          )}
          {ways.length < 2 ? null : (
            <>
              <span className="decision-strip-sep" aria-hidden="true">·</span>
              <span className="decision-strip-quiet">
                {wayPosition(Math.max(here, 0) + 1, ways.length)}
              </span>
            </>
          )}
          <span className="decision-strip-caret" aria-hidden="true">↓</span>
        </button>
      )}

      {/* The submissions this session is the one to fix, and the only undecidable rows that reach
          any session at all. No card anywhere to go to, so they get the one fold left and the
          sentence saying what clears them — not greyed, because that sentence is an instruction to
          the reader rather than news about somebody else. */}
      {yours.length === 0 ? null : (
        <button
          className="decision-strip-line"
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(!open)}
        >
          <span className="decision-strip-count decision-strip-quiet">
            {waitingOnYouCount(yours.length)}
          </span>
          <span className="decision-strip-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      )}
      {yours.length === 0 || !open ? null : (
        <div className="decision-strip-body">
          <section className="decision-rail-group decision-rail-mine" aria-label={WAITING_ON_YOU_LABEL}>
            <div className="decision-rail-head">
              <span className="decision-rail-label">{WAITING_ON_YOU_LABEL}</span>
              <span className="decision-rail-count">{`${yours.length} to resubmit`}</span>
            </div>
            <DecisionRows group={yours} />
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * The wired strip: the reads, the line that goes to the cards, and the one fold left.
 *
 * There is no mutation. The only thing this component can do to the server is read from it, which
 * is the whole of what this round was about: `decideEvidence` and the two buttons that called it
 * were deleted rather than disabled, so there is no second decision door left to unlock.
 */
export function SessionDecisionStrip({
  sessionId,
  projectId,
  cards,
  confirmation = false,
  onOpenCriteria,
}: {
  sessionId: string;
  /** The project this session coordinates, when it coordinates one. Its held criteria proposals
   *  are the strip's second kind of question; an ordinary session reads nothing extra. */
  projectId?: string | null;
  /** The rows whose evidence card this conversation draws, by `decisionRowKey`. Computed by the
   *  page, which mounts that card beside this strip, with the card's own filter. */
  cards?: ReadonlySet<string>;
  /** Whether this conversation's settlement card is on screen and still a question, as the card
   *  reported it to the page that mounts both (`SessionAcceptanceConfirmationCard`). */
  confirmation?: boolean;
  onOpenCriteria?: (row: PendingCriteriaDecisionRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
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
      confirmation={confirmation}
      onOpenCriteria={onOpenCriteria}
      open={open}
      phone={phone}
      hasCard={(row) => cards?.has(decisionRowKey(row)) ?? false}
      onToggle={setOpen}
      onReveal={(row) => revealDecisionCard(row)}
      onRevealConfirmation={() => revealSettlementCard()}
    />
  );
}
