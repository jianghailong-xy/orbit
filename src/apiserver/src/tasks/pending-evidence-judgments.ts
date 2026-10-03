import { TaskStatus } from '@prisma/client';
import type { CreatorType, Prisma as PrismaTypes, TaskEvidenceDecisionValue } from '@prisma/client';
import { completionEvidenceWakeKey } from '../projects/completion-input';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { ownerEvidenceCard, reviewerHolds, type OwnerEvidenceCard } from './evidence-review';
import {
  CRITERION_MOVED_ACTION,
  REQUIRES_INDEPENDENT_SESSION_ACTION,
  criterionStandingRefusal,
  decidingSessionDisqualification,
} from './task-evidence-decision';
import {
  describeEvidenceCitations,
  parseEvidenceEnvelope,
  type EvidenceCitation,
  type EvidenceEnvelope,
} from './task-evidence-envelope';

/**
 * What a coordinator session is being asked to decide, derived from the ledger every time it is
 * asked.
 *
 * A DERIVED READ, NOT A QUEUE
 * ---------------------------
 * There is no row anywhere that says "this is pending". Pending is a shape the facts already have:
 * a task that declared EVIDENCE_JUDGMENT, has not settled, has a submitted evidence revision, and
 * has no decision bound to the LATEST one. Every one of those is a column somebody else wrote for
 * their own reasons, so this read cannot fall out of date with them, cannot be delivered twice,
 * and cannot be lost. Closing the session that was reading it changes none of them.
 *
 * That is also, exactly, why it is not hung on the `approval_request` / `approval_resolved` frames.
 * Those are published at seq 0 and are live-only — `?sinceSeq=` never replays them — so a client
 * that was holding a socket when one was answered elsewhere goes on showing a card that no longer
 * has a question behind it, forever. A read that recomputes from rows has no local state to lose
 * and therefore cannot be in that state: the row is gone from the next read because the decision
 * exists, not because a frame arrived.
 *
 * THIS READ IS WHAT THE DECISION CARD IS DRAWN FROM
 * -------------------------------------------------
 * Until 2026-09-10 the question was also delivered: a turn in the project's coordinator
 * conversation told the model to ask through `AskUserQuestion`, and this read was the fallback
 * under a card that could be asked and never answered. That delivery is gone. The account owner's
 * card renders these rows and its buttons post to `POST /tasks/:taskId/evidence/decision`, so this
 * is no longer the floor under the question but the only way it is put to anybody — which a
 * derived read can afford to be: pending is a shape the rows already have, so a question nobody
 * has looked at yet is still here on the next read, and nothing has to be re-sent for it to be.
 * Its cost is the one `docs/completion-input-routing.md` §A2 D1 names, and narrowing WHO it is
 * read for is still how that comes down.
 *
 * EXCEPT WHILE AN AUTOMATIC PROJECT'S COORDINATOR IS DECIDING IT (2026-09-29)
 * ------------------------------------------------------------------------
 * In a project whose coordinator switch is on, a revision that conversation can decide is
 * delivered to it to decide (`CompletionEvidenceProducer`), and the owner's card is the fallback:
 * such a revision is not placed in `pending`, and not counted, while the coordinator holds it
 * (`coordinatorHolds` below says exactly when that is). Nothing is written to take it back — the
 * hold is read off the delivery's own ledger row and the project's clock, so it ends by itself.
 * It decides only where the question is ASKED: the decision door takes the owner's answer at any
 * moment, held or not.
 *
 * AND OUTSIDE A PROJECT, WHILE THE SESSION THAT DISPATCHED THE TASK IS DECIDING IT (2026-10-03)
 * -------------------------------------------------------------------------------------------
 * A task a session filed in no project is that session's to settle: each revision is delivered to it
 * (`evidence-review.ts`), and while it holds the revision (`reviewerHolds`: delivered, the session
 * still open, 30 minutes not yet passed) the revision is in nobody's `pending`. Once it stops holding
 * it, the revision is the owner's card in exactly ONE conversation — the dispatching session, or the
 * task's run once that one is in Trash (`ownerEvidenceCard`) — and in that conversation's `pending`
 * alone, carrying the session the decision is recorded as (`ownerCard`). A task in no project that no
 * session dispatched is read exactly as before.
 *
 * WHY EACH ROW CARRIES A REASON RATHER THAN A FLAG
 * ------------------------------------------------
 * Same shape `criterionSatisfaction` settled on for the criterion side: a reader who is told only
 * "no" cannot act, so every row carries the criterion it is measured against, what each citation
 * resolved to when asked, what the submitter declared it did NOT establish, and — when this
 * particular reader may not answer, or when nobody may — the refusal and the action that would
 * clear it. The decider is meant to be able to decide from the row.
 *
 * NOTHING HERE GATES ANYTHING. It writes nothing, and no status is derived from it: the decision
 * door is the only thing that records an answer, and this is the read that finds the question.
 */

/**
 * Which statuses can still be waiting on an answer. A task that has settled is not a question.
 *
 * This is NOT the same clause as "no decision bound to the latest revision" below, and neither one
 * subsumes the other — they overlap on exactly one case. Since 0239 a CONFIRM of the current
 * revision derives DONE, so a confirmed task leaves by both at once; but a SEND_BACK writes
 * nothing to the task, so a sent-back one is DECIDED and still OPEN, and only the other clause
 * takes it out. Drop this one and a settled task's later evidence revision becomes a question
 * nobody can answer; drop that one and every sent-back task comes straight back to the top of the
 * queue holding the version its reader has already answered.
 */
const UNSETTLED: readonly TaskStatus[] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];

/**
 * Whether ANY decision could be recorded about this row today, and — when none could — why not.
 *
 * Independence below is about the reader; this is about the row. The two are separate because
 * their answers are: a row this reader may not answer is somebody else's to settle, and a row
 * check 2 would refuse is nobody's — it is the submitter's to resubmit. Collapsing them into one
 * "can you press this" boolean is how the rail came to show a card whose only lit action was
 * refused every time it was pressed.
 */
export interface JudgmentDecidability {
  /** True when the decision door would not refuse this row for want of a live stated standard. */
  decidable: boolean;
  /** Null when decidable; otherwise the door's own reason, quoted rather than restated. */
  refusal: string | null;
  /** The action that would clear it, in the same vocabulary the refusal carries. */
  requiredAction: string | null;
}

/** Whether this reader may answer this row, and — when it may not — the door's own words for why. */
export interface JudgmentIndependence {
  /** True when the door's independence check would let this session answer this row. */
  independent: boolean;
  /** Null when independent; otherwise the reason the door would refuse, quoted not restated. */
  disqualification: string | null;
  /** The action that would clear it, in the same vocabulary the refusal carries. */
  requiredAction: string | null;
}

/** One task waiting for a decision, with everything the decision needs in it. */
export interface PendingEvidenceJudgment {
  taskId: string;
  title: string;
  status: TaskStatus;
  projectId: string | null;
  /** The stated criterion the evidence quotes, as it was quoted. Null for evidence that quotes
   *  none — a legacy import, or anything submitted before the envelope existed. */
  criterion: { key: string; text: string } | null;
  /** The revision awaiting an answer, in the decimal spelling the decision door takes back. */
  evidenceRevision: string;
  submittedAt: Date;
  /** Age at `readAt`, in whole seconds, so the rail's "oldest" is the server's clock and not the
   *  browser's. */
  ageSeconds: number;
  /** What the submitter says the work established. */
  claim: string;
  /** What the submitter says it did NOT establish. Carried on every row because it is the field
   *  most likely to change the answer; no client may drop it to save space. */
  gaps: string[];
  /** One per cited check, in the submitted order, resolved against the rows as they are NOW. */
  citations: EvidenceCitation[];
  /** Whether the door would refuse every decision about this evidence, whoever is reading. */
  decidability: JudgmentDecidability;
  /** Whether the door would take a decision on this row from this reader — or, on a row with an
   *  `ownerCard`, from the session that card decides as. */
  independence: JudgmentIndependence;
  /**
   * For a task a session dispatched outside any project: the conversation the account owner's card
   * for it is drawn in, and the session its decision is recorded as (`ownerEvidenceCard`) — the
   * `decidingSessionId` a press posts, which is not always the conversation it is pressed in. Null on
   * every other row: a project's are drawn in its coordinator conversation, by `projectId`.
   */
  ownerCard: OwnerEvidenceCard | null;
}

/**
 * What THIS session is being asked about: the count, the oldest age, and the two groups.
 *
 * READ FOR ONE SESSION, NOT FOR THE ACCOUNT
 * -----------------------------------------
 * The rows are found by owner, because that is the only way to find them — a question is a shape
 * some task's columns have, and tasks belong to an account. What comes BACK is scoped to the
 * session that asked, because a question is addressed to whoever can act on it and to nobody else.
 * Handing every session the same account-level list is how one fact came to be painted onto N
 * faces at once: every open session showed the same two undecidable rows, none of whose readers
 * could do anything about them, while the party who could — the submitter — was told nothing in
 * particular. Broadcasting is not delivery.
 *
 * So each row has three destinations and only two of them are groups, decided by the two
 * questions the door already asks and this read already has the answers to:
 *
 *  - `pending` — a decision can be recorded, and THIS reader is one the door would take it from.
 *    These are the only rows a decider is asked about, and `count` counts these and nothing else.
 *  - `waitingOnYou` — no decision can be recorded until another revision is filed, and this
 *    reader is the run that filed the last one. It is actionable exactly here, which is why it is
 *    its own group rather than a greyed line: the reader can fix it.
 *  - and everything else is not returned at all. Both remaining combinations are addressed to
 *    somebody who is already being shown them — a decidable row to every session that may answer
 *    it, an undecidable one to the run that has to file the next revision — so a copy here would
 *    be a row whose only possible reading is "not your problem". Handing the stalled ones to
 *    every OTHER session was the same broadcast this read was scoped to stop, one grey heading
 *    further down: a reader chasing the stalled population wants the report of stalled tasks, not
 *    a notice pinned to every screen in the account.
 */
export interface PendingEvidenceJudgmentQueue {
  readAt: Date;
  /** The session these rows were read FOR — every group below is scoped to it. */
  decidingSessionId: string;
  /** How many rows are waiting for a DECISION FROM THIS SESSION: the length of `pending`. */
  count: number;
  /** The age of the oldest question this session is asked to decide, or null when there is none. */
  oldestAgeSeconds: number | null;
  /** Rows the door would accept a decision on, from this reader. */
  pending: PendingEvidenceJudgment[];
  /** Rows waiting on a revision THIS session is the one to file. */
  waitingOnYou: PendingEvidenceJudgment[];
  /** What THIS session has already decided, oldest first: the receipts its conversation keeps
   *  after a card's question is gone. Read off the decision rows, so a reload or another device
   *  shows the same ones. */
  decided: RecordedEvidenceDecision[];
}

/** One decision recorded FROM the reading session. Small on purpose — this rides every poll of
 *  the pending read — so the evidence it answered is fetched when a reader opens it, not here. */
export interface RecordedEvidenceDecision {
  taskId: string;
  title: string;
  projectId: string | null;
  /** The revision that was answered, in the decimal spelling a pending row uses. */
  evidenceRevision: string;
  decision: TaskEvidenceDecisionValue;
  /** The reason a SEND_BACK carries; null for a CONFIRM. */
  note: string | null;
  decidedAt: Date;
  /** USER when the owner pressed the card; AGENT when a run of this session called the door. */
  decidedByType: CreatorType;
}

/**
 * The stored envelope, or null when this evidence predates it.
 *
 * Layer 1 is reused rather than re-implemented: what a card may show is exactly what a submission
 * had to be for it to be accepted. The catch is not a shrug — a legacy import is deliberately
 * exempt from the envelope, so its row still belongs in the queue and simply has less to render.
 */
function storedEnvelope(evidence: unknown): EvidenceEnvelope | null {
  try {
    return parseEvidenceEnvelope(evidence);
  } catch {
    return null;
  }
}

function ageSeconds(readAt: Date, submittedAt: Date): number {
  return Math.max(0, Math.floor((readAt.getTime() - submittedAt.getTime()) / 1000));
}

/**
 * The tasks whose latest revision the project's coordinator is deciding right now, by task id.
 *
 * A revision is held while ALL of these are true when it is read:
 *
 *   * its wake was DELIVERED — the revision the task's latest evidence row names, by the fact's own
 *     key, under the project the task is filed under now;
 *   * that project is still Automatic: switched off, it is the owner's card again, as it is for
 *     every project that is not (2026-09-10's behaviour, kept for them unchanged);
 *   * the conversation it was delivered to has not ended (`sessionHasEnded`, the line the delivery
 *     itself refuses on): a conversation that is over will not decide anything;
 *   * and the project's `exceptionEscalationSeconds` have not run out since the delivery was
 *     bound. `updatedAt` is that moment: the compare-and-set that writes DELIVERED is the row's
 *     last write.
 *
 * A delivery that was refused has no DELIVERED row, and a revision that was only recorded has none
 * either, so both are the owner's from the start.
 */
async function coordinatorHolds(
  tx: PrismaTypes.TransactionClient,
  latest: ReadonlyArray<{
    taskId: string;
    projectId: string | null;
    revision: bigint;
    criterionRevision: string;
    evidenceDigest: string;
  }>,
  readAt: Date,
): Promise<Set<string>> {
  const subjects = new Map<string, { taskId: string; projectId: string }>();
  for (const row of latest) {
    if (row.projectId == null) continue;
    const key = completionEvidenceWakeKey(row.taskId, {
      revision: row.revision.toString(),
      criterionRevision: row.criterionRevision,
      evidenceDigest: row.evidenceDigest,
    });
    subjects.set(key, { taskId: row.taskId, projectId: row.projectId });
  }
  const held = new Set<string>();
  if (subjects.size === 0) return held;

  const delivered = await tx.projectCoordinatorWake.findMany({
    where: { idempotencyKey: { in: [...subjects.keys()] }, status: 'DELIVERED' },
    select: {
      idempotencyKey: true,
      projectId: true,
      updatedAt: true,
      project: { select: { coordinatorEnabled: true, exceptionEscalationSeconds: true } },
      session: { select: SESSION_ENDING_SELECT },
    },
  });
  for (const wake of delivered) {
    const subject = subjects.get(wake.idempotencyKey);
    if (!subject || wake.projectId !== subject.projectId) continue;
    if (!wake.project.coordinatorEnabled) continue;
    if (!wake.session || sessionHasEnded(wake.session)) continue;
    const escalatesAt = wake.updatedAt.getTime() + wake.project.exceptionEscalationSeconds * 1_000;
    if (readAt.getTime() < escalatesAt) held.add(subject.taskId);
  }
  return held;
}

/**
 * The tasks whose LATEST evidence revision carries no decision yet, each with that revision and
 * whether the project's coordinator holds it (`coordinatorHolds`) — the population both the queue
 * and the badge's count (`countPendingEvidenceJudgments`) place, read by one query so the two
 * cannot come to disagree about it. `projectIds` narrows it to those projects, and `dispatched` to
 * the tasks a session filed in no project — further, when it names `taskIds`, to tasks the given
 * conversations could draw a card for (`countDispatchedEvidenceJudgments`).
 *
 * A dispatched row — in no project, with a dispatching session — also carries whether that session
 * holds it (`reviewerHolds`), where the owner's card for it is drawn (`ownerEvidenceCard`), and the
 * dispatching session itself, which is what that card decides as.
 */
async function unansweredLatestEvidence(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  readAt: Date,
  scope: {
    projectIds?: readonly string[];
    dispatched?: { creatorSessionIds?: readonly string[]; taskIds?: readonly string[] };
  } = {},
) {
  const narrowed = scope.dispatched?.creatorSessionIds !== undefined;
  const tasks = await tx.task.findMany({
    where: {
      ownerId,
      ...(scope.projectIds ? { projectId: { in: [...scope.projectIds] } } : {}),
      ...(scope.dispatched ? { projectId: null, creatorSessionId: { not: null } } : {}),
      ...(narrowed
        ? {
          OR: [
            { creatorSessionId: { in: [...scope.dispatched!.creatorSessionIds!] } },
            { id: { in: [...(scope.dispatched!.taskIds ?? [])] } },
          ],
        }
        : {}),
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: { in: [...UNSETTLED] },
      completionEvidence: { some: {} },
    },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      // Read for the standing check below and for nothing else: a task in no project is held to
      // its own acceptance criteria, so a queue that did not select them would ask the door a
      // narrower question than the door asks itself.
      acceptanceCriteria: true,
      // The session that filed it: outside a project, the one that decides it (`evidence-review.ts`).
      creatorSession: { select: { id: true, taskId: true, deletedAt: true } },
      completionEvidence: {
        orderBy: { revision: 'desc' },
        take: 1,
        select: {
          id: true,
          revision: true,
          criterionRevision: true,
          evidenceDigest: true,
          submittedAt: true,
          sourceSessionId: true,
          evidence: true,
          decisions: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  const unanswered = tasks.flatMap((task) => {
    const [latest] = task.completionEvidence;
    return latest && latest.decisions.length === 0 ? [{ task, latest }] : [];
  });
  const held = await coordinatorHolds(
    tx,
    unanswered.map(({ task, latest }) => ({
      taskId: task.id,
      projectId: task.projectId,
      revision: latest.revision,
      criterionRevision: latest.criterionRevision,
      evidenceDigest: latest.evidenceDigest,
    })),
    readAt,
  );
  const dispatched = unanswered.flatMap(({ task, latest }) => (
    task.projectId === null && task.creatorSession
      ? [{ taskId: task.id, evidenceId: latest.id, dispatchingSessionId: task.creatorSession.id }]
      : []
  ));
  const heldByReviewer = await reviewerHolds(tx, dispatched, readAt);
  // The runs a card falls back to: only asked about for a dispatching session that is in Trash.
  const runIds = [...new Set(unanswered.flatMap(({ task, latest }) => (
    task.projectId === null && task.creatorSession?.deletedAt ? [latest.sourceSessionId] : []
  )))];
  const runs = runIds.length === 0 ? [] : await tx.session.findMany({
    where: { id: { in: runIds }, ownerId },
    select: { id: true, deletedAt: true },
  });
  return unanswered.map((row) => {
    const dispatching = row.task.projectId === null ? row.task.creatorSession : null;
    return {
      ...row,
      heldByCoordinator: held.has(row.task.id),
      dispatching,
      heldByReviewer: heldByReviewer.has(row.task.id),
      ownerCard: dispatching
        ? ownerEvidenceCard(dispatching, runs.find((run) => run.id === row.latest.sourceSessionId) ?? null)
        : null,
    };
  });
}

/**
 * Every question of this owner's that is open right now, oldest first, as one read.
 *
 * `take: 1` on the evidence is the whole of "the latest revision": a decision is bound to one
 * immutable version, so an older revision that was answered — or never was — is not what anybody
 * is being asked about. A task whose latest revision already carries a decision is not returned at
 * all, which is what makes an answered row disappear from every reader's next read rather than
 * from the one that happened to be listening.
 *
 * WHY THE ROWS ARE IN GROUPS, AND WHY THE GROUPS ARE ABOUT THE READER
 * ------------------------------------------------------------------
 * Because the door has different answers for them and one list can only promise one. Check 2
 * refuses evidence that quotes no live stated standard — for a CONFIRM and for a SEND_BACK alike,
 * since it runs before either is written — so a legacy submission from before the envelope, or one
 * whose criterion has since been rewritten, is a row on which every decision fails. Listing it
 * beside the answerable ones is what put a card on screen headed DECISION REQUIRED whose only
 * enabled control was refused every time it was pressed. It is not dropped from everywhere
 * either: it goes to the one run that can file the revision that clears it, which is the whole
 * difference between delivering a stall and posting it. No other reader is sent it, because there
 * is nothing any of them could do with it.
 *
 * Check 3 is then asked of the SAME row for a different purpose. It has always been asked here —
 * every row already said whether this reader may answer it — but the answer only decorated the
 * row instead of placing it, so a session that could not answer a single one of these questions
 * was still handed all of them. Now it decides whether the row reaches this reader at all, which
 * is what makes this a read for one session rather than a copy of the account posted through
 * every open window.
 * The predicates are the door's own (`criterionStandingRefusal`, `decidingSessionDisqualification`)
 * for the reason they always were: a second opinion here is drift, and drift is how a queue comes
 * to promise a decision the door refuses.
 */
export async function readPendingEvidenceJudgments(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  decidingSession: { id: string; taskId: string | null },
  readAt: Date = new Date(),
): Promise<PendingEvidenceJudgmentQueue> {
  const pending: PendingEvidenceJudgment[] = [];
  const waitingOnYou: PendingEvidenceJudgment[] = [];
  const unanswered = await unansweredLatestEvidence(tx, ownerId, readAt);
  for (const { task, latest, heldByCoordinator, dispatching, heldByReviewer, ownerCard } of unanswered) {
    const envelope = storedEnvelope(latest.evidence);
    const disqualification = await decidingSessionDisqualification(
      tx,
      { ownerId, taskId: task.id },
      decidingSession,
    );
    // A dispatched row's card decides as its dispatching session wherever it is drawn, so in the
    // card's conversation that session is the one the door's independence question is about.
    const isCardHere = dispatching !== null && ownerCard?.sessionId === decidingSession.id;
    const independenceOf = !isCardHere || ownerCard!.decidingSessionId === decidingSession.id
      ? disqualification
      : await decidingSessionDisqualification(
        tx, { ownerId, taskId: task.id }, { id: dispatching!.id, taskId: dispatching!.taskId },
      );
    // Asked of the door's own predicate rather than re-derived from `envelope` above: whether a
    // decision can be recorded is the door's question, and a second opinion here is exactly the
    // drift that would put an undecidable row back among the answerable ones.
    const standing = await criterionStandingRefusal(tx, task, latest.evidence);
    const row: PendingEvidenceJudgment = {
      taskId: task.id,
      title: task.title,
      status: task.status,
      projectId: task.projectId,
      criterion: envelope?.criterion ?? null,
      evidenceRevision: latest.revision.toString(),
      submittedAt: latest.submittedAt,
      ageSeconds: ageSeconds(readAt, latest.submittedAt),
      claim: envelope?.claim ?? '',
      gaps: envelope?.gaps ?? [],
      citations: envelope
        ? await describeEvidenceCitations(tx, { ownerId, taskId: task.id }, envelope.checks)
        : [],
      decidability: {
        decidable: standing === null,
        refusal: standing?.reason ?? null,
        requiredAction: standing === null ? null : CRITERION_MOVED_ACTION,
      },
      independence: {
        independent: independenceOf === null,
        disqualification: independenceOf,
        requiredAction: independenceOf === null ? null : REQUIRES_INDEPENDENT_SESSION_ACTION,
      },
      ownerCard: dispatching ? ownerCard : null,
    };
    // The placement, in the order the door asks: is there a standard to decide this against at
    // all, and then is this reader one the door would take the decision from. Two of the four
    // answers come back and two go nowhere. A decidable row this reader may not answer is already
    // in front of every session that CAN answer it; an undecidable row this reader did not file is
    // already in front of the run that has to file the next revision. Either copy would be a row
    // whose only possible reading is "not your problem", which is a broadcast however quietly it
    // is worded. And a decidable row an Automatic project's coordinator holds is not asked of
    // anybody else until the hold ends — that is the whole of what the hold changes.
    //
    // A row a session dispatched outside any project is asked of one conversation only — its card's,
    // once the dispatching session has stopped holding it — and from there in the dispatching
    // session's name. The run that has to refile an undecidable one is told so as before.
    if (dispatching) {
      if (standing === null) {
        if (isCardHere && !heldByReviewer && independenceOf === null) pending.push(row);
      } else if (disqualification !== null) {
        waitingOnYou.push(row);
      }
      continue;
    }
    if (standing === null) {
      if (disqualification === null && !heldByCoordinator) pending.push(row);
    } else if (disqualification !== null) {
      waitingOnYou.push(row);
    }
  }

  // Oldest first, and by task id where two were submitted in the same millisecond: the rail leads
  // with the age of the oldest question, so the order it leads with has to be the order it shows.
  const oldestFirst = (left: PendingEvidenceJudgment, right: PendingEvidenceJudgment): number => (
    left.submittedAt.getTime() - right.submittedAt.getTime()
      || left.taskId.localeCompare(right.taskId)
  );
  pending.sort(oldestFirst);
  waitingOnYou.sort(oldestFirst);

  // Found by the session that recorded them and nothing else: a decision's receipt belongs to the
  // conversation it was given in, however many other sessions could have given it.
  const recorded = await tx.taskEvidenceDecision.findMany({
    where: { ownerId, decidingSessionId: decidingSession.id },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: {
      decision: true,
      note: true,
      decidedAt: true,
      decidedByType: true,
      task: { select: { id: true, title: true, projectId: true } },
      evidence: { select: { revision: true } },
    },
  });

  return {
    readAt,
    decidingSessionId: decidingSession.id,
    count: pending.length,
    oldestAgeSeconds: pending.length === 0 ? null : pending[0].ageSeconds,
    pending,
    waitingOnYou,
    decided: recorded.map((row) => ({
      taskId: row.task.id,
      title: row.task.title,
      projectId: row.task.projectId,
      evidenceRevision: row.evidence.revision.toString(),
      decision: row.decision,
      note: row.note,
      decidedAt: row.decidedAt,
      decidedByType: row.decidedByType,
    })),
  };
}

/**
 * How many rows `readPendingEvidenceJudgments` would put in `pending` for each project's
 * coordinator, counting that project's tasks only — exactly the rows the coordinator conversation
 * draws an evidence card for (`evidenceDecisionCardRows` on the web). This is the "Needs you"
 * badge's evidence source (`owner-decision-signal.ts`), keyed by project; the envelope and the
 * citations a card renders are not paid for. `readAt` is the read's clock, as it is there: it is
 * what a coordinator's hold is measured against.
 */
export async function countPendingEvidenceJudgments(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  coordinators: ReadonlyArray<{ projectId: string; session: { id: string; taskId: string | null } }>,
  readAt: Date = new Date(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (coordinators.length === 0) return counts;
  const coordinatorOf = new Map(coordinators.map((c) => [c.projectId, c.session]));
  const unanswered = await unansweredLatestEvidence(tx, ownerId, readAt, {
    projectIds: [...coordinatorOf.keys()],
  });
  for (const { task, latest, heldByCoordinator } of unanswered) {
    const projectId = task.projectId;
    const session = projectId == null ? undefined : coordinatorOf.get(projectId);
    if (projectId == null || session === undefined) continue;
    // The placement above, asked in the same order: a live standard to decide against, a reader
    // the door would take the decision from, and nobody else deciding it first.
    if ((await criterionStandingRefusal(tx, task, latest.evidence)) !== null) continue;
    const scope = { ownerId, taskId: task.id };
    if ((await decidingSessionDisqualification(tx, scope, session)) !== null) continue;
    if (heldByCoordinator) continue;
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many rows `readPendingEvidenceJudgments` would put in `pending` for the conversation each
 * dispatched task's owner card is drawn in — a task a session filed in no project, whose revision
 * that session has stopped holding — by that conversation (`ownerEvidenceCard`). The "Needs you"
 * badge's source for them (`owner-decision-signal.ts`), asked in the queue's own order: a live
 * standard, not held, and a decision the door would take in the dispatching session's name.
 *
 * `sessionIds` narrows the read to the cards those conversations could hold — tasks they filed, and
 * the tasks they are runs of (a card moves to the run when its dispatching session is in Trash) —
 * so a session row's summary, built on every publish, reads that and not the whole account.
 */
export async function countDispatchedEvidenceJudgments(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  readAt: Date = new Date(),
  sessionIds?: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sessionIds && sessionIds.length === 0) return counts;
  const runs = sessionIds
    ? await tx.session.findMany({
      where: { ownerId, id: { in: [...sessionIds] }, taskId: { not: null } },
      select: { taskId: true },
    })
    : [];
  const unanswered = await unansweredLatestEvidence(tx, ownerId, readAt, {
    dispatched: sessionIds
      ? { creatorSessionIds: sessionIds, taskIds: runs.flatMap((run) => (run.taskId ? [run.taskId] : [])) }
      : {},
  });
  for (const { task, latest, dispatching, heldByReviewer, ownerCard } of unanswered) {
    if (!dispatching || !ownerCard || heldByReviewer) continue;
    if ((await criterionStandingRefusal(tx, task, latest.evidence)) !== null) continue;
    const decider = { id: dispatching.id, taskId: dispatching.taskId };
    if ((await decidingSessionDisqualification(tx, { ownerId, taskId: task.id }, decider)) !== null) continue;
    counts.set(ownerCard.sessionId, (counts.get(ownerCard.sessionId) ?? 0) + 1);
  }
  return counts;
}
