import { Prisma } from '@prisma/client';

import { completionEvidenceWakeKeySql } from './completion-input';
import { projectCoordinatorCanTake } from './project-open-item';

/**
 * The owner's item about evidence its coordinator has not decided (`EVIDENCE_UNDECIDED`, migration 1110).
 *
 * WHY
 * ===
 * A project task judged by EVIDENCE_JUDGMENT has each evidence revision delivered to the project's
 * coordinator to decide (`CompletionEvidenceProducer`), and while the coordinator holds it, or waits
 * to be handed it (`coordinator-evidence-queue.ts`), the owner is not asked. When the coordinator never
 * decides — it is paused with no end, the turn sits unread, or it simply did not get to it — the task
 * stays OPEN and nobody is told. On production a revision submitted on 2026-11-10 sat undecided for
 * 8 days and was found only because an unrelated landing conflict woke the task.
 *
 * THE RULE
 * ========
 * The coordinator is still asked first: nothing about the evidence delivery changes. And the clock
 * keeps the owner's rule for every exception item (decision of 2026-10-08, contract revision 13 §4.6,
 * `escalatesAt`): once a coordinator that is still live has taken the work up, no timer hands it to
 * the owner, and while the coordinator can still take it, the work waits for it with no deadline. So
 * the escalation clock (`ProjectOpenItemEscalationService`) opens ONE owner item per waiting revision
 * only when
 *
 *  - the revision went the coordinator-first way: its project's coordinator switch is on, or a
 *    delivery of it was attempted in this project (a project that was never Automatic has the owner's
 *    evidence card from the start, so there is no coordinator to have failed to decide);
 *  - the revision is its task's latest, carries no decision, and the task is still OPEN or IN_PROGRESS
 *    under EVIDENCE_JUDGMENT;
 *  - the project's coordinator can NOT take a turn now: it is switched off, has no conversation, or
 *    that conversation is ended, filed, trashed, down with no retry pending, or has a cancel requested.
 *    "Can take" is `projectCoordinatorCanTake` — the very predicate the open-item clock uses
 *    (`openItemCoordinatorCanTake`, commit b27c6bfcfc) — plus the cancel the evidence delivery itself
 *    refuses on (`CoordinatorDeliveryService`). A live coordinator, or one parked on a retry it armed,
 *    holds the revision whether it has taken the delivery up or not;
 *  - and the project's `exceptionEscalationSeconds` have passed since the last delivery of this
 *    revision a coordinator took up (its turn's `delivered_at`), or since submission when no delivery
 *    was ever taken up.
 *
 * An item already open stays the owner's if the coordinator comes back; deciding it, from either side,
 * ends it.
 *
 * The item is OWNER / ESCALATED from birth (it is never delivered to the coordinator: the coordinator
 * already had the evidence), keyed `EV:<evidenceId>`, so a tick a minute opens it once, and a revision
 * whose item was settled is never opened again. Its Review opens the task's evidence.
 *
 * WHAT ENDS IT
 * ============
 * The decision door writes `DECIDED` in the transaction that records a CONFIRM or a SEND_BACK, and the
 * submission door writes `REVISED` when a newer revision is recorded. `openItemOwed` spells the same
 * facts (`evidenceUndecidedOwed`), so the escalation tick's backstop closes one an edge missed, and a
 * task that was cancelled, failed, finished another way or moved out of the project ends `TASK_CLOSED`.
 */
export const EVIDENCE_UNDECIDED_KIND = 'EVIDENCE_UNDECIDED';

/** One item per evidence revision. */
export function evidenceUndecidedDedupeKey(evidenceId: string): string {
  return `EV:${evidenceId}`;
}

/** The title an item is written with: the kind's words and the task it is about. */
export const EVIDENCE_UNDECIDED_TITLE = 'Evidence waiting for a decision';

/**
 * Why the item was opened. Absent (the escalation tick's own): the coordinator could not take the
 * revision and the window ran out. The orphan sweep opens the other two (`ProjectOrphanSweepService`),
 * the window after a notice about the revision was written and nothing moved it:
 *  - `UNDECIDABLE`: the decision door refuses every answer to it (`reason`), so only a new revision
 *    clears it, and no live coordinator holding it changes that;
 *  - `UNDELIVERED`: it was never handed to anyone to decide.
 */
export type EvidenceUndecidedRoute = 'UNDECIDABLE' | 'UNDELIVERED';

/** How the item's `payload` reads (written by the escalation tick, or by the orphan sweep). */
export interface EvidenceUndecidedPayload {
  evidenceId: string;
  revision: string;
  submittedAt: string;
  windowSeconds: number;
  coordinatorSessionId: string | null;
  route: EvidenceUndecidedRoute | null;
  /** For UNDECIDABLE: the decision door's reason. */
  reason: string | null;
  /** For the sweep's routes: when the first notice about the revision was written. */
  noticeAt: string | null;
}

export function evidenceUndecidedPayloadOf(payload: unknown): EvidenceUndecidedPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.evidenceId !== 'string' || typeof value.submittedAt !== 'string') return null;
  return {
    evidenceId: value.evidenceId,
    revision: typeof value.revision === 'string' ? value.revision : String(value.revision ?? ''),
    submittedAt: value.submittedAt,
    windowSeconds: typeof value.windowSeconds === 'number' ? value.windowSeconds : 0,
    coordinatorSessionId: typeof value.coordinatorSessionId === 'string' ? value.coordinatorSessionId : null,
    route: value.route === 'UNDECIDABLE' || value.route === 'UNDELIVERED' ? value.route : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    noticeAt: typeof value.noticeAt === 'string' ? value.noticeAt : null,
  };
}

/** `3 days`, `5 hours`, `12 minutes`: how long ago, in the words the detail line uses. */
export function spanInWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return unit(hours, 'hour');
  return unit(Math.floor(hours / 24), 'day');
}

/**
 * The line under the item's title: which revision, how long ago it was submitted, and that the
 * coordinator has not decided it. Counted at read time, so the age is the age now.
 */
export function evidenceUndecidedDetailLine(payload: unknown, now: Date = new Date()): string {
  const facts = evidenceUndecidedPayloadOf(payload);
  if (!facts) return 'This evidence is waiting for a decision, and the coordinator has not decided it.';
  const submitted = Date.parse(facts.submittedAt);
  const ago = Number.isFinite(submitted) ? `${spanInWords(now.getTime() - submitted)} ago` : 'a while ago';
  const revision = facts.revision ? `Revision ${facts.revision}` : 'This evidence';
  const noticed = facts.noticeAt ? Date.parse(facts.noticeAt) : Number.NaN;
  const reported = Number.isFinite(noticed) ? `It was reported ${spanInWords(now.getTime() - noticed)} ago` : 'It was reported';
  if (facts.route === 'UNDECIDABLE') {
    return `${revision} was submitted ${ago} and cannot be decided`
      + (facts.reason ? `: ${facts.reason}` : '')
      + `. ${reported} and nobody has submitted it again; restart the task so a run submits a new revision.`;
  }
  if (facts.route === 'UNDELIVERED') {
    return `${revision} was submitted ${ago} and was never handed to anyone to decide. ${reported} and nobody has decided it.`;
  }
  return `${revision} was submitted ${ago}, and the coordinator has not decided it.`;
}

/**
 * Whether an `EVIDENCE_UNDECIDED` item is still owed, as SQL over the item aliased `alias`: the
 * revision it names is still its task's latest, has no decision, and the task is still waiting on it
 * in the same project. Parameter-free, like the rest of `openItemOwed`.
 */
export function evidenceUndecidedOwed(alias: string): Prisma.Sql {
  const item = Prisma.raw(`"${alias}"`);
  return Prisma.sql`EXISTS (
        SELECT 1 FROM "task_completion_evidence" owed_evidence
          JOIN "task" owed_task ON owed_task."id" = owed_evidence."task_id"
         WHERE owed_evidence."id" = (${item}."payload"->>'evidenceId')::uuid
           AND owed_task."id" = ${item}."task_id"
           AND owed_task."project_id" = ${item}."project_id"
           AND owed_task."completion_criterion" = 'EVIDENCE_JUDGMENT'
           AND owed_task."status" IN ('OPEN', 'IN_PROGRESS')
           AND NOT EXISTS (
             SELECT 1 FROM "task_evidence_decision" owed_decision
              WHERE owed_decision."evidence_id" = owed_evidence."id")
           AND NOT EXISTS (
             SELECT 1 FROM "task_completion_evidence" owed_newer
              WHERE owed_newer."task_id" = owed_evidence."task_id"
                AND owed_newer."revision" > owed_evidence."revision"))`;
}

/**
 * The backstop's ending for an item `evidenceUndecidedOwed` says nobody owes, over the item aliased
 * `alias`: decided, replaced, or the task moved on. The same facts the two edges write.
 */
export function evidenceUndecidedEnding(alias: string): Prisma.Sql {
  const item = Prisma.raw(`"${alias}"`);
  return Prisma.sql`CASE
      WHEN EXISTS (
        SELECT 1 FROM "task_evidence_decision" ended_decision
         WHERE ended_decision."evidence_id" = (${item}."payload"->>'evidenceId')::uuid) THEN 'DECIDED'
      WHEN EXISTS (
        SELECT 1 FROM "task_completion_evidence" ended_evidence
          JOIN "task_completion_evidence" ended_newer
            ON ended_newer."task_id" = ended_evidence."task_id"
           AND ended_newer."revision" > ended_evidence."revision"
         WHERE ended_evidence."id" = (${item}."payload"->>'evidenceId')::uuid) THEN 'REVISED'
      ELSE 'TASK_CLOSED' END`;
}

/** Who wrote an edge's ending, as every hand-ended row records it. */
export interface EvidenceUndecidedEndedBy {
  resolvedBy: 'USER' | 'COORDINATOR' | 'PLATFORM';
  resolvedByUserId?: string | null;
  resolvedBySessionId?: string | null;
}

/**
 * The decision door's edge: the revision was decided (CONFIRM or SEND_BACK), so the owner's item about
 * it ends `DECIDED`. Called in the transaction that wrote the decision.
 */
export async function resolveUndecidedEvidenceOnDecision(
  tx: Pick<Prisma.TransactionClient, 'projectOpenItem'>,
  taskId: string,
  evidenceId: string,
  by: EvidenceUndecidedEndedBy,
): Promise<number> {
  const closed = await tx.projectOpenItem.updateMany({
    where: {
      taskId,
      kind: EVIDENCE_UNDECIDED_KIND,
      state: 'OPEN',
      dedupeKey: evidenceUndecidedDedupeKey(evidenceId),
    },
    data: {
      state: 'RESOLVED',
      resolution: 'DECIDED',
      resolvedBy: by.resolvedBy,
      resolvedByUserId: by.resolvedByUserId ?? null,
      resolvedBySessionId: by.resolvedBySessionId ?? null,
      resolvedAt: new Date(),
    },
  });
  return closed.count;
}

/**
 * The submission door's edge: a newer revision was recorded, so every open item about an older one
 * of this task ends `REVISED` (SUPERSEDED: the new revision is what the coordinator is asked about
 * now, and it gets an item of its own if it, too, waits out the window). Called in the transaction
 * that wrote the new revision.
 */
export async function resolveUndecidedEvidenceOnRevision(
  tx: Pick<Prisma.TransactionClient, 'projectOpenItem'>,
  taskId: string,
  newEvidenceId: string,
): Promise<number> {
  const closed = await tx.projectOpenItem.updateMany({
    where: {
      taskId,
      kind: EVIDENCE_UNDECIDED_KIND,
      state: 'OPEN',
      dedupeKey: { not: evidenceUndecidedDedupeKey(newEvidenceId) },
    },
    data: { state: 'SUPERSEDED', resolution: 'REVISED', resolvedBy: 'PLATFORM', resolvedAt: new Date() },
  });
  return closed.count;
}

/**
 * The escalation clock's statement: open one item per waiting revision (THE RULE, above), and say which
 * ones it opened. One `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`, its own compare-and-set,
 * like X-E5's alarm: two replicas ticking together open each item once, and a key ever written is not
 * opened again (the NOT EXISTS over every state).
 *
 * The item's foreign keys check its project (rank 40) and its task (50) FOR KEY SHARE. As X-E5's alarm
 * does, the statement takes those rows itself first, in rank order and SKIP LOCKED, so a task held FOR
 * UPDATE by a door (the decision door among them) is left to the next tick rather than waited for; the
 * caller runs it under a short `lock_timeout` for what SKIP LOCKED does not cover.
 */
export function openUndecidedEvidenceStatement(): Prisma.Sql {
  // Fixed strings this module owns, inlined as literals rather than bound: no parameter for
  // PostgreSQL to infer a type for inside the title's concatenation.
  const kind = Prisma.raw(`'${EVIDENCE_UNDECIDED_KIND}'`);
  const title = Prisma.raw(`'${EVIDENCE_UNDECIDED_TITLE}: '`);
  // The revision's delivery keys: its own, and the one a confirmed move hands it into this project under.
  const ownKey = completionEvidenceWakeKeySql(Prisma.sql`t."id"`, 'e');
  const handedKey = completionEvidenceWakeKeySql(Prisma.sql`t."id"`, 'e', Prisma.sql`t."project_id"`);
  return Prisma.sql`
      WITH due AS MATERIALIZED (
        SELECT e."id" AS "evidenceId", t."id" AS "taskId", t."project_id" AS "projectId"
          FROM "task_completion_evidence" e
          JOIN "task" t ON t."id" = e."task_id" AND t."owner_id" = e."owner_id"
          JOIN "project" p ON p."id" = t."project_id" AND p."owner_id" = t."owner_id"
         WHERE p."status" = 'OPEN'
           AND t."completion_criterion" = 'EVIDENCE_JUDGMENT'
           AND t."status" IN ('OPEN', 'IN_PROGRESS')
           -- The coordinator-first way: Automatic now, or this revision was put to a coordinator here.
           AND (p."coordinator_enabled" = true OR EXISTS (
             SELECT 1 FROM "project_coordinator_wake" asked
              WHERE asked."project_id" = t."project_id"
                AND asked."idempotency_key" IN (${ownKey}, ${handedKey})))
           -- No timer while the coordinator can still take its turn (the open-item clock's rule).
           AND NOT (${projectCoordinatorCanTake(Prisma.sql`t."project_id"`)}
                    AND NOT EXISTS (
                      SELECT 1 FROM "project" cancelled_project
                        JOIN "session" cancelled ON cancelled."id" = cancelled_project."coordinator_session_id"
                       WHERE cancelled_project."id" = t."project_id"
                         AND cancelled."cancel_requested_at" IS NOT NULL))
           -- The window, from the last delivery of this revision a coordinator took up, else from
           -- submission.
           AND COALESCE((
                 SELECT max(taken."delivered_at" AT TIME ZONE 'UTC')
                   FROM "project_coordinator_wake" delivered
                   JOIN "conversation_turn" taken
                     ON taken."session_id" = delivered."session_id"
                    AND taken."client_turn_id" = delivered."delivery"->>'clientTurnId'
                  WHERE delivered."project_id" = t."project_id"
                    AND delivered."status" = 'DELIVERED'
                    AND delivered."idempotency_key" IN (${ownKey}, ${handedKey})
                    AND taken."delivered_at" IS NOT NULL),
               e."submitted_at" AT TIME ZONE 'UTC')
               + (p."exception_escalation_seconds" * interval '1 second') <= now()
           AND NOT EXISTS (
             SELECT 1 FROM "task_evidence_decision" d WHERE d."evidence_id" = e."id")
           AND NOT EXISTS (
             SELECT 1 FROM "task_completion_evidence" newer
              WHERE newer."task_id" = e."task_id" AND newer."revision" > e."revision")
           AND NOT EXISTS (
             SELECT 1 FROM "project_open_item" seen
              WHERE seen."project_id" = t."project_id"
                AND seen."dedupe_key" = 'EV:' || e."id"::text)),
      held AS MATERIALIZED (
        SELECT 'project' AS "parent", held_project."id"
          FROM (SELECT pr."id" FROM "project" pr
                 WHERE pr."id" IN (SELECT "projectId" FROM due)
                 ORDER BY pr."id"
                   FOR KEY SHARE SKIP LOCKED) held_project
        UNION ALL
        SELECT 'task', held_task."id"
          FROM (SELECT tk."id" FROM "task" tk
                 WHERE tk."id" IN (SELECT "taskId" FROM due)
                 ORDER BY tk."id"
                   FOR KEY SHARE SKIP LOCKED) held_task)
      INSERT INTO "project_open_item" (
        "id", "project_id", "owner_id", "kind", "assignee", "assignee_reason",
        "task_id", "session_id", "dedupe_key", "title", "payload",
        "waiting_since", "assigned_at", "escalated_at", "escalate_at", "remind_at", "updated_at")
      SELECT gen_random_uuid(), t."project_id", t."owner_id", ${kind},
             'OWNER', 'ESCALATED',
             t."id", e."source_session_id", 'EV:' || e."id"::text,
             ${title} || t."title",
             jsonb_build_object(
               'evidenceId', e."id"::text,
               'revision', e."revision"::text,
               'submittedAt', to_char(e."submitted_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'windowSeconds', p."exception_escalation_seconds",
               'coordinatorSessionId', p."coordinator_session_id"::text),
             (e."submitted_at" AT TIME ZONE 'UTC'), now(), now(), NULL, NULL, now()
        FROM due
        JOIN "task_completion_evidence" e ON e."id" = due."evidenceId"
        JOIN "task" t ON t."id" = due."taskId"
        JOIN "project" p ON p."id" = due."projectId"
       WHERE due."projectId" = ANY(ARRAY(SELECT "id" FROM held WHERE "parent" = 'project'))
         AND due."taskId" = ANY(ARRAY(SELECT "id" FROM held WHERE "parent" = 'task'))
       ORDER BY e."id"
      ON CONFLICT ("project_id", "dedupe_key") WHERE "state" = 'OPEN' DO NOTHING
      RETURNING "id" AS "itemId", "project_id" AS "projectId", "owner_id" AS "ownerId"`;
}
