import { TaskStatus } from '@prisma/client';
import type { Prisma as PrismaTypes } from '@prisma/client';
import {
  REQUIRES_INDEPENDENT_SESSION_ACTION,
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
 * WHY EACH ROW CARRIES A REASON RATHER THAN A FLAG
 * ------------------------------------------------
 * Same shape `criterionSatisfaction` settled on for the criterion side: a reader who is told only
 * "no" cannot act, so every row carries the criterion it is measured against, what each citation
 * resolved to when asked, what the submitter declared it did NOT establish, and — when this
 * particular reader may not answer — the disqualification and the action that would clear it. The
 * decider is meant to be able to decide from the row.
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
  independence: JudgmentIndependence;
}

/** The rail: the count and the oldest age, over the rows themselves. */
export interface PendingEvidenceJudgmentQueue {
  readAt: Date;
  /** The session these rows were read FOR — every `independence` below is about it. */
  decidingSessionId: string;
  count: number;
  /** The age of the oldest question, or null when there is none. */
  oldestAgeSeconds: number | null;
  pending: PendingEvidenceJudgment[];
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
 * Every question of this owner's that is open right now, oldest first, as one read.
 *
 * `take: 1` on the evidence is the whole of "the latest revision": a decision is bound to one
 * immutable version, so an older revision that was answered — or never was — is not what anybody
 * is being asked about. A task whose latest revision already carries a decision is not returned at
 * all, which is what makes an answered row disappear from every reader's next read rather than
 * from the one that happened to be listening.
 */
export async function readPendingEvidenceJudgments(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  decidingSession: { id: string; taskId: string | null },
  readAt: Date = new Date(),
): Promise<PendingEvidenceJudgmentQueue> {
  const tasks = await tx.task.findMany({
    where: {
      ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: { in: [...UNSETTLED] },
      completionEvidence: { some: {} },
    },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      completionEvidence: {
        orderBy: { revision: 'desc' },
        take: 1,
        select: {
          revision: true,
          submittedAt: true,
          evidence: true,
          decisions: { select: { id: true }, take: 1 },
        },
      },
    },
  });

  const pending: PendingEvidenceJudgment[] = [];
  for (const task of tasks) {
    const [latest] = task.completionEvidence;
    if (!latest || latest.decisions.length > 0) continue;
    const envelope = storedEnvelope(latest.evidence);
    const disqualification = await decidingSessionDisqualification(
      tx,
      { ownerId, taskId: task.id },
      decidingSession,
    );
    pending.push({
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
      independence: {
        independent: disqualification === null,
        disqualification,
        requiredAction: disqualification === null ? null : REQUIRES_INDEPENDENT_SESSION_ACTION,
      },
    });
  }

  // Oldest first, and by task id where two were submitted in the same millisecond: the rail leads
  // with the age of the oldest question, so the order it leads with has to be the order it shows.
  pending.sort((left, right) => (
    left.submittedAt.getTime() - right.submittedAt.getTime()
      || left.taskId.localeCompare(right.taskId)
  ));

  return {
    readAt,
    decidingSessionId: decidingSession.id,
    count: pending.length,
    oldestAgeSeconds: pending.length === 0 ? null : pending[0].ageSeconds,
    pending,
  };
}
