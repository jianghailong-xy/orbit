import { useEffect, useId, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  acceptanceConfirmationQuery,
  confirmAcceptanceCriteria,
  type RecordedStandardSetConfirmation,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, SHORTCUT_HINT, useDecisionCardKeys } from './CardHotkey';
import { PROVENANCE_LABEL, receiptClock, shortSeal } from './CriteriaDecisionCard';
// The words this card's second action uses. Imported rather than re-declared, and read inside the
// component rather than bound at module scope: `OwnerConfirmationCard` reaches this module again
// through `DecisionRail`, and a top-level alias would be evaluated while that binding is still in
// its temporal dead zone depending on which of the three a bundle enters first.
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

/**
 * The settlement question, asked in the conversation it was delivered to, at the moment it can
 * still change something: this is the plan — these N conditions — so shall the project start?
 *
 * WHY IT IS A CARD IN THE COORDINATOR CONVERSATION
 * ------------------------------------------------
 * `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY, and the same press that records the confirmation
 * turns the project on (`project-acceptance.service.ts`: `coordinatorEnabled` is written by no
 * other hand). Its door refuses any request that carries an acting session and takes the browser's
 * own credential, so the answer is pressed here, straight at
 * `POST /projects/:id/acceptance/confirmation`, with no agent between the press and the door. This
 * is the browser's half of what iOS and macOS draw as `AcceptanceConfirmationCard`
 * (`ApprovalCards.swift`), and it carries the provenance mark the other two cards Orbit draws into
 * a conversation carry, for their reason: a transcript is where an agent's words appear.
 *
 * WHY IT ARRIVES BEFORE THE WORK AND NOT AFTER IT
 * -----------------------------------------------
 * `settlementHeldOnConfirmation` used to wait until every criterion was met by its work, and that
 * is the moment the question is worth least: answering "no" then annuls work already done, so the
 * card could only ever be agreed with, and 20 of the 28 projects that reached DONE had gone round
 * it entirely. It is asked now at the one moment the answer is cheap — the plan is written and
 * nothing has run — so `satisfied` no longer enters the condition at all: an OPEN project, a set
 * that is not empty, at least one task filed under it, and a standing nobody has confirmed. The
 * criteria are on the card unfolded, because a digest can prove WHICH version was signed and never
 * that it was read.
 *
 * The sentences are OrbitKit's `AcceptanceConfirmations`, copied by hand, and
 * `AcceptanceConfirmationCopyParityTests.swift` reads them back out of this file: the two clients
 * share no compiler, so a sentence re-worded at one end only turns nothing else red.
 *
 * DELIVERED ONCE, RE-DERIVED ON EVERY RENDER
 * ------------------------------------------
 * The card appears on the first render the condition holds and stays for as long as this
 * conversation is on screen, the way a native delivered card does: started at another end, it goes
 * stale IN PLACE, with the button disabled and the reason above it, rather than vanishing mid-read.
 * Nothing about the set is kept across renders — the standing and the project are read again each
 * time — and a read that failed is not an answer: the card says it could not be re-read and offers
 * nothing to start, which is OrbitKit's rule for a standing it does not have. Editing any criterion
 * ends the confirmation, and the card comes back for the new version on the same condition.
 *
 * WHAT THE ANSWER LEAVES IS NOT THIS WINDOW'S TO KEEP, NOR THIS CARD'S TO HOLD
 * ---------------------------------------------------------------------------
 * A confirmed set leaves a RECEIPT in the conversation (`AcceptanceConfirmationReceipt`), drawn
 * from the door's own read and not from the window that pressed: who signed it, and which seal —
 * the version standing when it was signed, which is not always the version standing now. DRAWN
 * WHERE IT HAPPENED, by `WorkspaceView`'s `decisionReceipts` off the same read this card asks its
 * question from, and not at the tail of the pane by this card: a record is what happened, and the
 * bottom of a conversation is where the questions that are open NOW are drawn. Held here instead,
 * it sat under every later message for the life of the project — including in a conversation
 * started long after, and after the project was done — which is the state this card was moved out
 * of. A press made here gives the card up; a confirmation made at another end leaves the card
 * beside the record, for the rule above. A line this window remembered would have been the one
 * thing the reload took away, which is what happened before this receipt existed.
 *
 * WHAT THE PINNED STRIP IS TOLD
 * -----------------------------
 * Whether this card is on screen and its question is still unanswered (`onOpenQuestion`), which is
 * what iOS's needs-you bar counts. The card reports it rather than the strip reading the standing
 * again, because being on screen is this card's own state: delivered once, and still there —
 * stale — after the set was confirmed at another end.
 */

/** The card's heading: what the card is about, not whether it has been answered
 *  (`AcceptanceConfirmations.title`). */
export const ACCEPTANCE_CONFIRMATION_TITLE = 'When is this project done?';
/** The primary action for the project this card is normally asked about: one that is not running
 *  yet. One press records the confirmation AND starts it, because saying what would settle a
 *  project is what authorises work on it. */
export const ACCEPTANCE_START_LABEL = 'Start the project';
/** …and what the SAME control says when the project is already handing work out. Two different
 *  facts are being answered here, and the verb has to follow the fact: a project already running on
 *  an older version of its plan is not being started by this press, it is being re-confirmed —
 *  saying "start" to it would name an act that is not available and imply a state it is not in
 *  (2026-09-18: seven OPEN projects were handing work out, and the card offered to start every one
 *  of them). Read off `coordinatorEnabled` like the meta line's own field, and off nothing else. */
export const ACCEPTANCE_CONFIRM_LABEL = 'Confirm the criteria';
/** The reading toggle once the criteria are shown whole. */
export const ACCEPTANCE_SHOW_LESS_LABEL = 'Show less';
/** The provenance as the meta line spells it: OrbitKit's `CriteriaDecisions.provenanceLabel`. */
export const ACCEPTANCE_PROVENANCE = 'From Orbit';
export const ACCEPTANCE_PROVENANCE_TITLE =
  'Orbit composed this card from the project’s own reads and authorised its button. Nothing an '
  + 'agent typed can appear here, and confirming here does not go through one.';
/** How a stale standing's first line opens; a confirmation on record adds the seal it named. */
export const CONFIRMATION_CHANGED_SINCE =
  'The criteria changed after they were confirmed, so that confirmation no longer stands.';
export const CONFIRMATION_EDIT_ENDS_IT =
  'Editing any criterion ends this confirmation and Orbit will ask again.';
/** Where the project stands, as the meta line's third field says it: read off `coordinatorEnabled`
 *  — the column that decides whether Orbit hands this project's tasks out, and which
 *  `project-acceptance.service.ts` writes by no other hand — and off nothing else. Confirming turns
 *  it on for a project started since that was wired, and says nothing whatever about one that was
 *  already dispatching work when it landed. */
export const ACCEPTANCE_NOT_STARTED = 'not started';
export const ACCEPTANCE_STARTED = 'started';
/** …and what that field says when the project itself could not be read. A failed read is not an
 *  answer, and guessing "not started" at a project that is handing work out is the one thing this
 *  field was taken off the standing to stop saying. */
export const ACCEPTANCE_START_NOT_READ = 'start not read';
/** Where the CONFIRMATION stands, as the meta line's fourth field says it. The other question
 *  entirely, and the only one the standing answers: whether anybody has said what done means here,
 *  and whether that is still the plan. */
export const ACCEPTANCE_CONFIRMED = 'confirmed';
export const ACCEPTANCE_CHANGED_SINCE_CONFIRMED = 'changed since it was confirmed';
export const ACCEPTANCE_NOBODY_SAID_DONE = 'nobody has said what done means';
/** What the composer's bar says it is about to talk about, ahead of the project's own title. */
export const ACCEPTANCE_PLAN_CHANGE_PREFIX = 'Talking about this plan: ';
/** What the armed composer asks for. A message, not an answer: no door is waiting on it. */
export const ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER = 'What should done mean instead?';
export const CONFIRMATION_UNREAD_EXPLANATION =
  'This card could not be re-read just now, so the version it would confirm cannot be named — and '
  + 'a confirmation that names no version is not one. The criteria themselves are untouched by this.';
/** What a press the door did not take says, over the door's own message. */
export const CONFIRMATION_NOT_RECORDED = 'That confirmation was not recorded';
/** What the record of a confirmation is headed: the two words the receipts Orbit already draws into
 *  a conversation use (`CRITERIA_DECISION_RECORDED_HEADING` next door), because it is the same
 *  thing — an answer to a question this conversation asked. */
export const ACCEPTANCE_RECEIPT_HEADING = 'Decision recorded';
/** The receipt's row id, in the spelling the native client gives the same record
 *  (`DeliveredDecisionCard.id`), because both ends point at these by id from elsewhere. */
export const ACCEPTANCE_RECEIPT_ID = 'acceptance-confirmation-receipt';

/**
 * What the next send carries ahead of the typed message: the plan as it stands, named by its seal.
 *
 * The other three armed replies answer a call that is blocking on them, so their door already knows
 * what the reply is about. This one starts an ordinary turn at an idle agent, which knows none of
 * it — so the version being discussed rides with the message rather than being looked up, and the
 * seal is in it so a reply about a set that has since moved can be told apart from one about this
 * one.
 */
export function acceptancePlanChangeContext(plan: {
  projectTitle: string;
  criteriaDigest: string;
  criteria: string[];
}): string {
  const numbered = plan.criteria.map((text, index) => `${index + 1}. ${text}`).join('\n');
  return (
    `About the acceptance criteria of “${plan.projectTitle}” — the ${plan.criteria.length} that `
    + `stand now, at seal ${shortSeal(plan.criteriaDigest)}, which nobody has confirmed and which `
    + `no work has started against:\n\n${numbered}`
  );
}

/** One stated criterion, as much of it as this card reads — the narrow view OrbitKit's
 *  `ProjectCriteriaDocument` takes of the same document. `satisfied` is absent when the read
 *  declined to answer, which is not a yes. */
export interface ConfirmationCriterion {
  id: string;
  ordinal: number;
  text: string;
  satisfied?: boolean;
}

/** As much of the project document as this card reads: the stated criteria, the title the meta
 *  line names it by, the status the card's own condition turns on, and whether the project has
 *  been started. */
export interface ConfirmationProjectDocument {
  title?: string;
  status?: string;
  /** Whether Orbit is handing this project's tasks out. `/projects/:id` carries it already —
   *  `withCoordination` spreads the column through in `...rest` — so the meta line's "started"
   *  costs this card no request of its own. Absent from a read that did not say, which is not a
   *  "no": it is the one thing this field must never be read as. */
  coordinatorEnabled?: boolean;
  /** How many tasks this project holds, off the same read's own `_count.tasks` — the total the
   *  project list shows, not a second count of this card's. Absent is read as none, which is where
   *  this field parts company with the one above: `coordinatorEnabled` LABELS the project and has a
   *  third word for a read that did not answer, while this one GATES an action, and a gate nobody
   *  can establish stays shut (`acceptanceConfirmationAnswerable` above, for the same reason). */
  _count?: { tasks?: number };
  acceptanceCriteriaItems?: ConfirmationCriterion[];
}

/** The reading toggle's label. It carries the count because the count is the thing confirmed: a
 *  person is agreeing that THESE N conditions, together, express the goal. */
export function acceptanceReadLabel(count: number): string {
  return `Read all ${count} in full`;
}

/** Which project, how many conditions, whether it has been started, whether anybody has said what
 *  done means, and which version of them — in that order. The seal is last because it answers a
 *  question nobody has until they have read the rest: it names the version a press binds, and
 *  proves nothing about having read it.
 *
 *  TWO FIELDS BECAUSE THEY ARE TWO FACTS
 *  -------------------------------------
 *  One field used to answer both, off the standing alone: unconfirmed was printed "not started".
 *  That holds only for a project created since confirming became the press that starts one — for
 *  the projects that were already here it is simply a different question, and on 2026-09-18 seven
 *  OPEN projects were handing work out with no confirmation ever recorded. The card said "not
 *  started" about every one of them. So `started` is read off the project and `asked` off the
 *  standing, and neither is inferred from the other. */
export function acceptanceConfirmationMeta(
  standing: StandardSetConfirmationStanding | null,
  started: boolean | null,
  projectTitle: string,
): string {
  if (!standing) return `${projectTitle} — the standing could not be read just now.`;
  const count = standing.currentVersion.material.length;
  const stands =
    started === null
      ? ACCEPTANCE_START_NOT_READ
      : started
        ? ACCEPTANCE_STARTED
        : ACCEPTANCE_NOT_STARTED;
  const asked =
    standing.state === 'CONFIRMED'
      ? ACCEPTANCE_CONFIRMED
      : standing.state === 'STALE'
        ? ACCEPTANCE_CHANGED_SINCE_CONFIRMED
        : ACCEPTANCE_NOBODY_SAID_DONE;
  return (
    `${projectTitle} · ${count} criteria · ${stands} · ${asked} · seal ${shortSeal(standing.currentVersion.digest)}`
  );
}

/** The one paragraph the card keeps: what a confirmation binds the project to, and what ends it. It
 *  is never dropped — it is the mechanism, and the reason this card is asked before the work rather
 *  than after it. A stale standing says first why it is being asked a second time.
 *
 *  AND A PROJECT ALREADY RUNNING IS TOLD IT IN ITS OWN TENSE. "Once this starts" is the sentence
 *  for the project this card was written for — the plan is written and nothing has run. Said to one
 *  that is already handing work out it describes a beginning that happened some other day, which is
 *  the same defect as offering it a `Start` button: the card would be narrating a state the reader
 *  is not in. Which of the two it says is `started` — the same fact the meta line's third field and
 *  the action's label are read off, so all three agree by construction. */
export function acceptanceStartExplanation(
  count: number,
  standing: StandardSetConfirmationStanding | null,
  started: boolean | null = false,
): string {
  const again = standing?.state === 'STALE' ? `${CONFIRMATION_CHANGED_SINCE} ` : '';
  if (started === true) {
    return (
      `${again}Once this is confirmed, Orbit derives done from these ${count} and from nothing else. `
      + CONFIRMATION_EDIT_ENDS_IT
    );
  }
  return (
    `${again}Once this starts, Orbit derives done from these ${count} and from nothing else. `
    + CONFIRMATION_EDIT_ENDS_IT
  );
}

/** What the primary action says, for the project the card is actually about: `started`, read off
 *  `coordinatorEnabled`, and never inferred from the standing. A `null` — a project document that
 *  did not answer — keeps the card's own word rather than guessing a tense for a project nobody has
 *  read, which is the rule the meta line's third field is under. */
export function acceptanceActionLabel(started: boolean | null): string {
  return started === true ? ACCEPTANCE_CONFIRM_LABEL : ACCEPTANCE_START_LABEL;
}

/** Whether the confirm button may be pressed. Both un-confirmed states offer it, and it always
 *  sends the version standing NOW; a standing that could not be read offers nothing, because
 *  nobody can say which version a press would confirm. */
export function acceptanceConfirmationAnswerable(
  standing: StandardSetConfirmationStanding | null,
): boolean {
  return standing !== null && standing.state !== 'CONFIRMED';
}

/** Whether this card is still asking something — OrbitKit's `AcceptanceConfirmations.isOpen`, and
 *  what the pinned line counts. The standing is the whole of it, and deliberately: what is open is
 *  the QUESTION, and only a confirmation answers that. Whether the project has been started is the
 *  other fact the meta line carries, and a project already running has this question open all the
 *  same. A standing that could not be read leaves it open, because a failed read is this device's
 *  problem and not an answer. */
export function acceptanceConfirmationStillOpen(
  standing: StandardSetConfirmationStanding | null,
): boolean {
  return standing === null || standing.state !== 'CONFIRMED';
}

/** Why the button is dead, or null while it is live: a reader looking at a disabled action is told
 *  which fact made it so. */
export function acceptanceConfirmationStaleExplanation(
  standing: StandardSetConfirmationStanding | null,
): string | null {
  if (!standing) return CONFIRMATION_UNREAD_EXPLANATION;
  if (standing.state !== 'CONFIRMED' || standing.confirmation === null) return null;
  const seal = shortSeal(standing.confirmation.criteriaDigest);
  return (
    `Already confirmed, at another end, for seal ${seal} — the version standing now. `
    + `There is nothing left to answer here; editing any criterion ends that confirmation `
    + `and Orbit will ask again.`
  );
}

/** What a confirmation records: the count it was given over, and the seal it locked.
 *
 *  Read off the RECORD and never off the version standing now. Those are the same version exactly
 *  while the confirmation counts, and the whole point of the record is what it says when they are
 *  not: after an edit the standing names the new seal, and this line still has to name the one
 *  somebody actually signed. One sentence, whether it is drawn the second the door answers or a
 *  week later on another device (`AcceptanceConfirmationCopyParityTests`). */
export function acceptanceConfirmedLine(confirmation: RecordedStandardSetConfirmation): string {
  const count = confirmation.criteriaMaterial.length;
  const seal = shortSeal(confirmation.criteriaDigest);
  return `You started the project on ${count} criteria at seal ${seal}`;
}

/** Who made it and when, under that line — the stamp the other receipts carry (`by you at 09:15`),
 *  from the same clock. The door this card is pressed at takes the browser's own credential and
 *  refuses any request carrying an acting session, so "by you" is not a guess about who is reading:
 *  an agent is never between the press and the record. */
export function acceptanceReceiptStamp(confirmation: RecordedStandardSetConfirmation): string {
  return `by you at ${receiptClock(confirmation.confirmedAt)}`;
}

/**
 * Whether this project is waiting to be started on a plan nobody has confirmed, read off the
 * confirmation standing and the project document — null for either one that could not be read.
 *
 * Four facts and no fifth: the project is OPEN, it states criteria, it holds at least one task, and
 * the set standing now has not been confirmed. `satisfied` is deliberately absent — waiting for
 * every criterion to be met put the question at the moment it could only be agreed with, which is
 * what this card was moved for. No quiet period is needed either side of a write:
 * `project_update(acceptanceCriteriaItems)` replaces the whole set in one statement
 * (`criteria-pending-decisions.ts`), so a read never catches a plan half-written.
 *
 * THE TASK COUNT IS THE FOURTH BECAUSE "START" IS A VERB THAT NEEDS AN OBJECT. `project_create`
 * returns before the coordinator has filed a single task, and the plan is written at that moment
 * and there is nothing yet to hand out — so the first version of this condition, which asked for
 * OPEN and criteria and nothing else, put a `Start the project` button in front of the agent while
 * it was still deciding how to split the work, and a press on it would have started nothing. The
 * count is `_count.tasks`: everything filed under the project, settled work included, because the
 * question here is whether there is any work at all and which of it may run is the dispatcher's,
 * not this card's.
 */
export function settlementHeldOnConfirmation(
  standing: StandardSetConfirmationStanding | null,
  project: ConfirmationProjectDocument | null,
): boolean {
  if (!acceptanceConfirmationAnswerable(standing)) return false;
  if (project === null || project.status !== 'OPEN') return false;
  if ((project.acceptanceCriteriaItems ?? []).length === 0) return false;
  return (project._count?.tasks ?? 0) > 0;
}

/**
 * The card. Presentational apart from whether its criteria are shown whole: it issues no request,
 * so a render can assert what each standing puts on screen.
 *
 * TWO ACTIONS, AND THE READING TOGGLE IS NEITHER OF THEM
 * -----------------------------------------------------
 * Start, and talk about it first. Both are `CardAction`'s, at its sizes, under its one rule — an
 * action that cannot succeed is `disabled` rather than lit-and-refused — and neither carries a
 * subtitle, which is what once made one of these buttons two lines tall beside a one-line
 * neighbour. The criteria are on the card already, so opening them whole is a reading control and
 * sits with the text it unfolds rather than in the action row; it writes nothing and is never
 * disabled, as on the native card.
 */
export function AcceptanceConfirmationCard({
  standing,
  criteria,
  projectTitle,
  started,
  busy = false,
  error = null,
  keys = false,
  onStart,
  onChatAbout,
}: {
  /** The confirmation standing, or null when it could not be read. */
  standing: StandardSetConfirmationStanding | null;
  /** The stated criteria, or null when the project document could not be read. */
  criteria: ConfirmationCriterion[] | null;
  /** What the meta line calls the project this plan belongs to. */
  projectTitle: string;
  /** Whether the project is handing its tasks out, or null when the project document could not be
   *  read. Not derived from `standing`: that is the whole point of this field. */
  started: boolean | null;
  /** A press from this card is on its way to the door, or the re-read after a refusal is. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** Whether this card holds the keyboard — see `CardHotkey.ts`. A static render never does. */
  keys?: boolean;
  onStart: () => void;
  /** Hands the reply to the bottom composer. The card stays and `onStart` stays live. */
  onChatAbout: () => void;
}): JSX.Element {
  const listId = useId();
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const answerable = acceptanceConfirmationAnswerable(standing);
  // Why the button is dead, when it is. A press made HERE never meets this: the card gives way to
  // its receipt the moment the door records the answer, so the one reading of its own answer this
  // card can be sure is wrong — "confirmed at another end" — is not a state it can be drawn in.
  const stale = acceptanceConfirmationStaleExplanation(standing);
  const items = [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <div className="approval-card settlement-card">
      <div className="approval-head settlement-card-head">
        <span className="settlement-card-heading">{ACCEPTANCE_CONFIRMATION_TITLE}</span>
        <span className="criteria-provenance" title={ACCEPTANCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions settlement-card-body">
        <div className="settlement-card-meta">
          {acceptanceConfirmationMeta(standing, started, projectTitle)}
        </div>
        {stale ? <p className="settlement-card-stale">{stale}</p> : null}
        {/* The set itself, open. Load-bearing rather than decorative: a folded list is an
            invitation to sign what was never opened, and the version digest proves only WHICH
            wording was signed. Each condition is clamped to two lines so N of them stay one
            card; the toggle under them takes the clamp off. */}
        {items.length > 0 ? (
          <>
            <ol
              id={listId}
              className={criteriaOpen ? 'settlement-card-criteria is-open' : 'settlement-card-criteria'}
            >
              {items.map((item) => (
                <li key={item.id} value={item.ordinal}>
                  <span className="settlement-card-criterion">{item.text}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="settlement-card-read"
              aria-expanded={criteriaOpen}
              aria-controls={listId}
              onClick={() => setCriteriaOpen((open) => !open)}
            >
              {criteriaOpen ? ACCEPTANCE_SHOW_LESS_LABEL : acceptanceReadLabel(items.length)}
            </button>
          </>
        ) : null}
        <p className="settlement-card-explains">
          {acceptanceStartExplanation(items.length, standing, started)}
        </p>
        {error ? (
          <Alert
            className="settlement-card-error"
            type="error"
            showIcon
            message={CONFIRMATION_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
      </div>
      <CardActions className="approval-actions settlement-card-actions">
        {/* The verb follows the project: a project this card is about to start, or one that is
            already handing work out and is being re-confirmed (`acceptanceActionLabel`). */}
        <CardActionButton tone="primary" disabled={busy || !answerable} onClick={onStart}>
          {acceptanceActionLabel(started)}
          {/* The key and the button it presses are one fact, so the hint follows THIS button's own
              `disabled` and not the card's: a plan that moved at another end keeps the chord live
              while the primary is dark. */}
          {keys && !(busy || !answerable) && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        {/* The same control, and the same word for it, as the other three cards that hand a
            reply to the composer. Dead only where there is no version to talk about: a standing
            that could not be read names none. */}
        <CardActionButton tone="secondary" disabled={standing === null} onClick={onChatAbout}>
          {OWNER_SEND_BACK_ACTION}
          {keys && standing !== null && <span className="approval-kbd">{SHORTCUT_HINT}</span>}
        </CardActionButton>
      </CardActions>
    </div>
  );
}

/**
 * The record of a confirmation, drawn in the conversation it was made in — the fourth receipt,
 * beside the criteria decision's, the evidence decision's and the owner confirmation's, and for
 * the same reason each of those exists: the question leaves the conversation the moment it is
 * answered, and a window that kept the answer for as long as it remembered the press took the
 * decision out of the conversation the moment the page was reloaded.
 *
 * DRAWN FROM THE READ, NOT FROM THE WINDOW THAT PRESSED. `confirmation` is the newest record
 * `GET /projects/:id/acceptance/confirmation` publishes, so this is here on a device that never saw
 * the card, after a reload, and with the door's clock and seal on it rather than the pressing
 * page's. What it says is what was signed: the count, the seal it locked, who, and when. Nothing
 * on it is pressable — it is a record, and the question it answers is not on it.
 *
 * A STALE SET DRAWS BOTH OF THEM: this, naming the version somebody signed, and the card asking
 * about the version standing now. They are two different facts — what was agreed, and what nobody
 * has agreed to yet — and only the second is a question.
 *
 * WHERE IT IS DRAWN IS THE CALLER'S, AND IT IS NOT THE TAIL. `afterSeq`-anchored into the
 * transcript at the door's own clock (`decisionReceiptAnchor`, `WorkspaceView`'s
 * `decisionReceipts`), like the criteria, evidence and owner receipts beside it, and like this
 * record on the native clients (`AcceptanceConfirmations.receipt` +
 * `ReceiptAnchor.after(items:at:)`) — a moment older than every loaded event is a record about a
 * conversation this one is not — it leads at the HEAD of the window instead, above the first row
 * and above the load-earlier control (`decisionReceiptAnchor`), which is where the native clients
 * draw it too (`ReceiptAnchor.Placement.beforeWindow`).
 */
export function AcceptanceConfirmationReceipt({
  confirmation,
}: {
  /** The newest confirmation on record, as the standing read publishes it. */
  confirmation: RecordedStandardSetConfirmation;
}): JSX.Element {
  return (
    <div className="approval-card settlement-receipt" id={ACCEPTANCE_RECEIPT_ID}>
      <div className="approval-head settlement-card-head">
        <span className="settlement-card-heading">{ACCEPTANCE_RECEIPT_HEADING}</span>
        <span className="criteria-provenance" title={ACCEPTANCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body settlement-receipt-body">
        <p className="settlement-receipt-line">{acceptanceConfirmedLine(confirmation)}</p>
        <p className="settlement-receipt-stamp">{acceptanceReceiptStamp(confirmation)}</p>
      </div>
    </div>
  );
}

/**
 * The wired card for one conversation: at most one, delivered the first time an unstarted project
 * states a plan nobody has confirmed, and re-derived from both reads on every render after that.
 *
 * The standing is read under `acceptanceConfirmationQuery` — the same query the conversation draws
 * the record from — and the project under the project page's own `['project', id]`. A press sends
 * `currentVersion.digest` from the read the card is drawn from; the door refuses a version that
 * moved in between, and the answer to that refusal is to read the set again — so a refusal
 * re-reads, and the card stays busy until that read has landed.
 *
 * One thing puts the card down, and it is the answer: a press the door took takes the question away
 * and the record of it is drawn by the conversation, where it happened. No action does. A third
 * action used to, while the question was asked at the end of a project, where
 * putting it down meant "let me answer once the work settles"; asked before anything has run it
 * would mean waiting for nothing, so the way past this card is to start the project or to say what
 * should change first.
 */
export function SessionAcceptanceConfirmationCard({
  projectId,
  onOpenQuestion,
  onChatAbout,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Told whether this card is on screen and the project is still unstarted each time that
   *  changes, and `false` when the card goes: what the pinned strip points at
   *  (`DecisionRail.tsx`). A stable function. */
  onOpenQuestion?: (open: boolean) => void;
  /** Arms the bottom composer to talk about this plan, given what the next send should carry as
   *  context. Nothing here is a door, and the card stays put. Called from a press only, so unlike
   *  `onOpenQuestion` it need not be stable. */
  onChatAbout?: (plan: {
    projectId: string;
    criteriaDigest: string;
    projectTitle: string;
    criteria: string[];
  }) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const standingRead = useQuery({
    ...acceptanceConfirmationQuery(project),
    enabled: Boolean(projectId),
  });
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () =>
      api<ConfirmationProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // A read that failed is not an answer, whatever an earlier read said.
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const document = documentRead.isError ? null : (documentRead.data ?? null);
  const criteria = document?.acceptanceCriteriaItems ?? null;
  const held = settlementHeldOnConfirmation(standing, document);
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);
  // On screen and still asking: the delivered card iOS's needs-you bar counts while
  // `AcceptanceConfirmations.isOpen`. `shown` is exactly what the render below draws, so the strip
  // is told about the card a reader can reach and not about the reads behind it.
  const shown = delivered || held;
  const openHere = shown && acceptanceConfirmationStillOpen(standing);
  useEffect(() => {
    onOpenQuestion?.(openHere);
  }, [onOpenQuestion, openHere]);
  useEffect(() => () => onOpenQuestion?.(false), [onOpenQuestion]);

  const confirm = useMutation({
    mutationFn: (criteriaDigest: string) => confirmAcceptanceCriteria(project, criteriaDigest),
    // The door returns the standing it just wrote: every surface on this key redraws from that.
    onSuccess: (next) => {
      qc.setQueryData(acceptanceConfirmationKey(project), next);
    },
    // Returned rather than fired off, so the button stays disabled until the read it re-derives
    // from has caught up with the refusal.
    onError: () => qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(project) }),
  });

  // The record of the newest confirmation is NOT drawn here, and what this card keeps of a press
  // is nothing: the record belongs where it happened, which is the conversation's flow rather than
  // a card that exists for as long as a QUESTION does (`AcceptanceConfirmationReceipt`, inserted by
  // `WorkspaceView`'s `decisionReceipts` off this same read). A card that carried it stayed at the
  // bottom of the pane for the life of the project, drawn in a stack reserved for what is true now.
  //
  // A press made HERE gives the card up: the question is answered. A confirmation made at ANOTHER
  // end does not — that card stays where it is, going stale in place, because a reader halfway
  // through it must not watch it vanish while somebody else answers (`shown`).
  const title = document?.title || project;

  // The two presses, named once so that the buttons and the keys make the same one. What each needs
  // is what its own `disabled` says: the primary needs a standing that can be answered and no press
  // in flight, the second needs only a version to talk about — a card whose plan moved at another
  // end keeps that one live, so the chord follows the button rather than the card (`CardHotkey.ts`).
  const start = (): void => {
    if (standing === null || !acceptanceConfirmationAnswerable(standing)) return;
    confirm.mutate(standing.currentVersion.digest);
  };
  const talkAbout = (): void => {
    if (standing === null) return;
    onChatAbout?.({
      projectId: project,
      criteriaDigest: standing.currentVersion.digest,
      projectTitle: title,
      criteria: [...(criteria ?? [])]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((item) => item.text),
    });
  };
  // A press in flight, or one the door has taken, is not a card that can be answered: the two
  // answers are dead together, and the second one leaves by the composer rather than by a press
  // here, which changes where the reason is typed and not whether this card can be answered.
  const asking = shown && !confirm.isSuccess;
  const keys = useDecisionCardKeys({
    confirmEnabled: asking && !confirm.isPending && acceptanceConfirmationAnswerable(standing),
    chatEnabled: asking && standing !== null,
    onConfirm: start,
    onChatAbout: talkAbout,
  });

  if (!shown || confirm.isSuccess) return null;
  return (
    <AcceptanceConfirmationCard
      standing={standing}
      criteria={criteria}
      projectTitle={title}
      // Straight off the project read, absent-or-unread meaning neither yes nor no. A press
      // here will turn it on, and a project that was already on when this card arrived says so.
      started={document?.coordinatorEnabled ?? null}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      keys={keys}
      onStart={start}
      onChatAbout={talkAbout}
    />
  );
}
