import { useEffect, useRef, useState, type JSX, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input, Modal } from 'antd';
import type { DoneRequest, ProjectDoneRecord, ProjectOpenItemRow, SessionWaitingKind } from '@orbit/shared';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  confirmAcceptanceCriteria,
  readAcceptanceConfirmation,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import { ENTER_HINT, SHORTCUT_HINT, useApproveHotkey, useCardKeyClaim } from './CardHotkey';
import { PROVENANCE_LABEL, PROVENANCE_TITLE } from './CriteriaDecisionCard';
import {
  DONE_CARD_COORDINATOR_CALL,
  DONE_CARD_SHOW_ALL,
  DONE_CARD_SHOW_LESS,
  DONE_CARD_HEADING,
  DONE_CARD_MISSING,
  DONE_CARD_NOT_YET,
  DONE_CARD_ORBIT_CHECKED,
  DONE_CARD_RECORD,
  DONE_CARD_REOPEN,
  DONE_CARD_RECEIPT,
  DONE_CARD_SEE_ACCEPTED,
  PROJECT_DONE_COPY,
  criterionForGap,
  doneProvenance,
  formatDoneDate,
  formatDoneDateTime,
  landingReasonLabel,
  projectDoneCardTally,
  projectDoneReceiptTally,
  projectWhyNotDoneTally,
  type ProjectDerivedDone,
  type ProjectDoneCounts,
  type ProjectDoneDocument,
} from '../lib/projectDone';

/**
 * WHY this project is not DONE — the projection, rendered.
 *
 * THE QUESTION THIS ASKS, AND THE ONE IT REPLACED
 * -----------------------------------------------
 * `project.status` is not a column somebody writes any more. `project-done-derived.ts` projects it
 * from two committed facts — every stated criterion satisfied AND landed AND counting, under a
 * confirmation naming the set that stands today — and `storeDerivedProjectStatus` stores the answer
 * on three edges (a project write, the standard-set confirmation, every merge receipt). So the
 * question a reader has is never "shall we call this done?", which the server answers by itself,
 * but "it looks finished — what is it waiting for?".
 *
 * Until 2026-09-20 this card asked the first question and offered a press that wrote `status`
 * directly. That press was undone by the next projection, the card's own condition was strictly
 * WEAKER than the one the column is written from (it never looked at `landing` or at the
 * confirmation), and no session ever read as waiting on it, because a card this file draws is not
 * something the server counts (`sessionWaitingKind` counts approvals and pending decisions). The
 * card now reads `derivedDone` off the project document and renders the derivation's own answer.
 *
 * NOTHING HERE RESTATES THE RULE
 * ------------------------------
 * `withheld` is every clause that does not hold, and each criterion carries the clauses IT trips
 * (`DerivedDoneCriterionAnswer.withheld`). This file groups by that field and writes no predicate
 * of its own: a client that decided which criteria have landed would be a second statement of the
 * rule, and the two would drift.
 *
 * TWO PRESSES, AND NEITHER IS "DONE"
 * ----------------------------------
 * `Confirm the criteria` appears only when the set standing today is unconfirmed — the derivation's
 * second input, and the one thing on this card only a person supplies (`POST
 * /projects/:id/acceptance/confirmation`, the same door the start card presses, with the browser's
 * credential and no acting session). Every other clause is work rather than a decision, and the
 * work is not the reader's: `Ask the coordinator to handle it` hands the card's own facts to the
 * conversation that coordinates this project — the conversation this card is drawn in — which is
 * the one place the work can start from.
 *
 * Until 2026-09-25 that second press was `Chat about this`, which put the same facts in the
 * composer and waited for a person to type before anything reached the agent. That is this
 * delivery with a step in front of it, and two labels for one act is a rule a reader has to learn;
 * the composer is still below for anything the card does not carry.
 *
 * THE SETTLED STATE IS DERIVED TOO
 * --------------------------------
 * When the derivation stops withholding, this card says so in place. That state is not a receipt
 * held in memory — it is read back from the same projection, so it survives a reload, another
 * device and another conversation, which the press-shaped receipt it replaced did not.
 */

/** The clauses a project's settlement can be withheld by, as the server names them
 *  (`DerivedDoneWithheld`). Carried whole so a clause this file does not know about is still
 *  reported rather than silently dropped. */
export type SettlementClause =
  | 'NO_CRITERIA_STATED'
  | 'CRITERION_UNSATISFIED'
  | 'CRITERION_UNLANDED'
  | 'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'
  | 'STANDARD_SET_UNCONFIRMED';

export type SettlementLanding = 'LANDED' | 'ON_INTEGRATION_LINE' | 'UNKNOWN';
export type SettlementIndependence = 'INDEPENDENT' | 'AUTHORED_BY_ITS_OWN_EVIDENCE';

/** One session that wrote a criterion AND produced evidence for it. */
export interface SettlementConflict {
  sessionId: string;
  taskId: string;
  taskTitle: string;
}

/** What would make a criterion count again, in the server's own words. */
export interface SettlementRemedy {
  requiredAction: string;
  instruction: string;
}

/** One criterion's answer from the projection, with the clauses it trips. */
export interface SettlementCriterionAnswer {
  definitionId: string;
  satisfied: boolean;
  landing: SettlementLanding;
  independence: SettlementIndependence;
  conflicts: SettlementConflict[];
  remedy: SettlementRemedy | null;
  withheld: SettlementClause[];
  landingReason?: string | null;
}

/** `derivedDone`, as the project document serves it. */
export interface SettlementProjection {
  status: 'OPEN' | 'DONE';
  done: boolean;
  withheld: SettlementClause[];
  criteria: SettlementCriterionAnswer[];
  confirmation: 'UNCONFIRMED' | 'CONFIRMED' | 'STALE';
  counts?: {
    criteria: number;
    met: number;
    landed: number;
    onMain: number;
    byReason: Record<string, number>;
  };
}

/** As much of the project document as this card reads: the words of each criterion, the task tally
 *  it will not interrupt, and the projection that says why the column is what it is. */
export interface SettlementProjectDocument {
  title: string;
  /** Absent from a read that did not say where the project stands, which is not an OPEN one. */
  status?: string;
  acceptanceCriteriaItems?: Array<{ id: string; ordinal: number; text: string }>;
  /** Statuses with no tasks are absent from the server's tally entirely, so an empty object means
   *  "no tasks" rather than "counts unavailable". */
  tasksByStatus?: Record<string, number>;
  /** The projection. Absent from a server that predates it, which draws no card. */
  derivedDone?: SettlementProjection;
  doneBy?: 'OWNER' | 'DERIVED' | null;
  doneAt?: string | null;
  acceptedGaps?: readonly Record<string, unknown>[] | null;
}

/** The card's heading: the question a reader actually has, since the server settles the project
 *  itself and this is the only thing left to explain. */
export const SETTLEMENT_HEADING = 'Why is this project not done?';

/** The rule the card is about to hold up against this project. The count of clauses that do not
 *  hold is appended per render (`settlementExplains`). */
export const SETTLEMENT_RULE =
  'Orbit records a project done by itself — no press, no agent — when every stated criterion is '
  + 'met by work that has landed and counts, under a criteria set you have confirmed.';

/** The one press on this card that is a DECISION. It is the derivation's second input, not a
 *  status write. */
export const SETTLEMENT_CONFIRM_ACTION = 'Confirm the criteria';
/** The card's other press, and the one every withheld clause shares: it hands the card's own facts
 *  to the conversation that coordinates the project — the conversation this card is drawn in. Work
 *  is not a decision, but it is also not the reader's, so it goes where it can be started. */
export const SETTLEMENT_DELEGATE_ACTION = 'Ask the coordinator to handle it';
/** Shown under the actions: what that press does rather than what it says. */
export const SETTLEMENT_DELEGATE_HINT =
  '“Ask the coordinator to handle it” sends the card’s own facts into this conversation — the '
  + 'blocked criteria, what Orbit says each is waiting on, and what would clear them — and the '
  + 'coordinator picks it up from there.';
/** The settled state: the derivation stopped withholding, which is the whole of "done" here. It
 *  is the card's HEADING in that state — the question above it is the state's question, and a card
 *  that has stopped withholding must not go on asking it. */
export const SETTLEMENT_SETTLED_TITLE = 'Orbit recorded this project done.';
export const SETTLEMENT_SETTLED_BODY =
  'Every stated criterion is met by work that has landed and counts, under a criteria set you have '
  + 'confirmed — so nothing here was left to ask.';
export const SETTLEMENT_SETTLED_PROVENANCE =
  'Recorded by the derivation, not by a press. Nothing on this card was pressed, and there is '
  + 'nothing here to press.';
/** The refusal of the one press, when the confirmation door refuses. */
export const SETTLEMENT_NOT_RECORDED = 'The criteria were not confirmed';
export const SETTLEMENT_SHOW_LESS = 'Show less';
/** How many criteria a block lists before folding the rest behind a toggle. */
export const SETTLEMENT_PREVIEW = 3;

/** `N of those do not hold here.`, with the one-clause case reading as a sentence rather than as a
 *  count of one. */
export function settlementExplains(withheld: readonly SettlementClause[]): string {
  const n = withheld.length;
  return `${SETTLEMENT_RULE} ${n === 1 ? 'One of those does not hold here.' : `${n} of those do not hold here.`}`;
}

/** What the meta line says the project is, and the one fact that put this card on screen. */
export function settlementMeta(project: SettlementProjectDocument): string {
  return `${project.title} · every stated criterion has been met by the work filed under it, and `
    + 'Orbit has not recorded it done';
}

/** What the server can say about ONE criterion, in the order the two facts have to be read: what
 *  settled, then whether anything proves it landed. The landing half is never phrased as a finding
 *  about the work — there is no receipt, and that is all it says. */
export function settlementCriterionFacts(criterion: SettlementCriterionAnswer): string {
  const settlement = criterion.satisfied ? 'Settled' : 'Not settled';
  const landing =
    criterion.landing === 'LANDED'
      ? 'Landed'
      : criterion.landing === 'ON_INTEGRATION_LINE'
        ? 'On the integration line'
        : 'No receipt';
  return `${settlement} · ${landing}`;
}

/** The two task statuses that END a task — FAILED is deliberately not one of them, since it is a
 *  run's own report that it stopped short and the work under it is still outstanding. */
const SETTLED_TASK_STATUSES: ReadonlyArray<string> = ['DONE', 'CANCELLED'];

/** How much work is still outstanding under the project, from the tally the document carries. */
function unfinishedTasks(byStatus: Record<string, number>): number {
  return Object.entries(byStatus)
    .filter(([status]) => !SETTLED_TASK_STATUSES.includes(status))
    .reduce((total, [, count]) => total + count, 0);
}

/** The tally under the criteria: the set in numbers, then what is still open under it when there is
 *  anything to say. The second sentence is dropped whole when both of its counts are zero and when
 *  the document carried no tally — a line reading "0 tasks still unsettled, 0 ended FAILED" is a
 *  claim nobody made. */
export function settlementTally(project: SettlementProjectDocument): string {
  const criteria = project.derivedDone?.criteria ?? [];
  const settled = criteria.filter((criterion) => criterion.satisfied).length;
  const noReceipt = criteria.filter((criterion) => criterion.landing === 'UNKNOWN').length;
  const line =
    `${criteria.length} stated criteria · ${settled} settled by the work filed under them · `
    + `${noReceipt} with no merge receipt`;
  if (!project.tasksByStatus) return line;
  const unsettled = unfinishedTasks(project.tasksByStatus);
  const failed = project.tasksByStatus.FAILED ?? 0;
  if (unsettled === 0 && failed === 0) return line;
  return `${line} · ${unsettled} task still unsettled, ${failed} ended FAILED`;
}

/**
 * Whether this project is the one the card is for: it LOOKS finished and the derivation says it is
 * not.
 *
 * The first half is what keeps the card off every unfinished project ("the work is not done yet"
 * is not news, and a card saying it under every project forever is what the condition is shaped to
 * avoid); the second is what makes it a question rather than a status. Both halves come off the
 * same read, and the projection decides the second one — this file decides nothing about DONE.
 */
export function settlementHeldOnProject(
  project: SettlementProjectDocument | null | undefined,
): boolean {
  if (!project || project.status !== 'OPEN') return false;
  const projection = project.derivedDone;
  if (!projection || projection.criteria.length === 0) return false;
  // The unified read model is authoritative for the current card.  Unlike the legacy projection
  // below, it already partitions in-flight work and landing reasons, so the card is useful while
  // work is moving too (the grouped Why-not-done view tells the reader who has it).
  if (projection.counts) return projection.done === false;
  if (!projection.criteria.every((criterion) => criterion.satisfied)) return false;
  // Not while something is running: this is a question about a project that has stopped, and
  // asking it mid-sweep would put it up and take it down again for no reader's benefit.
  if ((project.tasksByStatus?.IN_PROGRESS ?? 0) !== 0) return false;
  return projection.withheld.length > 0;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** What a block is called, per clause. A criterion-side block counts the criteria that trip it. */
export function settlementBlockTitle(clause: SettlementClause, n: number): string {
  switch (clause) {
    case 'NO_CRITERIA_STATED':
      return 'this project states no criteria';
    case 'CRITERION_UNSATISFIED':
      return `${n} ${plural(n, 'criterion has', 'criteria have')} not been met by the work filed `
        + `under ${plural(n, 'it', 'them')}`;
    case 'CRITERION_UNLANDED':
      return `${n} ${plural(n, 'criterion has', 'criteria have')} no merge receipt proving `
        + `${plural(n, 'it', 'they')} landed`;
    case 'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE':
      return n === 1
        ? 'one criterion does not count: the conversation that wrote its wording also produced its '
          + 'evidence'
        : `${n} criteria do not count: the conversations that wrote their wording also produced `
          + 'their evidence';
    case 'STANDARD_SET_UNCONFIRMED':
      return 'the criteria on record have not been confirmed in their current wording';
  }
}

/** Why that clause matters, in the reader's terms rather than the derivation's. */
export function settlementBlockExplanation(clause: SettlementClause): string {
  switch (clause) {
    case 'NO_CRITERIA_STATED':
      return 'A project that states no criteria states no goal, so there is nothing for work to '
        + 'meet and nothing for this projection to settle.';
    case 'CRITERION_UNSATISFIED':
      return 'These are the criteria the work filed under them has not met. The card is here '
        + 'because the rest of the set reads met — this is what the derivation is left waiting on.';
    case 'CRITERION_UNLANDED':
      return 'Settling is decided inside each task’s own worktree, so it says nothing about the '
        + 'default branch. Orbit holds no receipt for these — a merge it never saw leaves none '
        + 'behind, so this is the absence of evidence, not a finding about where the work is.';
    case 'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE':
      return 'Orbit cannot settle against a set shorter than the one you confirmed, so a criterion '
        + 'that does not count is withheld and named rather than dropped from the total.';
    case 'STANDARD_SET_UNCONFIRMED':
      return 'Orbit settles against the set you confirmed. Editing any criterion moves its digest, '
        + 'so a confirmation of the older wording stops counting — with no flag anybody has to '
        + 'clear. Nothing else on this card asks you for anything; this one does.';
  }
}

/** What would clear it. Null for the clause whose clearing IS the press, and for the one whose
 *  clearing is the server's own remedy text, printed per criterion instead. */
export function settlementClearsIt(clause: SettlementClause): string | null {
  switch (clause) {
    case 'NO_CRITERIA_STATED':
      return 'state what this project is for, as criteria the work can be measured against';
    case 'CRITERION_UNSATISFIED':
      return 'finish the work each criterion is measured by, and let it settle in its own session';
    case 'CRITERION_UNLANDED':
      return 'land the branch, or record the merge with merge_receipt where it happened outside '
        + 'Orbit';
    case 'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE':
      // In the server's own words, printed per criterion: `criterionIndependenceRemedy`.
      return null;
    case 'STANDARD_SET_UNCONFIRMED':
      // The press below IS the way through.
      return null;
  }
}

/** The clauses that are about the criteria rather than about the project, and so carry rows. */
export function settlementClauseCriteria(
  projection: SettlementProjection,
  clause: SettlementClause,
): SettlementCriterionAnswer[] {
  return projection.criteria.filter((criterion) => criterion.withheld.includes(clause));
}

/** The reading toggle's label. It carries the count because the count is what the reader is
 *  deciding about: this many rows are folded behind it. */
export function settlementReadLabel(count: number): string {
  return `Show all ${count}`;
}

/**
 * What the next send carries ahead of the typed message: the card's own facts, as the reader is
 * looking at them.
 *
 * "Chat about this" starts an ordinary turn at an idle agent, which knows none of this — so the
 * blocked criteria, the fact beside each and what the server says would clear them ride with the
 * message. Nothing here is a door.
 */
export function projectSettlementContext(project: SettlementProjectDocument): string {
  const projection = project.derivedDone;
  const items = [...(project.acceptanceCriteriaItems ?? [])]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((item) => `${item.ordinal}. ${item.text}`);
  const blocked = (projection?.criteria ?? []).flatMap((criterion) => {
    if (criterion.withheld.length === 0) return [];
    const words = items.find((line) => line.startsWith(`${ordinalOf(project, criterion)}.`));
    return [
      `- ${words ?? criterion.definitionId} — ${settlementCriterionFacts(criterion)}`
      + ` (blocked by ${criterion.withheld.join(', ')})`,
    ];
  });
  const clears = (projection?.withheld ?? [])
    .map((clause) => settlementClearsIt(clause))
    .filter((line): line is string => line !== null);
  return (
    `About “${project.title}” — Orbit has not recorded it done. ${settlementExplains(
      projection?.withheld ?? [],
    )}\n\nBlocked:\n${blocked.join('\n') || '(no criterion is individually blocked)'}\n\nWhat Orbit says would clear it:\n`
    + (clears.map((line) => `- ${line}`).join('\n') || '(see the card)')
  );
}

/** The ordinal a criterion is stated at, for naming it in the reply. */
function ordinalOf(project: SettlementProjectDocument, criterion: SettlementCriterionAnswer): number {
  return project.acceptanceCriteriaItems?.find((item) => item.id === criterion.definitionId)?.ordinal
    ?? 0;
}

/**
 * The card. Presentational apart from which rows are folded: it issues no request, so a render can
 * assert what each state puts on screen.
 *
 * `Confirm the criteria` appears only when the clause it clears is the one withholding settlement: a
 * button that cannot change anything is worse than no button. `Ask the coordinator to handle it`
 * has no such condition — every withheld clause is work, and the conversation this card is drawn in
 * is where the work starts.
 */
export function ProjectSettlementCard({
  ref,
  project,
  standing,
  settled,
  busy = false,
  error = null,
  keys = false,
  onConfirm,
  onDelegate,
  doneRequest,
  requestId,
  onRecordDone,
  onNotYet,
}: {
  /** The card's own element, which is where its keyboard claim says it is drawn (`CardHotkey.ts`). */
  ref?: Ref<HTMLDivElement>;
  /** The project document, with the projection on it. */
  project: SettlementProjectDocument;
  /** The standard-set standing, read only when the confirmation clause is withholding. */
  standing?: StandardSetConfirmationStanding | null;
  /** Whether the derivation has stopped withholding — read back, not remembered. */
  settled?: boolean;
  busy?: boolean;
  error?: Error | null;
  /** Whether this card holds the keyboard — see `CardHotkey.ts`. A static render never does. */
  keys?: boolean;
  onConfirm?: () => void;
  /** The conversation's own way of handing the card's facts to the agent that owns this project. */
  onDelegate?: () => void;
  /** Current owner-facing card props.  Kept optional for the pre-DONE_REQUEST projection card. */
  doneRequest?: DoneRequest | null;
  requestId?: string | null;
  onRecordDone?: () => void;
  onNotYet?: (note: string) => void;
}): JSX.Element {
  settled = settled ?? project.derivedDone?.done === true;
  // Keep this hook before the modern/legacy branch.  A rolling deploy can briefly serve the old
  // projection shape and then the unified one; changing the number of hooks between those reads
  // would make React reject an otherwise harmless refresh.
  const [openClause, setOpenClause] = useState<SettlementClause | null>(null);
  if (project.derivedDone && 'counts' in project.derivedDone) {
    return (
      <ProjectDoneCard
        ref={ref}
        project={project as unknown as ProjectDoneDocument}
        doneRequest={doneRequest}
        requestId={requestId}
        standing={standing}
        busy={busy}
        error={error}
        keys={keys}
        onRecordDone={onRecordDone}
        onNotYet={onNotYet}
        openItemsCount={0}
        runningCount={0}
      />
    );
  }
  const projection = project.derivedDone;
  const withheld = projection?.withheld ?? [];
  const words = new Map((project.acceptanceCriteriaItems ?? []).map((item) => [item.id, item]));
  const offersConfirmation = withheld.includes('STANDARD_SET_UNCONFIRMED');
  const confirmable = standing != null && standing.state !== 'CONFIRMED';

  return (
    <div ref={ref} className="approval-card project-settlement">
      <div className="approval-head project-settlement-head">
        {/* The heading belongs to the STATE: a card whose projection stopped withholding says so
            in its heading instead of asking a question its own body has already answered. */}
        <span className="project-settlement-heading">
          {settled ? SETTLEMENT_SETTLED_TITLE : SETTLEMENT_HEADING}
        </span>
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions project-settlement-body">
        {settled ? (
          <>
            <div className="project-settlement-meta">
              {`${project.title} · every stated criterion is met by work that has landed, under the `
                + 'set you confirmed'}
            </div>
            <p className="project-settlement-settled">{SETTLEMENT_SETTLED_BODY}</p>
            <p className="project-settlement-settled-provenance">{SETTLEMENT_SETTLED_PROVENANCE}</p>
          </>
        ) : (
          <>
            <div className="project-settlement-meta">{settlementMeta(project)}</div>
            <p className="project-settlement-rule">{settlementExplains(withheld)}</p>
            {withheld.map((clause) => {
              const rows = settlementClauseCriteria(project.derivedDone!, clause);
              const folded = rows.length > SETTLEMENT_PREVIEW && openClause !== clause;
              const shown = folded ? rows.slice(0, SETTLEMENT_PREVIEW) : rows;
              const clears = settlementClearsIt(clause);
              return (
                <div className="project-settlement-block" key={clause}>
                  <div className="project-settlement-block-title">
                    <span className="project-settlement-block-count">
                      {clause === 'NO_CRITERIA_STATED' || clause === 'STANDARD_SET_UNCONFIRMED'
                        ? '!'
                        : rows.length}
                    </span>
                    <span>{settlementBlockTitle(clause, rows.length)}</span>
                  </div>
                  {shown.length > 0 ? (
                    <ul className="project-settlement-rows">
                      {shown.map((criterion) => {
                        const item = words.get(criterion.definitionId);
                        return (
                          <li key={criterion.definitionId}>
                            <span className="project-settlement-no">{item?.ordinal ?? 0}</span>
                            <span className="project-settlement-text">
                              {item?.text ?? criterion.definitionId}
                            </span>
                            <span className="project-settlement-facts">
                              {settlementCriterionFacts(criterion)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {folded ? (
                    <button
                      type="button"
                      className="project-settlement-read"
                      onClick={() => setOpenClause(clause)}
                    >
                      {settlementReadLabel(rows.length)}
                    </button>
                  ) : null}
                  {rows.some((criterion) => criterion.conflicts.length > 0) ? (
                    <ul className="project-settlement-conflicts">
                      {rows.flatMap((criterion) => criterion.conflicts.map((conflict) => (
                        <li key={`${criterion.definitionId}:${conflict.sessionId}`}>
                          {`written by a session that also ran “${conflict.taskTitle}”`}
                        </li>
                      )))}
                    </ul>
                  ) : null}
                  <p className="project-settlement-why">{settlementBlockExplanation(clause)}</p>
                  {rows.some((criterion) => criterion.remedy !== null) ? (
                    <p className="project-settlement-clears">
                      <b>What clears it: </b>
                      {rows.find((criterion) => criterion.remedy !== null)?.remedy?.instruction}
                    </p>
                  ) : clears !== null ? (
                    <p className="project-settlement-clears">
                      <b>What clears it: </b>
                      {clears}
                    </p>
                  ) : null}
                </div>
              );
            })}
            <p className="project-settlement-tally">{settlementTally(project)}</p>
          </>
        )}
        {error ? (
          <Alert
            className="project-settlement-error"
            type="error"
            showIcon
            message={SETTLEMENT_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
      </div>
      {settled ? null : (
        <div className="approval-actions project-settlement-actions">
          {offersConfirmation ? (
            <button
              type="button"
              className="card-action card-action--primary"
              disabled={busy || !confirmable}
              onClick={onConfirm}
            >
              {SETTLEMENT_CONFIRM_ACTION}
              {/* Each key follows the button it presses rather than the card: this press may be
                  dark — one in flight, or a set nobody has stood behind — while the other answer is
                  still the way out. */}
              {keys && !busy && confirmable && <span className="approval-kbd">{ENTER_HINT}</span>}
            </button>
          ) : null}
          {/* Wears the slot `Chat about this` wore — the same delivery, one step shorter — so the
              chord it carried comes with it. */}
          <button type="button" className="card-action card-action--secondary" onClick={onDelegate}>
            {SETTLEMENT_DELEGATE_ACTION}
            {keys && <span className="approval-kbd">{SHORTCUT_HINT}</span>}
          </button>
          <span className="project-settlement-hint">{SETTLEMENT_DELEGATE_HINT}</span>
        </div>
      )}
    </div>
  );
}

const CONFIRMATION_CLAUSE = 'STANDARD_SET_UNCONFIRMED';

/**
 * The wired card for one conversation: drawn from the project document, which carries the
 * projection, and re-derived on every render.
 *
 * Delivered once and kept: a reader who has seen why the project is not settling keeps it on
 * screen while the answer is being produced — including the case where the derivation stops
 * withholding, which is the state it goes to rather than vanishing.
 */
export function SessionProjectSettlementCard({
  projectId,
  onDelegate,
  coordinator = true,
  waitingKind = null,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Hands the card's facts to the agent that owns this project, as a turn in this conversation —
   *  the conversation that coordinates it, so the facts are the whole message: they open by naming
   *  the project they are about (`projectSettlementContext`). The card stays put: what it says is
   *  still true. */
  onDelegate?: (talk: { facts: string }) => void;
  /** WorkspaceView supplies the membership role; omitted keeps the legacy standalone behavior. */
  coordinator?: boolean;
  /** The server's owner-decision signal, used to distinguish a requested card from D5's reminder. */
  waitingKind?: SessionWaitingKind | null;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () => api<SettlementProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId) && coordinator,
    refetchInterval: 20_000,
  });
  const openItemsRead = useQuery({
    queryKey: ['project', project, 'open-items'],
    queryFn: () => api<{ doneRequest?: ProjectOpenItemRow | null; needsYou?: ProjectOpenItemRow[]; withCoordinator?: ProjectOpenItemRow[] }>(`/projects/${encodeURIComponent(project)}/open-items`),
    enabled: Boolean(projectId) && coordinator,
    refetchInterval: 20_000,
  });
  // A read that has not answered yet is not an answer: there is nothing to draw the card from, and
  // nothing is drawn.
  const document = documentRead.data ?? null;
  const doneRequestRow = openItemsRead.data?.doneRequest ?? null;
  const doneRequest = doneRequestRow?.doneRequest ?? null;
  const [doneDelivered, setDoneDelivered] = useState(false);
  const [doneReceipt, setDoneReceipt] = useState<ProjectDoneRecord | null>(null);
  const hasDoneSignal = waitingKind === 'RECORD_AS_DONE'
    || (waitingKind === 'DONE_REQUEST' && Boolean(doneRequestRow?.itemId));
  useEffect(() => {
    if (!coordinator) {
      setDoneDelivered(false);
      return;
    }
    if (doneRequestRow?.itemId || hasDoneSignal) {
      setDoneDelivered(true);
    } else if (!doneReceipt) {
      // A request that was answered or superseded must not leave a stale card behind.  Keep the
      // local receipt visible after Record as done, though: it is the acknowledgement the turn
      // promised to leave in place.
      setDoneDelivered(false);
    }
  }, [coordinator, doneRequestRow?.itemId, doneReceipt, hasDoneSignal]);
  const held = settlementHeldOnProject(document);
  const settled = document?.derivedDone?.done === true;
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);
  const shown = delivered || held;

  // The confirmation standing, read only when the card is up AND the clause withholding settlement
  // is the one a person clears — the same key and door the start card uses.
  const needsStanding = (shown && (document?.derivedDone?.withheld.includes(CONFIRMATION_CLAUSE) ?? false))
    || doneDelivered
    || doneRequest !== null
    || hasDoneSignal;
  const standingRead = useQuery({
    queryKey: acceptanceConfirmationKey(project),
    queryFn: () => readAcceptanceConfirmation(project),
    enabled: Boolean(projectId) && needsStanding,
    refetchInterval: needsStanding ? 20_000 : false,
  });
  const confirm = useMutation({
    mutationFn: (criteriaDigest: string) => confirmAcceptanceCriteria(project, criteriaDigest),
    onSuccess: (next) => {
      qc.setQueryData(acceptanceConfirmationKey(project), next);
      // And the projection, which the confirmation just moved: DONE is stored on this edge.
      void qc.invalidateQueries({ queryKey: ['project', project] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const done = useMutation({
    mutationFn: async () => {
      // A request carries the exact criteria seal it was made about.  Answering with that seal
      // lets the owner door reject a stale request atomically; only an unasked owner action uses
      // the current confirmation read.
      const criteriaDigest = doneRequest?.criteriaDigest ?? standingRead.data?.currentVersion.digest;
      if (!criteriaDigest || !document) throw new Error('The criteria version is still loading');
      return api<ProjectDoneRecord>(`/projects/${encodeURIComponent(project)}/done`, {
        method: 'POST',
        body: {
          requestId: doneRequestRow?.itemId ?? null,
          criteriaDigest,
          acceptedGaps: doneRequest?.gaps ?? syntheticDoneGaps(document as ProjectDoneDocument),
        },
      });
    },
    onSuccess: async (next) => {
      setDoneReceipt(next);
      await qc.invalidateQueries({ queryKey: ['project', project] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['project', project, 'open-items'] });
    },
  });
  const decline = useMutation({
    mutationFn: ({ note }: { note: string }) => api(`/projects/${encodeURIComponent(project)}/done-requests/${encodeURIComponent(doneRequestRow?.itemId ?? '')}/decline`, { method: 'POST', body: { note } }),
    onSuccess: async () => {
      setDoneDelivered(false);
      await qc.invalidateQueries({ queryKey: ['project', project, 'open-items'] });
    },
  });
  const reopen = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${encodeURIComponent(project)}`, { method: 'PATCH', body: { status: 'OPEN' } }),
    onSuccess: async () => {
      setDoneReceipt(null);
      await qc.invalidateQueries({ queryKey: ['project', project] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['project', project, 'open-items'] });
    },
  });

  // The two presses, named once so that the buttons and the keys make the same one — the same
  // guards, whether the press came from a finger or the keyboard. Each key follows its own
  // button's liveness, and the two are not dead together: the confirmation is offered only while
  // the set is one nobody has stood behind, and handing the work over never depends on that
  // (`CardHotkey.ts`).
  const standing = standingRead.data ?? null;
  const confirmSet = (): void => {
    if (!standing || standing.confirmed || confirm.isPending) return;
    confirm.mutate(standing.currentVersion.digest);
  };
  const delegate = (): void => {
    if (document === null) return;
    onDelegate?.({ facts: projectSettlementContext(document) });
  };
  const offersConfirmation = document?.derivedDone?.withheld.includes(CONFIRMATION_CLAUSE) ?? false;
  const confirmable = standing != null && standing.state !== 'CONFIRMED';
  const asking = (shown || doneDelivered) && document !== null && !settled;
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useCardKeyClaim(asking, anchor);
  useApproveHotkey(keys && offersConfirmation && confirmable && !confirm.isPending, confirmSet, { requireMod: false, anchor });
  useApproveHotkey(keys, delegate, { anchor });

  // A current server's non-settled projection is the grouped Why-not-done read.  It stays a
  // separate card until a DONE_REQUEST arrives; the owner card below is only for an actual request
  // (or the receipt left by answering one).
  if (!doneDelivered && document !== null && document.derivedDone && 'counts' in document.derivedDone
    && !document.derivedDone.done) {
    return (
      <ProjectWhyNotDoneCard
        project={document as unknown as ProjectDoneDocument}
        openItems={{
          withCoordinator: openItemsRead.data?.withCoordinator,
          doneRequest: doneRequestRow,
        }}
        onReview={() => setDoneDelivered(true)}
        onAskCoordinator={delegate}
      />
    );
  }

  if (doneDelivered && document !== null) {
    const doneProject = document as unknown as ProjectDoneDocument;
    return (
      <ProjectDoneCard
        ref={anchor}
        project={doneProject}
        doneRequest={doneRequest}
        requestId={doneRequestRow?.itemId ?? null}
        standing={standing}
        receipt={doneReceipt}
        keys={keys}
        busy={done.isPending || !(doneRequest?.criteriaDigest ?? standing?.currentVersion.digest)}
        error={done.error ?? decline.error}
        notYetBusy={decline.isPending}
        openItemsCount={(openItemsRead.data?.needsYou?.length ?? 0) + (openItemsRead.data?.withCoordinator?.length ?? 0) + (doneRequestRow ? 1 : 0)}
        runningCount={doneProject.derivedDone?.counts?.byReason?.IN_FLIGHT ?? 0}
        onRecordDone={() => done.mutate()}
        onNotYet={(note) => {
          if (doneRequestRow) decline.mutate({ note });
        }}
        onReopen={() => reopen.mutate()}
      />
    );
  }
  if (!shown || document === null) return null;
  const title = document.title || project;
  return (
    <ProjectSettlementCard
      ref={anchor}
      project={document}
      standing={standing}
      settled={settled}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      keys={keys}
      onConfirm={confirmSet}
      onDelegate={delegate}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Owner-facing DONE_REQUEST card
 * -------------------------------------------------------------------------------------------------
 *
 * This is intentionally kept beside the older projection card above.  A few long-lived clients
 * still receive the pre-DONE_REQUEST projection and the old card remains their safe fallback; a
 * current server sends `open-items.doneRequest` and takes this path.  The new path never computes
 * a count from tasks or rows: every number is read from `project.derivedDone.counts`.
 */

export interface ProjectDoneCardProps {
  ref?: Ref<HTMLDivElement>;
  project: ProjectDoneDocument;
  doneRequest?: DoneRequest | null;
  requestId?: string | null;
  /** The server's acceptance read, used for the criteria digest and confirmation date. */
  standing?: StandardSetConfirmationStanding | null;
  receipt?: ProjectDoneRecord | null;
  busy?: boolean;
  error?: Error | null;
  keys?: boolean;
  notYetBusy?: boolean;
  onRecordDone?: () => void;
  onNotYet?: (note: string) => void;
  onReopen?: () => void;
  /** A page opened without a coordinator request. */
  ownerInitiated?: boolean;
  /** The open-item read is used only for the sentence in the Orbit checked row. */
  openItemsCount?: number;
  runningCount?: number;
}

function doneCriterionText(project: ProjectDoneDocument, key: string): string {
  return criterionForGap(project, key)?.text ?? key;
}

function doneCriterionOrdinal(project: ProjectDoneDocument, key: string): number | null {
  return criterionForGap(project, key)?.ordinal ?? null;
}

function syntheticDoneGaps(project: ProjectDoneDocument): Array<{
  criterionKey: string;
  title: string;
  whyNotProven: string;
  coordinatorChecked?: string;
  evidenceRefs?: string[];
}> {
  const criteria = project.derivedDone?.criteria ?? [];
  return criteria
    // NOTHING_TO_LAND and CODELESS are intentional zero-work outcomes, not gaps to paper over
    // with a merge receipt.  Keep genuine work/receipt gaps in the owner-initiated payload.
    .filter((criterion) => (
      (criterion.landingReason !== null
        && criterion.landingReason !== 'NOTHING_TO_LAND'
        && criterion.landingReason !== 'CODELESS')
      || !criterion.satisfied
    ))
    .map((criterion) => {
      const item = project.acceptanceCriteriaItems?.find((candidate) => candidate.id === criterion.definitionId);
      const reason = landingReasonLabel(criterion.landingReason);
      return {
        criterionKey: item?.key ?? item?.id ?? criterion.definitionId,
        title: item?.text ?? criterion.definitionId,
        whyNotProven: criterion.satisfied
          ? `Orbit cannot prove this criterion is on main: ${reason}.`
          : 'Orbit cannot prove this criterion is met by its work yet.',
      };
    });
}

function orbitCheckedText(
  project: ProjectDoneDocument,
  standing: StandardSetConfirmationStanding | null | undefined,
  openItemsCount: number,
  runningCount: number,
): string {
  const counts = project.derivedDone?.counts;
  const allMet = counts != null && counts.met === counts.criteria;
  const lead = allMet
    ? 'every criterion is met by its work'
    : `${counts?.met ?? 0} of ${counts?.criteria ?? 0} criteria are met by their work`;
  const running = runningCount === 0 ? 'nothing running' : `${runningCount} item${runningCount === 1 ? '' : 's'} running`;
  const open = openItemsCount === 0 ? 'no open items' : `${openItemsCount} open item${openItemsCount === 1 ? '' : 's'}`;
  const confirmedAt = formatDoneDate(standing?.confirmation?.confirmedAt);
  return `${DONE_CARD_ORBIT_CHECKED}: ${lead} · ${running} · ${open}`
    + (confirmedAt ? ` · criteria confirmed by you on ${confirmedAt}` : '');
}

function DoneGaps({
  project,
  gaps,
}: {
  project: ProjectDoneDocument;
  gaps: readonly {
    criterionKey: string;
    title?: string;
    whyNotProven?: string;
    coordinatorChecked?: string;
    evidenceRefs?: string[];
  }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? gaps : gaps.slice(0, 3);
  return (
    <div className="project-done-gaps">
      <div className="project-done-section-title">
        {PROJECT_DONE_COPY.whatOrbitCantProve} · {gaps.length}
      </div>
      {gaps.length === 0 ? (
        <p className="project-done-empty">Orbit has no gaps to report.</p>
      ) : (
        <ul className="project-done-gap-list">
          {shown.map((gap, index) => {
            const ordinal = doneCriterionOrdinal(project, gap.criterionKey);
            return (
              <li className="project-done-gap" key={`${gap.criterionKey}:${index}`}>
                <span className="project-done-gap-number">{ordinal ?? index + 1}</span>
                <div className="project-done-gap-body">
                  <div className="project-done-gap-title">{gap.title ?? doneCriterionText(project, gap.criterionKey)}</div>
                  {gap.whyNotProven ? <div className="project-done-gap-why">{gap.whyNotProven}</div> : null}
                  {gap.coordinatorChecked ? (
                    <div className="project-done-gap-checked">
                      <b>✓ {PROJECT_DONE_COPY.coordinatorChecked}:</b>{' '}
                      {gap.coordinatorChecked}
                      {gap.evidenceRefs?.length ? ` · evidence ${gap.evidenceRefs.join(', ')}` : ''}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!expanded && gaps.length > shown.length ? (
        <button type="button" className="project-done-show-all" onClick={() => setExpanded(true)}>
          {DONE_CARD_SHOW_ALL} {gaps.length}
        </button>
      ) : null}
    </div>
  );
}

function DoneWhenSummary({
  project,
  counts,
}: {
  project: ProjectDoneDocument;
  counts: ProjectDoneCounts | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const criteria = project.derivedDone?.criteria ?? [];
  const criteriaCount = counts?.criteria ?? criteria.length;
  const labels = new Map((project.acceptanceCriteriaItems ?? []).map((item) => [item.id, item]));
  return (
    <div className="project-done-when">
      <div className="project-done-section-title">
        {PROJECT_DONE_COPY.doneWhen} · {criteriaCount} criteria
      </div>
      <div className="project-done-tally">{projectDoneCardTally(counts)}</div>
      {criteriaCount > 0 ? (
        <button
          type="button"
          className="project-done-show-all"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? DONE_CARD_SHOW_LESS : `${DONE_CARD_SHOW_ALL} ${criteriaCount}`}
        </button>
      ) : null}
      {expanded ? (
        <ul className="project-done-criteria-list">
          {criteria.map((criterion, index) => {
            const item = labels.get(criterion.definitionId);
            return (
              <li key={criterion.definitionId}>
                <span className="project-done-gap-number">{item?.ordinal ?? index + 1}</span>
                <span>{item?.text ?? criterion.definitionId}</span>
                <span className="project-done-criterion-state">
                  {criterion.satisfied ? 'met' : 'not met'} · {landingReasonLabel(criterion.landingReason)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The shared visual used in the coordinator transcript and in the project-page review modal. */
export function ProjectDoneCard({
  ref,
  project,
  doneRequest = null,
  requestId = null,
  standing = null,
  receipt = null,
  busy = false,
  error = null,
  keys = false,
  notYetBusy = false,
  onRecordDone,
  onNotYet,
  onReopen,
  ownerInitiated = false,
  openItemsCount = 0,
  runningCount = 0,
}: ProjectDoneCardProps): JSX.Element {
  const [notYetOpen, setNotYetOpen] = useState(false);
  const [note, setNote] = useState('');
  const gaps = doneRequest?.gaps ?? syntheticDoneGaps(project);
  const counts = project.derivedDone?.counts;
  const receiptDate = formatDoneDate(receipt?.doneAt ?? project.doneAt);
  const accepted = receipt?.acceptedGaps ?? project.acceptedGaps ?? [];
  const receiptDateTime = formatDoneDateTime(receipt?.doneAt ?? project.doneAt);
  const ownerRecorded = receipt != null || project.doneBy === 'OWNER';
  // A derived DONE is still a durable read-model state, even when this card was reached through
  // a stale OPEN project document during a refresh.  Keep the provenance line honest instead of
  // reopening the question while the server is already saying DONE.
  const recorded = ownerRecorded || project.status === 'DONE' || project.derivedDone?.done === true;
  const canRecord = Boolean(onRecordDone) && !busy;

  if (recorded) {
    return (
      <div ref={ref} className="approval-card project-settlement project-done-card is-receipt">
        <div className="approval-head project-settlement-head">
          <span className="project-settlement-heading">{PROJECT_DONE_COPY.thisProjectIsDone}</span>
          <span className="criteria-provenance">FROM ORBIT</span>
        </div>
        <div className="approval-body is-questions project-settlement-body">
          <div className="project-settlement-meta">
            {project.title} · {doneProvenance({ doneBy: receipt?.doneBy ?? project.doneBy, acceptedGaps: accepted })}
            {receiptDate ? ` · ${receiptDate}` : ''}
          </div>
          <p className="project-done-receipt-line">
            {ownerRecorded
              ? `${DONE_CARD_RECEIPT}${receiptDateTime ? ` · ${receiptDateTime}` : ''}`
              : `${PROJECT_DONE_COPY.thisProjectIsDone} · ${PROJECT_DONE_COPY.recordedByOrbit}`}
          </p>
          <p className="project-done-tally">{projectDoneReceiptTally(counts, accepted.length)}</p>
          {accepted.length > 0 ? (
            <details className="project-done-accepted">
              <summary>{DONE_CARD_SEE_ACCEPTED}</summary>
              <DoneGaps project={project} gaps={accepted as typeof gaps} />
            </details>
          ) : null}
        </div>
        <div className="approval-actions project-settlement-actions">
          <button type="button" className="card-action card-action--secondary" onClick={onReopen} disabled={!onReopen}>
            {DONE_CARD_REOPEN}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="approval-card project-settlement project-done-card">
      <div className="approval-head project-settlement-head">
        <span className="project-settlement-heading">{DONE_CARD_HEADING}</span>
        <span className="criteria-provenance" title={PROVENANCE_TITLE}>FROM ORBIT</span>
      </div>
      <div className="approval-body is-questions project-settlement-body">
        <div className="project-settlement-meta">
          {project.title} · {doneRequest ? `${PROJECT_DONE_COPY.askedByCoordinator} · just now` : PROJECT_DONE_COPY.noRequestMeta}
        </div>
        {doneRequest ? (
          <div className="project-done-call">
            <div className="project-done-section-title">{DONE_CARD_COORDINATOR_CALL}</div>
            <p>{doneRequest.judgment}</p>
          </div>
        ) : null}
        <DoneWhenSummary project={project} counts={counts} />
        <DoneGaps project={project} gaps={gaps} />
        <div className="project-done-orbit-checked">
          <span aria-hidden="true">✓</span>{' '}
          {orbitCheckedText(project, standing, openItemsCount, runningCount)}
        </div>
        <p className="project-done-explanation">
          {PROJECT_DONE_COPY.recordingExplanation}
        </p>
        {error ? <Alert className="project-settlement-error" type="error" showIcon message="Project was not recorded done" description={error.message} /> : null}
        {notYetOpen ? (
          <div className="project-done-not-yet">
            <Input.TextArea
              aria-label={DONE_CARD_MISSING}
              placeholder={DONE_CARD_MISSING}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 5 }}
              disabled={notYetBusy}
            />
            <p>{PROJECT_DONE_COPY.notYetHint}</p>
            <div className="project-done-not-yet-actions">
              <button type="button" className="card-action card-action--primary" disabled={notYetBusy || !note.trim()} onClick={() => onNotYet?.(note.trim())}>
                {PROJECT_DONE_COPY.sendToCoordinator}
              </button>
              <button type="button" className="card-action card-action--secondary" onClick={() => setNotYetOpen(false)} disabled={notYetBusy}>
                {PROJECT_DONE_COPY.back}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {!notYetOpen ? (
        <div className="approval-actions project-settlement-actions">
          <button type="button" className="card-action card-action--primary" disabled={!canRecord} onClick={onRecordDone}>
            {counts && counts.met < counts.criteria ? PROJECT_DONE_COPY.recordAsDoneAnyway : DONE_CARD_RECORD}
            {keys && canRecord ? <span className="approval-kbd">{ENTER_HINT}</span> : null}
          </button>
          {doneRequest ? (
            <button type="button" className="card-action card-action--secondary" disabled={busy || notYetBusy} onClick={() => setNotYetOpen(true)}>
              {DONE_CARD_NOT_YET}
              {keys ? <span className="approval-kbd">{SHORTCUT_HINT}</span> : null}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function doneRequestFromView(view: { doneRequest?: ProjectOpenItemRow | null } | undefined): ProjectOpenItemRow | null {
  return view?.doneRequest ?? null;
}

export interface ProjectDoneDialogProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** Optional data lets the coordinator transcript avoid a second open-items request. */
  project?: ProjectDoneDocument | null;
  doneRequestRow?: ProjectOpenItemRow | null;
  onRecorded?: (record: ProjectDoneRecord) => void;
}

/** Modal host for the project page. It deliberately renders `ProjectDoneCard`, so Review and
 * Record as done… have one visual and one mutation contract. */
export function ProjectDoneDialog({
  projectId,
  open,
  onClose,
  project: suppliedProject,
  doneRequestRow: suppliedRow,
  onRecorded,
}: ProjectDoneDialogProps): JSX.Element {
  const qc = useQueryClient();
  const projectRead = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDoneDocument>(`/projects/${encodeURIComponent(projectId)}`),
    enabled: open && Boolean(projectId) && suppliedProject == null,
  });
  const openItemsRead = useQuery({
    queryKey: ['project', projectId, 'open-items'],
    queryFn: () => api<{ doneRequest?: ProjectOpenItemRow | null; needsYou?: ProjectOpenItemRow[]; withCoordinator?: ProjectOpenItemRow[] }>(`/projects/${encodeURIComponent(projectId)}/open-items`),
    enabled: open && Boolean(projectId) && suppliedRow === undefined,
    refetchInterval: open ? 20_000 : false,
  });
  const standingRead = useQuery({
    queryKey: acceptanceConfirmationKey(projectId),
    queryFn: () => readAcceptanceConfirmation(projectId),
    enabled: open && Boolean(projectId),
    refetchInterval: open ? 20_000 : false,
  });
  const [receipt, setReceipt] = useState<ProjectDoneRecord | null>(null);
  const [declineError, setDeclineError] = useState<Error | null>(null);
  const record = useMutation({
    mutationFn: async ({ requestId, criteriaDigest, acceptedGaps }: { requestId: string | null; criteriaDigest: string; acceptedGaps: Record<string, unknown>[] }) =>
      api<ProjectDoneRecord>(`/projects/${encodeURIComponent(projectId)}/done`, {
        method: 'POST',
        body: { requestId, criteriaDigest, acceptedGaps },
      }),
    onSuccess: async (next) => {
      setReceipt(next);
      onRecorded?.(next);
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['project', projectId, 'open-items'] });
    },
  });
  const decline = useMutation({
    mutationFn: (input: { itemId: string; note: string }) => api(`/projects/${encodeURIComponent(projectId)}/done-requests/${encodeURIComponent(input.itemId)}/decline`, { method: 'POST', body: { note: input.note } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['project', projectId, 'open-items'] });
      onClose();
    },
    onError: (error) => setDeclineError(error instanceof Error ? error : new Error(String(error))),
  });
  const reopen = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { status: 'OPEN' } }),
    onSuccess: async () => {
      setReceipt(null);
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['project', projectId, 'open-items'] });
    },
  });
  const project = suppliedProject ?? projectRead.data ?? null;
  const row = suppliedRow !== undefined ? suppliedRow : doneRequestFromView(openItemsRead.data);
  const request = row?.doneRequest ?? null;
  const standing = standingRead.data ?? null;
  const criteriaDigest = request?.criteriaDigest ?? standing?.currentVersion.digest;
  const runningCount = project?.derivedDone?.counts.byReason.IN_FLIGHT ?? 0;
  const openItemsCount = (openItemsRead.data?.needsYou?.length ?? 0) + (openItemsRead.data?.withCoordinator?.length ?? 0) + (row ? 1 : 0);
  const submit = (): void => {
    if (!project || !criteriaDigest || record.isPending) return;
    record.mutate({ requestId: row?.itemId ?? null, criteriaDigest, acceptedGaps: (request?.gaps ?? syntheticDoneGaps(project)) as Record<string, unknown>[] });
  };
  const submitNotYet = (note: string): void => {
    if (row?.itemId && note.trim()) decline.mutate({ itemId: row.itemId, note });
  };
  return (
    <Modal open={open} title="" footer={null} onCancel={onClose} width={680} destroyOnClose={false} className="project-done-dialog">
      {project ? (
        <ProjectDoneCard
          project={project}
          doneRequest={request}
          requestId={row?.itemId ?? null}
          standing={standing}
          receipt={receipt}
          busy={record.isPending || !criteriaDigest}
          error={record.error ?? declineError}
          notYetBusy={decline.isPending}
          ownerInitiated={!request}
          openItemsCount={openItemsCount}
          runningCount={runningCount}
          onRecordDone={submit}
          onNotYet={submitNotYet}
          onReopen={() => reopen.mutate()}
        />
      ) : projectRead.isError ? <Alert type="error" showIcon message="Project could not be loaded" description={projectRead.error.message} /> : null}
    </Modal>
  );
}

export interface ProjectWhyNotDoneCardProps {
  project: ProjectDoneDocument;
  openItems?: { withCoordinator?: readonly ProjectOpenItemRow[]; doneRequest?: ProjectOpenItemRow | null };
  onReview?: () => void;
  onAskCoordinator?: () => void;
}

/**
 * The compact explanation card used where a project is visible outside the coordinator transcript.
 * It consumes the reason partition from `derivedDone.counts` and the criterion answers themselves;
 * it never turns task statuses or merge receipts into a second client-side count.
 */
export function ProjectWhyNotDoneCard({
  project,
  openItems,
  onReview,
  onAskCoordinator,
}: ProjectWhyNotDoneCardProps): JSX.Element {
  const criteria = project.derivedDone?.criteria ?? [];
  const byKey = new Map((project.acceptanceCriteriaItems ?? []).map((item) => [item.id, item]));
  // An unmet criterion is still work even when its landing lane says CODELESS or
  // NOTHING_TO_LAND.  Those two reasons are excluded only once the criterion itself is met: a
  // zero-commit task is then a harmless "nothing to land" outcome, not an item to hand back as a
  // fake merge repair.  A satisfied criterion with NO_RECEIPT is the genuine owner judgment lane.
  const waiting = criteria.filter((criterion) => (
    !criterion.satisfied
      || criterion.landingReason === 'IN_FLIGHT'
      || criterion.landingReason === 'ON_PROJECT_BRANCH'
  ));
  const needsCall = criteria.filter((criterion) => criterion.satisfied && criterion.landingReason === 'NO_RECEIPT');
  // An in-flight landing already has an owner in the integration lane. Even when the open-items
  // poll has not caught up, asking the reader to “Ask the coordinator” would be a duplicate door.
  const onlyInFlight = waiting.length > 0 && waiting.every((criterion) => criterion.landingReason === 'IN_FLIGHT');
  const coordinatorOnIt = onlyInFlight || (openItems?.withCoordinator?.length ?? 0) > 0;
  const hasGaps = waiting.length > 0 || needsCall.length > 0;
  const counts = project.derivedDone?.counts;
  if (!hasGaps && project.derivedDone?.done === true) {
    return (
      <div className="approval-card project-settlement project-why-not-done is-settled">
        <div className="approval-head project-settlement-head">
          <span className="project-settlement-heading">{PROJECT_DONE_COPY.thisProjectIsDone}</span>
          <span className="criteria-provenance">{project.doneBy === 'OWNER' ? PROJECT_DONE_COPY.recordedByYou : PROJECT_DONE_COPY.recordedByOrbit}</span>
        </div>
        <div className="approval-body is-questions project-settlement-body">
          <p className="project-done-tally">{projectWhyNotDoneTally(counts)}</p>
        </div>
      </div>
    );
  }
  const group = (title: string, rows: readonly typeof criteria[number][], waitingGroup: boolean) => rows.length === 0 ? null : (
    <div className="project-why-group" key={title}>
      <div className="project-why-group-head">
        <span>{title}</span>
        {waitingGroup && coordinatorOnIt ? <span className="project-why-who">● {PROJECT_DONE_COPY.coordinatorIsOnIt}</span> : null}
        {!waitingGroup && openItems?.doneRequest ? <span className="project-why-who">{PROJECT_DONE_COPY.openItemsDoneRequest.toLowerCase()} · just now</span> : null}
      </div>
      <ul className="project-why-list">
        {rows.map((criterion) => {
          const item = byKey.get(criterion.definitionId);
          return (
            <li key={criterion.definitionId} className="project-why-item">
              <span className="project-done-gap-number">{item?.ordinal ?? '•'}</span>
              <div>
                <div className="project-why-item-title">{item?.text ?? criterion.definitionId}</div>
                <div className="project-why-item-state">{landingReasonLabel(criterion.landingReason)}</div>
                <div className="project-why-item-detail">
                  {waitingGroup ? PROJECT_DONE_COPY.waitingDetail : PROJECT_DONE_COPY.needsCallDetail}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <div className="approval-card project-settlement project-why-not-done">
      <div className="approval-head project-settlement-head">
        <span className="project-settlement-heading">{PROJECT_DONE_COPY.whyHeading}</span>
        <span className="criteria-provenance">FROM ORBIT</span>
      </div>
      <div className="approval-body is-questions project-settlement-body">
        {group(PROJECT_DONE_COPY.waitingOnWork, waiting, true)}
        {group(PROJECT_DONE_COPY.needsYourCall, needsCall, false)}
        <p className="project-done-tally">{projectWhyNotDoneTally(counts)}</p>
      </div>
      <div className="approval-actions project-settlement-actions">
        {openItems?.doneRequest && onReview ? (
          <button type="button" className="card-action card-action--primary" onClick={onReview}>{PROJECT_DONE_COPY.reviewDoneRequest}</button>
        ) : waiting.length > 0 && !coordinatorOnIt && onAskCoordinator ? (
          <button type="button" className="card-action card-action--secondary" onClick={onAskCoordinator}>{PROJECT_DONE_COPY.askCoordinator}</button>
        ) : null}
        {waiting.length > 0 && coordinatorOnIt ? <span className="project-why-status">{PROJECT_DONE_COPY.coordinatorIsOnIt}</span> : null}
      </div>
    </div>
  );
}
