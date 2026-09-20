import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { api } from '../api';
import {
  acceptanceConfirmationKey,
  confirmAcceptanceCriteria,
  readAcceptanceConfirmation,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import { PROVENANCE_LABEL, PROVENANCE_TITLE } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

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
 * ONE DOOR, AND IT IS NOT "DONE"
 * ------------------------------
 * The only press here is `Confirm the criteria`, and it appears only when the set standing today
 * is unconfirmed — the derivation's second input, and the one thing on this card a person supplies
 * (`POST /projects/:id/acceptance/confirmation`, the same door the start card presses, with the
 * browser's credential and no acting session). Every other clause is work rather than a decision,
 * so it is a sentence and "Chat about this", not a button.
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
}

/** `derivedDone`, as the project document serves it. */
export interface SettlementProjection {
  status: 'OPEN' | 'DONE';
  done: boolean;
  withheld: SettlementClause[];
  criteria: SettlementCriterionAnswer[];
  confirmation: 'UNCONFIRMED' | 'CONFIRMED' | 'STALE';
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
}

/** The card's heading: the question a reader actually has, since the server settles the project
 *  itself and this is the only thing left to explain. */
export const SETTLEMENT_HEADING = 'Why is this project not done?';

/** The rule the card is about to hold up against this project. The count of clauses that do not
 *  hold is appended per render (`settlementExplains`). */
export const SETTLEMENT_RULE =
  'Orbit records a project done by itself — no press, no agent — when every stated criterion is '
  + 'met by work that has landed and counts, under a criteria set you have confirmed.';

/** The one press on this card. It is the derivation's second input, not a status write. */
export const SETTLEMENT_CONFIRM_ACTION = 'Confirm the criteria';
/** Shown under the actions: what the secondary does rather than what it says. */
export const SETTLEMENT_CHAT_HINT =
  '“Chat about this” hands the card’s own facts to the composer below — the blocked criteria, what '
  + 'Orbit says each is waiting on, and what would clear them.';
/** The settled state: the derivation stopped withholding, which is the whole of "done" here. */
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
export const SETTLEMENT_CHAT_PREFIX = 'Talking about this project: ';
export const SETTLEMENT_CHAT_PLACEHOLDER = 'What is still missing?';
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
 * One press and one way through, and the press appears only when the clause it clears is the one
 * withholding settlement: a button that cannot change anything is worse than no button.
 */
export function ProjectSettlementCard({
  project,
  standing,
  settled,
  busy = false,
  error = null,
  onConfirm,
  onChatAbout,
}: {
  /** The project document, with the projection on it. */
  project: SettlementProjectDocument;
  /** The standard-set standing, read only when the confirmation clause is withholding. */
  standing?: StandardSetConfirmationStanding | null;
  /** Whether the derivation has stopped withholding — read back, not remembered. */
  settled: boolean;
  busy?: boolean;
  error?: Error | null;
  onConfirm: () => void;
  onChatAbout: () => void;
}): JSX.Element {
  const [openClause, setOpenClause] = useState<SettlementClause | null>(null);
  const projection = project.derivedDone;
  const withheld = projection?.withheld ?? [];
  const words = new Map((project.acceptanceCriteriaItems ?? []).map((item) => [item.id, item]));
  const offersConfirmation = withheld.includes('STANDARD_SET_UNCONFIRMED');
  const confirmable = standing != null && standing.state !== 'CONFIRMED';

  return (
    <div className="approval-card project-settlement">
      <div className="approval-head project-settlement-head">
        <span className="project-settlement-heading">{SETTLEMENT_HEADING}</span>
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
            <p className="project-settlement-settled">
              <b>{SETTLEMENT_SETTLED_TITLE}</b> {SETTLEMENT_SETTLED_BODY}
            </p>
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
            </button>
          ) : null}
          <button type="button" className="card-action card-action--secondary" onClick={onChatAbout}>
            {OWNER_SEND_BACK_ACTION}
          </button>
          <span className="project-settlement-hint">{SETTLEMENT_CHAT_HINT}</span>
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
  onChatAbout,
}: {
  /** The project this session coordinates. Ordinary sessions have none and get no card. */
  projectId: string | null | undefined;
  /** Arms the bottom composer to talk about this card, given what the next send should carry as
   *  context. Nothing here is a door, and the card stays put. */
  onChatAbout?: (talk: { projectId: string; projectTitle: string; facts: string }) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const [delivered, setDelivered] = useState(false);
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () => api<SettlementProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  // A read that has not answered yet is not an answer: there is nothing to draw the card from, and
  // nothing is drawn.
  const document = documentRead.data ?? null;
  const held = settlementHeldOnProject(document);
  const settled = document?.derivedDone?.done === true;
  useEffect(() => {
    if (held) setDelivered(true);
  }, [held]);
  const shown = delivered || held;

  // The confirmation standing, read only when the card is up AND the clause withholding settlement
  // is the one a person clears — the same key and door the start card uses.
  const needsStanding = shown && (document?.derivedDone?.withheld.includes(CONFIRMATION_CLAUSE) ?? false);
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

  if (!shown || document === null) return null;
  const title = document.title || project;
  return (
    <ProjectSettlementCard
      project={document}
      standing={standingRead.data ?? null}
      settled={settled}
      busy={confirm.isPending}
      error={confirm.isError ? confirm.error : null}
      onConfirm={() => {
        const standing = standingRead.data;
        if (!standing || standing.confirmed || confirm.isPending) return;
        confirm.mutate(standing.currentVersion.digest);
      }}
      onChatAbout={() =>
        onChatAbout?.({
          projectId: project,
          projectTitle: title,
          facts: projectSettlementContext(document),
        })
      }
    />
  );
}
