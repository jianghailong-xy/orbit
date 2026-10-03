import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { EVIDENCE_REVIEW_TURN_KEY_PREFIX } from '../sessions/watch-turn-key';
import { criterionStandingRefusal, decidingSessionDisqualification } from './task-evidence-decision';
import { describeEvidenceCitations, parseEvidenceEnvelope, type EvidenceEnvelope } from './task-evidence-envelope';

/**
 * Outside a project, the session that dispatched a task settles it on its run's evidence
 * (the B line of project 34Z2usxH1u0wBMagUPqlM, rules of 2026-10-03).
 *
 * WHAT CHANGED
 * ------------
 * EVIDENCE_JUDGMENT is settled by one CONFIRM, from a session that did not do the work, of the
 * task's latest evidence revision. In an Automatic project the revision is handed to the project's
 * coordinator to decide (`CompletionEvidenceProducer`); outside a project it was handed to nobody,
 * no client drew a card for it, and the write doors refused the declaration there for that reason.
 * The owner's choice, from the quantified report (task 34Z35uEB5SDTmJPgU1Hw5), was to give such
 * work a decider instead of a card: the conversation that filed the task — `task.creator_session_id`,
 * the dispatching session — is to it what a coordinator is to a project's work. So:
 *
 *  - a task with a dispatching session may declare EVIDENCE_JUDGMENT in no project
 *    (`criterionNeedsProjectRefusal`); one without — the owner's own, or one filed with no session —
 *    still may not, and is not delivered anything;
 *  - each evidence revision is delivered to that session as a platform turn, the way a confirmation
 *    request is delivered to its reviewer (`owner-confirmation-review.service.ts#deliver`, contract
 *    §2 D2): `evidence-review:v1:<evidenceId>`, no words of anybody's, its block rendered from the
 *    rows when it is handed out, queued behind whatever the session is doing and never reviving one
 *    that has ended. The session decides with `task_evidence_decide`; the decision door and its
 *    independence rule (`decidingSessionDisqualification`) are untouched;
 *  - while the reviewer holds it the owner is not asked (`reviewerHolds`), and when it stops holding
 *    it — 30 minutes after the delivery, or the moment that session has ended — the owner's card is
 *    drawn and counted (`ownerEvidenceCard`, `owner-decision-signal.ts`);
 *  - a task in no project with no dispatching session at all — filed with none, or whose dispatching
 *    session was deleted for good — has nobody to hold it, so its owner card is drawn in its run
 *    from the start, counted there, and decided there by the owner (`ownerDecidesInTheRun`).
 *
 * WHY NO ROW OF ITS OWN
 * ---------------------
 * The delivery IS the turn: its key is derived from the evidence row, `createTurn` writes it once,
 * and its `created_at` is the moment it was delivered. A refused delivery writes nothing at all —
 * which is also what a crash between the evidence's commit and the delivery leaves — and both read
 * as "not held", so the owner's card is drawn at once. That is the precedent `coordinatorHolds` set
 * for a project's evidence (a refused or never-sent wake is the owner's from the start), and it means
 * nothing here can strand a card: every failure lands on the owner. The clock is read once, in the
 * read, as `readAt < delivered + 30 min`; nothing is scheduled, swept or written to end a hold.
 */

/**
 * How long the dispatching session holds a delivered revision before the owner is asked: the 30
 * minutes a confirmation request's reviewer gets outside a project
 * (`OWNER_CONFIRMATION_REVIEW_WINDOW_SECONDS_OUTSIDE_PROJECTS`). Spelled here rather than imported,
 * because that module reaches the sessions service, which reaches this one.
 */
export const EVIDENCE_REVIEW_WINDOW_SECONDS = 1_800;

const UUID_AT_START = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/i;

/** How much of the standard and of each free-text field the reviewer is quoted. */
const QUOTE_CHARS = 2_000;

type Db = Prisma.TransactionClient;

export function evidenceReviewTurnId(evidenceId: string): string {
  return `${EVIDENCE_REVIEW_TURN_KEY_PREFIX}${evidenceId}`;
}

/** The evidence row an evidence-review turn carries — its own, or the one a re-send of it carries. */
export function evidenceIdOfReviewTurn(clientTurnId: string | null | undefined): string | null {
  if (!clientTurnId?.startsWith(EVIDENCE_REVIEW_TURN_KEY_PREFIX)) return null;
  return UUID_AT_START.exec(clientTurnId.slice(EVIDENCE_REVIEW_TURN_KEY_PREFIX.length))?.[1] ?? null;
}

export function isEvidenceReviewTurn(clientTurnId: string | null | undefined): boolean {
  return evidenceIdOfReviewTurn(clientTurnId) !== null;
}

/**
 * The key a failed evidence-review turn is re-sent under (auto-retry.service.ts): the same evidence,
 * a new turn, so its block is rendered again — never the message the session answered before it.
 * The hold keeps reading the original turn, which is the delivery.
 */
export function evidenceReviewRetryTurnId(clientTurnId: string | null | undefined, nonce: string): string | null {
  const evidenceId = evidenceIdOfReviewTurn(clientTurnId);
  return evidenceId ? `${evidenceReviewTurnId(evidenceId)}:retry:${nonce}` : null;
}

/** One unanswered revision of a dispatched task, as the hold reads it. */
export interface DispatchedRevision {
  taskId: string;
  evidenceId: string;
  /** `task.creator_session_id`: the reviewer. */
  dispatchingSessionId: string;
}

/**
 * The tasks whose latest revision their dispatching session is deciding right now, by task id.
 *
 * Held while ALL of these are true when it is read:
 *
 *   * the revision was delivered: its `evidence-review:v1:<evidenceId>` turn is in the dispatching
 *     session. A delivery that was refused, or never made, has no turn, and a queued turn the session
 *     never got — withdrawn, or dropped by an interrupt — is gone with it;
 *   * that session has not ended (`sessionHasEnded`, the line the delivery itself refuses on, which
 *     includes Trash), and its row still exists;
 *   * and 30 minutes have not passed since the turn was written, which is the moment of delivery.
 *
 * Two reads for the whole set: the turns, by the unique (session, key) pairs, and the sessions.
 */
export async function reviewerHolds(
  tx: Db,
  rows: ReadonlyArray<DispatchedRevision>,
  readAt: Date,
): Promise<Set<string>> {
  const held = new Set<string>();
  if (rows.length === 0) return held;
  const sessionIds = [...new Set(rows.map((row) => row.dispatchingSessionId))];
  const delivered = await tx.conversationTurn.findMany({
    where: {
      sessionId: { in: sessionIds },
      clientTurnId: { in: rows.map((row) => evidenceReviewTurnId(row.evidenceId)) },
    },
    select: { sessionId: true, clientTurnId: true, createdAt: true },
  });
  if (delivered.length === 0) return held;
  const sessions = await tx.session.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, ...SESSION_ENDING_SELECT },
  });
  const live = new Set(sessions.filter((session) => !sessionHasEnded(session)).map((session) => session.id));
  for (const row of rows) {
    if (!live.has(row.dispatchingSessionId)) continue;
    const turn = delivered.find((candidate) => candidate.sessionId === row.dispatchingSessionId
      && candidate.clientTurnId === evidenceReviewTurnId(row.evidenceId));
    if (!turn) continue;
    if (readAt.getTime() < turn.createdAt.getTime() + EVIDENCE_REVIEW_WINDOW_SECONDS * 1_000) {
      held.add(row.taskId);
    }
  }
  return held;
}

/**
 * Where the owner's card for the revision of a task in no project is drawn once nobody else holds it,
 * and in whose name the decision it records is made.
 *
 *  - In the dispatching session, while that conversation is not in Trash. For this work it is what
 *    a project's coordinator conversation is to a project's work, and that is where a project's
 *    evidence card is drawn. The decision is that session's.
 *  - Once it is in Trash, in the task's own run — the session that submitted the revision — so the
 *    question is still in front of the owner somewhere they can open. The decision is still the
 *    dispatching session's: the door names the conversation a decision is given in and refuses one
 *    that did the work, and the run did; the dispatching session did not, and its row is still there.
 *  - With no dispatching session at all — the task was filed with none, or the one it was filed from
 *    was deleted for good, which empties `creator_session_id` (ON DELETE SET NULL) — in the run as
 *    well, and from the start: nobody is delivered it and nobody holds it. The decision is recorded
 *    in the run's name, because there is no other conversation left to record it in, and the door
 *    takes it from the account owner pressing the card in the app and from nobody else
 *    (`ownerDecidesInTheRun`). Without that the task could never be settled at all.
 *
 * Null when the conversation the card would be drawn in is gone too.
 */
export interface OwnerEvidenceCard {
  sessionId: string;
  decidingSessionId: string;
}

export function ownerEvidenceCard(
  dispatching: { id: string; deletedAt: Date | null } | null,
  run: { id: string; deletedAt: Date | null } | null,
): OwnerEvidenceCard | null {
  if (dispatching && dispatching.deletedAt === null) {
    return { sessionId: dispatching.id, decidingSessionId: dispatching.id };
  }
  if (!run || run.deletedAt !== null) return null;
  return { sessionId: run.id, decidingSessionId: dispatching ? dispatching.id : run.id };
}

/**
 * The one decision the door takes from a session that did the work: the account owner, in the app,
 * pressing the owner card of a task in no project that has no dispatching session, in the run that
 * submitted its latest revision — the only conversation that card can be drawn in
 * (`ownerEvidenceCard`).
 *
 * The independence rule (`decidingSessionDisqualification`) is about who DECIDES: a run may not
 * settle its own work. Here the run decides nothing — the owner does, and the run is only where they
 * pressed. Every other caller is refused as before: an agent, a request carrying a session header, a
 * task in a project, a task whose dispatching session still exists (its card decides as that
 * session), and any session other than that run. `ownerInTheApp` is the OWNER_CONFIRMED door's own
 * test of the principal (`ownerConfirmationPrincipalRefusal`), asked by the caller.
 */
export async function ownerDecidesInTheRun(
  tx: Db,
  scope: { ownerId: string; taskId: string },
  decidingSessionId: string,
  ownerInTheApp: boolean,
): Promise<boolean> {
  if (!ownerInTheApp) return false;
  const task = await tx.task.findFirst({
    where: { id: scope.taskId, ownerId: scope.ownerId },
    select: {
      projectId: true,
      completionCriterion: true,
      creatorSession: { select: { id: true } },
      completionEvidence: { orderBy: { revision: 'desc' }, take: 1, select: { sourceSessionId: true } },
    },
  });
  if (!task || task.projectId !== null || task.completionCriterion !== 'EVIDENCE_JUDGMENT') return false;
  if (task.creatorSession !== null) return false;
  if (task.completionEvidence[0]?.sourceSessionId !== decidingSessionId) return false;
  const run = await tx.session.findFirst({
    where: { id: decidingSessionId, ownerId: scope.ownerId },
    select: { deletedAt: true },
  });
  return run !== null && run.deletedAt === null;
}

/** §2 D4's vocabulary, for a delivery this door would not make. Nothing is written for any of them. */
export const EVIDENCE_REVIEW_DELIVERY_REFUSALS = [
  'NOT_DISPATCHED',
  'REVIEWER_ENDED',
  'REVIEWER_NOT_INDEPENDENT',
  'SUPERSEDED',
  'DECIDED',
  'UNDECIDABLE',
  'SESSION_UNAVAILABLE',
] as const;
export type EvidenceReviewDeliveryRefusalCode = (typeof EVIDENCE_REVIEW_DELIVERY_REFUSALS)[number];

/** Thrown out of the delivery's turn hook, which rolls the turn back: nothing is delivered. */
export class EvidenceReviewDeliveryRefused extends ConflictException {
  constructor(readonly refusalCode: EvidenceReviewDeliveryRefusalCode, message: string) {
    super({ code: `EVIDENCE_REVIEW_DELIVERY_${refusalCode}`, message });
  }
}

/**
 * The delivery's own check, inside `createTurn`'s transaction and under the reviewer's Session lock,
 * so what it answers stays true until the turn commits: the task is still dispatched work in no
 * project waiting on a judgment, this is still its latest revision and nobody has decided it, there is
 * a standard to decide it against, and the reviewer is a conversation that is still open and that the
 * decision door would take a decision from. Any of those failing throws, and the turn is not written.
 */
export async function bindEvidenceReviewDelivery(
  tx: Db,
  evidence: { id: string; taskId: string; ownerId: string },
  reviewerSessionId: string,
): Promise<void> {
  const task = await tx.task.findFirst({
    where: { id: evidence.taskId, ownerId: evidence.ownerId },
    select: {
      projectId: true,
      creatorSessionId: true,
      completionCriterion: true,
      status: true,
      criterionDefinitionId: true,
      acceptanceCriteria: true,
    },
  });
  if (
    !task
    || task.projectId !== null
    || task.creatorSessionId !== reviewerSessionId
    || task.completionCriterion !== 'EVIDENCE_JUDGMENT'
    || (task.status !== 'OPEN' && task.status !== 'IN_PROGRESS')
  ) {
    throw new EvidenceReviewDeliveryRefused('NOT_DISPATCHED',
      'the task is no longer dispatched work in no project waiting on a judgment');
  }
  const reviewer = await tx.session.findFirst({
    where: { id: reviewerSessionId, ownerId: evidence.ownerId },
    select: { ...SESSION_ENDING_SELECT, id: true, taskId: true },
  });
  if (!reviewer || sessionHasEnded(reviewer)) {
    throw new EvidenceReviewDeliveryRefused('REVIEWER_ENDED', 'the dispatching session has ended');
  }
  const latest = await tx.taskCompletionEvidence.findFirst({
    where: { taskId: evidence.taskId },
    orderBy: { revision: 'desc' },
    select: { id: true, evidence: true, decisions: { select: { id: true }, take: 1 } },
  });
  if (latest?.id !== evidence.id) {
    throw new EvidenceReviewDeliveryRefused('SUPERSEDED', 'a later revision has been submitted since');
  }
  if (latest.decisions.length > 0) {
    throw new EvidenceReviewDeliveryRefused('DECIDED', 'this revision has been decided already');
  }
  if ((await criterionStandingRefusal(tx, task, latest.evidence)) !== null) {
    throw new EvidenceReviewDeliveryRefused('UNDECIDABLE',
      'the revision quotes no live standard, so no decision could be recorded on it');
  }
  const disqualified = await decidingSessionDisqualification(
    tx, { ownerId: evidence.ownerId, taskId: evidence.taskId }, reviewer,
  );
  if (disqualified !== null) {
    throw new EvidenceReviewDeliveryRefused('REVIEWER_NOT_INDEPENDENT', disqualified);
  }
}

/** A cited row's label on one line of the block. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function storedEnvelope(evidence: unknown): EvidenceEnvelope | null {
  try {
    return parseEvidenceEnvelope(evidence);
  } catch {
    return null;
  }
}

/**
 * The block an evidence-review turn is handed to its reviewer with, rendered from the rows as they
 * stand when it is handed out — so a revision that was decided, or replaced, while the turn waited
 * says so instead of asking for a decision nobody needs. Null when the evidence row is gone.
 */
export async function evidenceReviewBlock(db: Db, evidenceId: string): Promise<string | null> {
  const evidence = await db.taskCompletionEvidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      ownerId: true,
      taskId: true,
      revision: true,
      sourceSessionId: true,
      evidence: true,
      decisions: { select: { decision: true, decidedAt: true, decidedByType: true }, take: 1 },
      task: {
        select: {
          title: true,
          status: true,
          projectId: true,
          creatorSessionId: true,
          acceptanceCriteria: true,
        },
      },
    },
  });
  if (!evidence) return null;
  const task = evidence.task;
  const taskKey = uuidToBase62(evidence.taskId);
  const revision = evidence.revision.toString();
  const delivered = task.creatorSessionId
    ? await db.conversationTurn.findUnique({
      where: {
        sessionId_clientTurnId: {
          sessionId: task.creatorSessionId,
          clientTurnId: evidenceReviewTurnId(evidence.id),
        },
      },
      select: { createdAt: true },
    })
    : null;
  const dueAt = delivered
    ? new Date(delivered.createdAt.getTime() + EVIDENCE_REVIEW_WINDOW_SECONDS * 1_000)
    : null;
  const attributes = [
    `task="${taskKey}"`,
    `revision="${revision}"`,
    `run-session="${uuidToBase62(evidence.sourceSessionId)}"`,
    `due-at="${dueAt ? isoSeconds(dueAt) : ''}"`,
  ];
  const open = `<orbit-evidence-review ${attributes.join(' ')}>`;
  const close = '</orbit-evidence-review>';

  const latest = await db.taskCompletionEvidence.findFirst({
    where: { taskId: evidence.taskId },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  const nothingToDecide = (why: string) => [open, why, 'Nothing to decide; end your turn.', close].join('\n');
  if (latest && latest.revision !== evidence.revision) {
    return nothingToDecide(
      `The task “${task.title}” has submitted revision ${latest.revision} since this one, and that is the one waiting for a decision.`,
    );
  }
  const [decided] = evidence.decisions;
  if (decided) {
    const by = decided.decidedByType === 'USER' ? 'the account owner' : 'a session';
    return nothingToDecide(
      `Revision ${revision} of the task “${task.title}” was decided ${decided.decision} by ${by} at ${isoSeconds(decided.decidedAt)}.`,
    );
  }
  if (task.status !== 'OPEN' && task.status !== 'IN_PROGRESS') {
    return nothingToDecide(`The task “${task.title}” is ${task.status} now.`);
  }

  const envelope = storedEnvelope(evidence.evidence);
  const citations = envelope
    ? await describeEvidenceCitations(db, { ownerId: evidence.ownerId, taskId: evidence.taskId }, envelope.checks)
    : [];
  const lines = [
    open,
    `A run of the task “${task.title}”, which this session filed outside any project, submitted evidence that`,
    `its work is done (EVIDENCE_JUDGMENT, revision ${revision}). This session dispatched it, so the decision is`,
    'yours: the owner is not asked while you hold it. They are asked once due-at passes, or as soon as this',
    'session ends, and they can decide it on their card at any time.',
    '',
    `What settles it (the task's acceptance criteria, first ${QUOTE_CHARS} characters): ${clip(task.acceptanceCriteria?.trim() || '(none stated)', QUOTE_CHARS)}`,
    `What the run claims: ${clip(envelope?.claim ?? '(this revision is not a structured envelope)', QUOTE_CHARS)}`,
    `What it says it did not establish: ${envelope && envelope.gaps.length > 0 ? clip(envelope.gaps.join(' · '), QUOTE_CHARS) : '(nothing)'}`,
    'The checks it cites, as Orbit resolves them now:',
    ...(citations.length === 0
      ? ['- (none)']
      : citations.map((citation) => `- ${citation.kind} ${citation.ref}: ${
        citation.resolved ? oneLine(citation.label ?? 'resolved') : `not resolved (${citation.reason ?? 'unknown'})`}`)),
    '',
    'Check the work against those criteria yourself — the cited rows, the run’s branch, a test you run — and',
    `then decide with task_evidence_decide (taskId "${taskKey}", evidenceRevision "${revision}"):`,
    '- CONFIRM when the evidence shows the criteria are met: the task becomes DONE and what depends on it',
    '  may start.',
    '- SEND_BACK, with a note saying what the next revision has to show, when it does not: the task stays',
    '  open for that revision. The note is not delivered to the run; if it should carry on, tell it.',
    'If you leave it undecided, the owner decides it on their card after due-at.',
    close,
  ];
  return lines.join('\n');
}

/**
 * Write an evidence-review turn's block into what it is handed. Called at delivery for every message
 * turn, beside the confirmation review's, outside the first-delivery branch: a review turn handed out
 * again after its runner died still has to say what it is for. Not best-effort: the block IS the turn.
 */
export async function appendEvidenceReviewContext(
  db: Db,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  const evidenceId = evidenceIdOfReviewTurn(clientTurnId);
  if (!evidenceId) return content;
  const block = await evidenceReviewBlock(db, evidenceId);
  if (!block) return content;
  return content ? `${content}\n\n${block}` : block;
}
