import { Prisma } from '@prisma/client';
import type {
  IntegrationJobKind,
  IntegrationTimelineEntry,
  IntegrationTimelineFact,
  IntegrationTimelineSection,
  SessionLandingTimeline,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { AUTOMATIC_MERGE_ATTEMPTS } from './project-promotion';
import {
  automaticAttemptText,
  claimedText,
  confirmationText,
  fixesItemText,
  handlingText,
  promotionStateText,
  readSubjectEvents,
  resultText,
  retryText,
  skippedCheckText,
  type IntegrationTimelineActorInput,
} from './project-integration-event';

/**
 * The landing page's ordered timeline (docs/project-integration-line-contract.md §2.9 LS2/LS4;
 * mockups v4 §05): one section per attempt of the subject — a task landing's `Generation N`, or a
 * merge round's `Merge check · N` / `Merge to main · N` — each holding the facts that attempt
 * recorded (the event ledger) and the lines derived at read time from the rows that kept the
 * decisions.
 *
 * WHAT IS DERIVED AND WHAT IS STORED. Stored: every fact a door decided and wrote in its own
 * transaction (`project_integration_job_event`). Derived, here and nowhere copied: a rerun's
 * requester and reason (`retry_*`), an item being handled and having been handled (`handling_*`),
 * the owner's or Automatic's confirmation (the promotion row), the skipped merge check (0393's
 * columns), a timeout the job row alone can still explain (J-T9), the Nth automatic attempt
 * (`confirmed_automatically` READY landings, counted as `AUTOMATIC_MERGE_ATTEMPTS` counts them),
 * the promotion's current state (0409's `blocked_reason` is NOT replayed as history — a recheck
 * clears it, and a past block is read off the attempt row that recorded it), and the task a fix
 * was filed as (`task.fixes_open_item_id`).
 *
 * ORDER. Within a section: by claim, then by round, then by the instant the fact happened and the
 * ledger's own sequence (two facts one transaction appends can share an instant). Across sections:
 * by when the attempt was queued, oldest first — the order the page draws.
 *
 * BOUNDED. `MAX_TIMELINE_SECTIONS` attempts and `MAX_ENTRIES_PER_SECTION` facts per attempt; a
 * subject with more reports `truncated: true` rather than making one page read a queue's whole
 * history. Read-only: nothing here writes, and nothing here touches a session or `run_event`.
 */

/** How many attempts of one subject the timeline lists (the newest ones when there are more). */
export const MAX_TIMELINE_SECTIONS = 40;
/** How many facts one attempt's section lists. */
export const MAX_ENTRIES_PER_SECTION = 200;

/** The subject columns the timeline needs, read from `project_landing`. */
export interface LandingTimelineSubject {
  id: string;
  projectId: string;
  ownerId: string;
  subject: string;
  taskId: string | null;
  promotionId: string | null;
}

/** The job columns the timeline reads; a reader that already has them may pass them in. */
const TIMELINE_JOB_COLUMNS = {
  id: true,
  kind: true,
  generation: true,
  state: true,
  createdAt: true,
  claimedAt: true,
  finishedAt: true,
  claimGeneration: true,
  retryOfJobId: true,
  retryFailureClass: true,
  retryReason: true,
  retryRequestedBySessionId: true,
  retryRequestedByUserId: true,
  skipMergeCheck: true,
  skipReason: true,
  skipApprovedByUserId: true,
  skipApprovalId: true,
  errorCode: true,
  errorDetail: true,
  confirmedAutomatically: true,
  sourceFullyApplied: true,
  landedSha: true,
  targetShaBefore: true,
  runnerId: true,
  targetRef: true,
  upstreamRef: true,
  sourceRef: true,
  phase: true,
  round: true,
  promotionId: true,
  taskId: true,
} as const;

type TimelineJob = Prisma.ProjectIntegrationJobGetPayload<{ select: typeof TIMELINE_JOB_COLUMNS }>;

/** The section heading, written by the server: one per attempt of the subject, numbered by its
 *  order among the subject's attempts of that kind (so a superseded candidate's check and its
 *  replacement's check are `Merge check · 1` and `Merge check · 2`, never two of one number). */
export function sectionTitle(kind: string, ordinal: number): string {
  if (kind === 'CHECK_PROMOTION') return `Merge check · ${ordinal}`;
  if (kind === 'LAND_PROMOTION') return `Merge to main · ${ordinal}`;
  return `Generation ${ordinal}`;
}

/**
 * Read one subject's whole timeline. The caller has established that the subject is the reader's;
 * this reads the attempts, their facts, the items they handled and the candidate they are about.
 */
export async function readLandingTimeline(
  prisma: Pick<PrismaService, '$queryRaw' | 'projectIntegrationJob' | 'projectOpenItem'
    | 'projectPromotion' | 'task' | 'runner'>,
  subject: LandingTimelineSubject,
): Promise<SessionLandingTimeline<Date>> {
  const all = await prisma.projectIntegrationJob.findMany({
    where: { landingId: subject.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: TIMELINE_JOB_COLUMNS,
  });
  const truncated = all.length > MAX_TIMELINE_SECTIONS;
  const jobs = truncated ? all.slice(-MAX_TIMELINE_SECTIONS) : all;
  const jobIds = jobs.map((job) => job.id);

  // Every candidate the subject's attempts are about: a round holds the candidates it superseded,
  // and a task segment's later candidates join it, so one landing row's `promotion_id` is only the
  // first of them.
  const promotionIds = [...new Set([
    ...jobs.map((job) => job.promotionId),
    subject.promotionId,
  ].filter((id): id is string => id != null))];

  const [events, handledItems, promotions, task] = await Promise.all([
    readSubjectEvents(prisma, jobIds, MAX_ENTRIES_PER_SECTION),
    jobIds.length > 0
      ? prisma.projectOpenItem.findMany({
        where: { ownerId: subject.ownerId, projectId: subject.projectId, handlingJobId: { in: jobIds } },
        select: {
          id: true, kind: true, state: true, resolution: true, handlingJobId: true,
          handlingSessionId: true, handlingUserId: true, handlingReason: true,
          handlingStartedAt: true, resolvedAt: true,
        },
      })
      : Promise.resolve([]),
    promotionIds.length > 0
      ? prisma.projectPromotion.findMany({
        where: { id: { in: promotionIds } },
        select: { id: true, state: true, blockedReason: true, confirmedByUserId: true,
          confirmedAutomatically: true, confirmedAt: true, upstreamRef: true },
      })
      : Promise.resolve([]),
    subject.subject === 'TASK' && subject.taskId
      ? prisma.task.findFirst({
        where: { id: subject.taskId },
        select: { fixesOpenItemId: true },
      })
      : Promise.resolve(null),
  ]);
  const promotionById = new Map(promotions.map((row) => [row.id, row]));
  // The round's CURRENT candidate: the one the newest attempt names, else the one the subject
  // opened with. Only its state is the round's; an earlier candidate's is history on its attempts.
  const currentPromotion = (jobs.at(-1)?.promotionId
    ? promotionById.get(jobs.at(-1)!.promotionId!)
    : null) ?? (subject.promotionId ? promotionById.get(subject.promotionId) ?? null : null);

  const automaticAttempts = await readAutomaticAttempts(prisma, jobs);

  // The attempt each candidate's CURRENT owner confirmation put on the queue: its newest landing
  // that was not the setting's.
  const newestOwnerLandingByPromotion = new Map<string, string>();
  for (const job of jobs) {
    if (job.kind === 'LAND_PROMOTION' && !job.confirmedAutomatically && job.promotionId) {
      newestOwnerLandingByPromotion.set(job.promotionId, job.id);
    }
  }

  const itemsByJob = new Map<string, typeof handledItems>();
  for (const item of handledItems) {
    if (!item.handlingJobId) continue;
    const list = itemsByJob.get(item.handlingJobId) ?? [];
    list.push(item);
    itemsByJob.set(item.handlingJobId, list);
  }

  // The runner a claim line names, read once for the attempts that need it (a claim whose event is
  // missing is derived below; the stored ones already carry their name).
  const runnerIds = [...new Set(jobs.map((job) => job.runnerId).filter((id): id is string => id != null))];
  const runnerNames = new Map<string, string>();
  if (runnerIds.length > 0) {
    const rows = await prisma.runner.findMany({ where: { id: { in: runnerIds } }, select: { id: true, name: true } });
    for (const row of rows) runnerNames.set(row.id, row.name);
  }

  // Section numbers are their ORDER WITHIN THE SUBJECT, not the job's own generation: a round can
  // hold a superseded candidate and the candidate that replaced it, both generation 1 of their own
  // candidate, and two sections titled `Merge check · 1` would be one heading for two attempts.
  // The count starts at the subject's FIRST attempt, not its first listed one: a truncated subject
  // lists only its newest attempts, and the attempts cut off ahead of them still count, so the
  // newest of 45 attempts is `Generation 45`, never a renumbered `Generation 40`.
  const sectionOrdinals = new Map<string, number>();
  for (const job of all.slice(0, all.length - jobs.length)) {
    sectionOrdinals.set(job.kind, (sectionOrdinals.get(job.kind) ?? 0) + 1);
  }

  const sections: IntegrationTimelineSection<Date>[] = jobs.map((job) => {
    const entries: IntegrationTimelineEntry<Date>[] = [];
    const claim = Number(job.claimGeneration);
    const promotion = job.promotionId ? promotionById.get(job.promotionId) ?? null : null;
    // LS4: the rerun's requester and reason are read off the generation's own columns.
    if (job.retryOfJobId) {
      const requestedBy = job.retryRequestedBySessionId ? 'COORDINATOR'
        : job.retryRequestedByUserId ? 'OWNER' : null;
      entries.push(derivedEntry({
        kind: 'RETRY',
        at: job.createdAt,
        claim: 0,
        actor: requestedBy === 'COORDINATOR'
          ? { type: 'COORDINATOR', sessionId: job.retryRequestedBySessionId }
          : requestedBy === 'OWNER' ? { type: 'OWNER', userId: job.retryRequestedByUserId } : null,
        reason: job.retryReason,
        data: {
          retryOfJobId: job.retryOfJobId,
          failureClass: job.retryFailureClass,
          reason: job.retryReason,
        },
        text: retryText({ requestedBy, reason: job.retryReason }),
      }));
    }
    // 0393: this generation ran no merge check, and the row that says so is the record.
    if (job.skipMergeCheck) {
      entries.push(derivedEntry({
        kind: 'SKIPPED_CHECK',
        at: job.createdAt,
        claim: 0,
        actor: job.skipApprovedByUserId ? { type: 'OWNER', userId: job.skipApprovedByUserId } : null,
        reason: job.skipReason,
        data: {
          reason: job.skipReason,
          approvedByUserId: job.skipApprovedByUserId,
          approvalId: job.skipApprovalId,
        },
        text: skippedCheckText(job.skipReason),
      }));
    }
    // 0368: the item this generation took over, while it runs or after it was handled.
    for (const item of itemsByJob.get(job.id) ?? []) {
      const handled = item.state !== 'OPEN';
      entries.push(derivedEntry({
        kind: 'HANDLING',
        // The generation that took the item over — its claim, not the enqueue — so the line is
        // drawn with that attempt rather than ahead of it.
        at: job.claimedAt ?? (handled ? item.resolvedAt : item.handlingStartedAt) ?? job.createdAt,
        claim: claim,
        actor: item.handlingSessionId
          ? { type: 'COORDINATOR', sessionId: item.handlingSessionId }
          : item.handlingUserId ? { type: 'OWNER', userId: item.handlingUserId } : null,
        reason: item.handlingReason,
        data: {
          itemId: item.id,
          itemKind: item.kind,
          itemState: item.state,
          resolution: item.resolution,
        },
        text: handlingText(handled ? 'CLOSED' : 'OPEN'),
      }));
    }
    entries.push(...(events.get(job.id) ?? []));
    // J-T11 / §2.9 LS2: a claim whose backfill failed (the INSERT after the claim statement is
    // best-effort) still has its committed claim on the row — but only while the attempt is still
    // RUNNING under it. Three doors move `claim_generation` without anybody claiming: the J-T9
    // timeout end, the J-T10 abandon and the J-T11 release; a terminal or QUEUED row that names
    // claim N did not take a claim N, and drawing one would invent an attempt. The number is read
    // from the row, and the row is only believed while it says an attempt is under way.
    if (claim > 0 && job.state === 'RUNNING'
        && !entries.some((entry) => (entry.kind === 'CLAIMED' || entry.kind === 'TAKEN_OVER')
          && entry.claim === claim)) {
      const runnerName = job.runnerId ? runnerNames.get(job.runnerId) ?? null : null;
      entries.push(derivedEntry({
        kind: 'CLAIMED',
        at: job.claimedAt ?? job.createdAt,
        claim,
        phase: job.phase,
        actor: { type: 'RUNNER' },
        data: { claimGeneration: claim, runnerId: job.runnerId, runnerName },
        text: claimedText(claim, runnerName),
      }));
    }
    // J-T9's timeout end, for a job whose row says it timed out and that has no `TIMED_OUT` event
    // (a row written before the ledger, or an end this build does not record). The two causes the
    // row cannot tell apart are written as events; this is the ordinary end derived from the row.
    const timedOut = timeoutDetail(job);
    if (timedOut && !entries.some((entry) => entry.kind === 'TIMED_OUT')) {
      entries.push(derivedEntry({
        kind: 'TIMED_OUT',
        at: job.finishedAt ?? job.createdAt,
        claim,
        round: job.round ?? null,
        phase: job.phase,
        actor: { type: 'PLATFORM' },
        data: timedOut as unknown as Record<string, unknown>,
        text: `Timed out · no report${timedOut.limitSeconds != null
          ? ` (limit ${Math.round(timedOut.limitSeconds / 60)}m)` : ''}`,
      }));
    }
    // A terminal attempt whose RESULT line is missing (written before the ledger existed) is still
    // drawn from the job row — 0410's measurement is the row's, which is what the line turns on. A
    // QUEUED generation a stop ended already has its own CANCELLED line, and the row's state says
    // the same thing; it is not drawn twice.
    if (isTerminal(job.state) && !entries.some((entry) => entry.kind === 'RESULT' || entry.kind === 'CANCELLED')) {
      entries.push(derivedEntry({
        kind: 'RESULT_FALLBACK',
        at: job.finishedAt ?? job.createdAt,
        claim,
        round: job.round ?? null,
        phase: job.phase,
        data: { state: job.state, errorCode: job.errorCode },
        text: resultText({
          state: job.state,
          phase: job.phase,
          targetRef: job.targetRef,
          upstreamRef: job.upstreamRef,
          landedSha: job.landedSha,
          targetShaBefore: job.targetShaBefore,
          // 0410: the runner's measurement, read off the row — a fully applied branch said so.
          sourceFullyApplied: job.sourceFullyApplied,
          errorCode: job.errorCode,
        }),
      }));
    }
    // The confirmation each merge attempt went out under (the candidate's own columns, LS4). An
    // automatic attempt is one the setting confirmed — the job's own flag says so, and it is
    // placed where that attempt was queued. The owner's press is the candidate's CURRENT
    // confirmation, drawn once, on the newest attempt it put on the queue; the candidate keeps
    // only the latest, so an earlier owner confirmation is not reconstructed as if it still held.
    if (job.kind === 'LAND_PROMOTION' && job.promotionId === promotion?.id) {
      if (job.confirmedAutomatically) {
        entries.push(derivedEntry({
          kind: 'CONFIRMATION',
          at: job.createdAt,
          claim: 0,
          actor: { type: 'AUTOMATIC' },
          data: { promotionId: promotion.id, confirmedAutomatically: true },
          text: confirmationText({ automatic: true, targetRef: job.upstreamRef }),
        }));
      } else if (promotion.confirmedByUserId && promotion.confirmedAt
          && job.id === newestOwnerLandingByPromotion.get(promotion.id)) {
        entries.push(derivedEntry({
          kind: 'CONFIRMATION',
          at: promotion.confirmedAt,
          claim: 0,
          actor: { type: 'OWNER', userId: promotion.confirmedByUserId },
          data: {
            promotionId: promotion.id,
            confirmedByUserId: promotion.confirmedByUserId,
            confirmedAutomatically: false,
            confirmedAt: promotion.confirmedAt.toISOString(),
          },
          text: confirmationText({ automatic: false, targetRef: job.upstreamRef }),
        }));
      }
    }
    // The Nth automatic attempt, derived from the candidate's own automatic landings and written
    // ONLY in the merge round's timeline (owner decision 2026-10-19).
    const attempt = automaticAttempts.get(job.id);
    if (job.kind === 'LAND_PROMOTION' && attempt != null) {
      entries.push(derivedEntry({
        kind: 'AUTOMATIC_ATTEMPT',
        at: job.createdAt,
        claim: 0,
        actor: { type: 'AUTOMATIC' },
        data: { attempt: attempt.attempt, limit: attempt.limit, automatic: true },
        text: automaticAttemptText(attempt.attempt, attempt.limit),
      }));
    }
    entries.sort(compareEntries);
    const ordinal = (sectionOrdinals.get(job.kind) ?? 0) + 1;
    sectionOrdinals.set(job.kind, ordinal);
    return {
      title: sectionTitle(job.kind, ordinal),
      jobId: job.id,
      kind: job.kind as IntegrationJobKind,
      generation: ordinal,
      state: job.state,
      entries,
    };
  });

  const facts: IntegrationTimelineFact[] = [];
  // 0379: this task was filed to fix an exception, which is what its segment is about.
  if (task?.fixesOpenItemId) {
    facts.push({
      kind: 'FIX_TASK',
      text: fixesItemText(),
      data: { openItemId: task.fixesOpenItemId, taskId: subject.taskId },
    });
  }
  // The round's current state; 0409's reason is the candidate's NOW and never replayed as history.
  if (currentPromotion && subject.subject === 'PROMOTION') {
    facts.push({
      kind: 'PROMOTION_STATE',
      text: promotionStateText(currentPromotion.state),
      data: {
        promotionId: currentPromotion.id,
        state: currentPromotion.state,
        blockedReason: currentPromotion.blockedReason,
      },
    });
  }
  return { sections, facts, truncated };
}

/** A line derived at read time: no event row, and the flag says so. */
function derivedEntry(input: {
  kind: IntegrationTimelineEntry<Date>['kind'];
  at: Date;
  claim: number;
  round?: number | null;
  phase?: string | null;
  actor?: IntegrationTimelineActorInput | null;
  reason?: string | null;
  data?: Record<string, unknown> | null;
  text: string;
}): IntegrationTimelineEntry<Date> {
  return {
    id: null,
    kind: input.kind,
    at: input.at,
    claim: input.claim,
    round: input.round ?? null,
    check: null,
    phase: (input.phase ?? null) as IntegrationTimelineEntry<Date>['phase'],
    step: null,
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    data: input.data ?? null,
    text: input.text,
    derived: true,
  };
}

/** Claim, then round, then the instant, then the ledger's sequence — the page's order within a
 *  section. A derived line sorts by its own instant; two facts one transaction wrote share that
 *  instant, and `seq` is what tells them apart. */
function compareEntries(left: IntegrationTimelineEntry<Date>, right: IntegrationTimelineEntry<Date>): number {
  if (left.claim !== right.claim) return left.claim - right.claim;
  const leftRound = left.round ?? 0;
  const rightRound = right.round ?? 0;
  if (leftRound !== rightRound) return leftRound - rightRound;
  if (left.at.getTime() !== right.at.getTime()) return left.at.getTime() - right.at.getTime();
  return (left.seq ?? 0) - (right.seq ?? 0);
}

function isTerminal(state: string): boolean {
  return ['LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY', 'CONFLICT', 'CHECK_FAILED',
    'ERROR', 'CANCELLED', 'SUPERSEDED'].includes(state);
}

/** J-T9's own shape on the row: an ERROR whose detail carries a limit and a last report. */
function timeoutDetail(job: TimelineJob): {
  cause: 'TIMEOUT';
  errorCode: string | null;
  limitSeconds: number | null;
  lastReportAt: string | null;
} | null {
  if (job.state !== 'ERROR') return null;
  if (job.errorCode !== 'RUNNER_LOST' && job.errorCode !== 'PUSH_OUTCOME_UNKNOWN') return null;
  const detail = job.errorDetail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  // J-T10's abandonment carries the same `limitSeconds` — it is the lease it was judged from — but
  // it is a decision somebody took, not a report that never came. The abandon line says it; the
  // timeout line must not be drawn on top of it.
  if (record.abandoned === true) return null;
  if (typeof record.limitSeconds !== 'number') return null;
  return {
    cause: 'TIMEOUT',
    errorCode: job.errorCode,
    limitSeconds: record.limitSeconds,
    lastReportAt: typeof record.lastReportAt === 'string' ? record.lastReportAt : null,
  };
}

/**
 * The Nth automatic attempt of each automatic landing in the subject, counted the way
 * `AUTOMATIC_MERGE_ATTEMPTS` counts it: the candidate's automatic landings that came back READY,
 * earlier than this one, plus one. A purely read-time derivation — nothing is stored per attempt.
 */
async function readAutomaticAttempts(
  prisma: Pick<PrismaService, '$queryRaw'>,
  jobs: readonly TimelineJob[],
): Promise<Map<string, { attempt: number; limit: number }>> {
  const out = new Map<string, { attempt: number; limit: number }>();
  const automatic = jobs.filter((job) => job.kind === 'LAND_PROMOTION' && job.confirmedAutomatically);
  if (automatic.length === 0) return out;
  const promotionIds = [...new Set(automatic.map((job) => job.promotionId).filter((id): id is string => id != null))];
  if (promotionIds.length === 0) return out;
  const ids = Prisma.join(promotionIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<Array<{
    id: string; claimedAt: Date | null; createdAt: Date; ready: boolean;
  }>>(Prisma.sql`
    SELECT "id", "claimed_at" AS "claimedAt", "created_at" AS "createdAt",
           ("state" = 'READY') AS "ready"
      FROM "project_integration_job"
     WHERE "promotion_id" IN (${ids})
       AND "kind" = 'LAND_PROMOTION'
       AND "confirmed_automatically" = true`);
  for (const job of automatic) {
    const at = job.claimedAt ?? job.createdAt;
    const earlier = rows.filter((row) => row.id !== job.id && row.ready
      && (row.claimedAt ?? row.createdAt).getTime() < at.getTime()).length;
    out.set(job.id, { attempt: earlier + 1, limit: AUTOMATIC_MERGE_ATTEMPTS });
  }
  return out;
}
