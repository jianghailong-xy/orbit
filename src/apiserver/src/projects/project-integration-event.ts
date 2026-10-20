import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LAND_TASK_ROUNDS_PER_CLAIM } from '@orbit/shared';
import type {
  IntegrationJobEventKind,
  IntegrationJobKind,
  IntegrationTimelineActor,
  IntegrationTimelineEntry,
  IntegrationTimelinePage,
  UpstreamMovedCommitsEnriched,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The landing timeline's ledger and its sentences (docs/project-integration-line-contract.md §2.9
 * LS2/LS4; design docs/landing-session-design.md §2.9; mockups v4 §05).
 *
 * A row of `project_integration_job_event` is one FACT about one attempt, written by the door that
 * decided it in the same transaction as the job-gate write it describes (LS2). The claim and the
 * takeover are the exception the contract names: `claimOne` is one auto-commit statement, so those
 * two are backfilled from the committed claim in an independent transaction right after it.
 *
 * EVERY SENTENCE LIVES HERE. The server writes the English line once (`text`) beside the structured
 * fields the same line is drawn with (`data`), and the three clients lay it out — none of them
 * builds a sentence from the fields, which is what keeps the timelines saying the same thing. The
 * read-time derivations LS4 asks for (a rerun's signature, handling, the owner's confirmation, the
 * skipped check, a timeout the row alone cannot explain) compose their lines through the same
 * builders, so there is one place where wording is decided.
 *
 * Nothing here reads or writes a `session` row, and nothing here writes `run_event`: a landing is
 * platform work with no agent transcript (LS2, LS6).
 */

/** The closed set migration 0438 spells as a CHECK. A new fact is a migration, not a deploy. */
export const INTEGRATION_JOB_EVENT_KINDS = [
  'ENQUEUED',
  'STEP',
  'ROUND',
  'CHECK_STARTED',
  'CHECK_FINISHED',
  'CLAIMED',
  'TAKEN_OVER',
  'RELEASED',
  'PUSH_REFUSED',
  'RECHECK_ON_MOVED_MAIN',
  'NEXT_GENERATION',
  'RESULT',
  'REQUEUED',
  'HANDED_TO',
  'STOP_REQUESTED',
  'CANCELLED',
  'ABANDONED',
  'TIMED_OUT',
] as const;

/** Who caused a fact, when a person or a conversation did. */
export interface IntegrationTimelineActorInput {
  type: 'OWNER' | 'COORDINATOR' | 'PLATFORM' | 'RUNNER' | 'AUTOMATIC';
  sessionId?: string | null;
  userId?: string | null;
}

/** One fact to append. `key` is its identity within the attempt; replaying it inserts nothing. */
export interface IntegrationJobEventInput {
  jobId: string;
  key: string;
  kind: IntegrationJobEventKind;
  claim?: number | bigint;
  round?: number | null;
  check?: { name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'; index: number } | null;
  phase?: string | null;
  step?: string | null;
  actor?: IntegrationTimelineActorInput | null;
  reason?: string | null;
  data?: Record<string, unknown> | null;
  text: string;
  /** When the fact happened; defaults to now. A reconstructed check start carries its own instant. */
  at?: Date;
}

/**
 * Append one fact inside a transaction that already holds the job row (rank 60).
 *
 * `ON CONFLICT ("job_id", "key") DO NOTHING` is the whole replay story: the same fact sent twice —
 * a resent result, a repeated progress report, a second stop press, a takeover backfilled twice —
 * is the row already stored, and the door goes on to answer as it would have.
 */
export async function appendIntegrationJobEvent(
  tx: Prisma.TransactionClient,
  event: IntegrationJobEventInput,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "project_integration_job_event"
           ("id", "job_id", "key", "kind", "claim_generation", "round", "check_name", "check_index",
            "phase", "step", "actor_type", "actor_session_id", "actor_user_id", "reason", "data",
            "text", "at")
    VALUES (gen_random_uuid(), ${event.jobId}::uuid, ${event.key}, ${event.kind},
            ${BigInt(event.claim ?? 0)}, ${event.round ?? null},
            ${event.check?.name ?? null}, ${event.check?.index ?? null},
            ${event.phase ?? null}, ${event.step ?? null},
            ${event.actor?.type ?? null}, ${event.actor?.sessionId ?? null}::uuid,
            ${event.actor?.userId ?? null}::uuid, ${event.reason ?? null},
            ${event.data == null ? null : JSON.stringify(event.data)}::jsonb,
            ${event.text}, ${event.at ?? new Date()}::timestamptz)
    ON CONFLICT ("job_id", "key") DO NOTHING`);
}

/**
 * Backfill a fact from a committed row, in an independent transaction (LS2's claim and takeover).
 *
 * A single INSERT is its own transaction, and the fact it records is already committed on the job
 * row: a failure here is logged by the caller and costs the timeline one line, never the claim. The
 * reader derives the current claim from the job row when its event is missing, so the line is not
 * lost either — see `readLandingTimeline`.
 *
 * The statement is spelled out again rather than delegated to `appendIntegrationJobEvent`: the
 * write inventory reads each method's OWN statements (`common/db-write-inventory.ts`), and a
 * function that only forwarded would declare a boundary it does not have.
 */
export async function recordCommittedIntegrationJobEvent(
  client: Pick<PrismaService, '$executeRaw'>,
  event: IntegrationJobEventInput,
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "project_integration_job_event"
           ("id", "job_id", "key", "kind", "claim_generation", "round", "check_name", "check_index",
            "phase", "step", "actor_type", "actor_session_id", "actor_user_id", "reason", "data",
            "text", "at")
    VALUES (gen_random_uuid(), ${event.jobId}::uuid, ${event.key}, ${event.kind},
            ${BigInt(event.claim ?? 0)}, ${event.round ?? null},
            ${event.check?.name ?? null}, ${event.check?.index ?? null},
            ${event.phase ?? null}, ${event.step ?? null},
            ${event.actor?.type ?? null}, ${event.actor?.sessionId ?? null}::uuid,
            ${event.actor?.userId ?? null}::uuid, ${event.reason ?? null},
            ${event.data == null ? null : JSON.stringify(event.data)}::jsonb,
            ${event.text}, ${event.at ?? new Date()}::timestamptz)
    ON CONFLICT ("job_id", "key") DO NOTHING`);
}

// ── sentences ────────────────────────────────────────────────────────────────────────────────────
//
// One builder per fact. They take facts, never decisions: what an owner confirmed or why somebody
// asked for a rerun is read from its own row at read time (LS4) and composed by the read module.

/** `refs/heads/x` → `x`, as every sentence spells a branch. */
export function branchNameOf(ref: string | null | undefined): string {
  if (!ref) return 'the target';
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Seven characters, as the mockup draws a commit; an em dash when the result named none. */
export function shortShaOf(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

/** `17m 02s`, `2m 40s`, `1h 05m`, as the mockup's clocks. */
export function durationText(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** `45m`, `1h 10m`, as the mockup's status line spells a limit. */
export function minutesText(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round((seconds ?? 0) / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** What queued an attempt, which the enqueue event's own text says. */
export type EnqueueCause = 'DONE' | 'RETRY' | 'BACKFILL' | 'BEHIND_WORK' | 'DECISION' | 'AUTOMATIC';

export function enqueuedText(input: {
  kind: IntegrationJobKind;
  sourceRef: string;
  targetRef: string;
  cause?: EnqueueCause;
  automatic?: boolean;
}): string {
  const target = branchNameOf(input.targetRef);
  if (input.kind === 'CHECK_PROMOTION') {
    return `Merge check queued · ${branchNameOf(input.sourceRef)} → ${target}`;
  }
  if (input.kind === 'LAND_PROMOTION') {
    if (input.automatic) return `Merging into ${target} on its own — Automatic is on`;
    return input.cause === 'RETRY' ? `Queued to merge into ${target} again` : `Queued to merge into ${target}`;
  }
  switch (input.cause) {
    case 'RETRY':
      return `Queued again to land on ${target}`;
    case 'BACKFILL':
      return `Queued to land on ${target} · the project started integrating`;
    case 'BEHIND_WORK':
      return `Queued to land on ${target} · the task's work ended on another branch`;
    default:
      return `Task marked done · queued to land on ${target}`;
  }
}

export function stepText(input: {
  phase: string | null;
  step: string | null;
  sourceRef: string;
  upstreamRef: string;
  targetRef: string;
}): string {
  if (input.step === 'WAITING_LOCAL_LOCK') return 'Waiting for this runner\'s repository lock';
  if (input.step === 'PREPARE') return 'Preparing the combined tree';
  const target = branchNameOf(input.targetRef);
  switch (input.phase) {
    case 'FETCH': return 'Fetching the repository';
    case 'MAIN_SYNC': return `Syncing ${branchNameOf(input.upstreamRef)} into ${target}`;
    case 'REBASE': return `Rebasing onto ${target}`;
    case 'MERGE': return `Merging into ${target}`;
    case 'CHECK': return 'Running the checks';
    case 'VERIFY': return 'Verifying the merged tree';
    case 'PUSH': return `Reported starting the push to ${target}`;
    default: return `Working · ${branchNameOf(input.sourceRef)}`;
  }
}

/** "Round 2 of 3" for a task's landing, "Round 1" for the two merge kinds, which have one round
 *  per claim (§2.9, §7.2 V6): the M is the kind's own most rounds per claim, never a check count. */
export function roundText(round: number, kind: string): string {
  return kind === 'LAND_TASK' ? `Round ${round} of ${LAND_TASK_ROUNDS_PER_CLAIM}` : `Round ${round}`;
}

export function checkLabel(name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK'): string {
  return name === 'MERGE_CHECK' ? 'Merge check' : 'Task acceptance';
}

export function checkStartedText(
  check: { name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK' },
  claim: number | null,
  runnerName: string | null,
): string {
  const parts = [checkLabel(check.name), 'started'];
  const claimPart = claim != null && claim > 0 ? `claim ${claim}` : null;
  const suffix = [claimPart, runnerName].filter((part): part is string => part != null);
  return suffix.length > 0 ? `${parts.join(' ')} · ${suffix.join(' · ')}` : parts.join(' ');
}

export function checkFinishedText(check: {
  name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK';
  exitCode: number | null;
  expectedExitCode: number;
  timedOut: boolean;
  durationMs: number;
}): string {
  const label = checkLabel(check.name);
  if (check.timedOut) return `${label} timed out after ${durationText(check.durationMs)}`;
  if (check.exitCode !== check.expectedExitCode) {
    const code = check.exitCode == null ? 'no exit code' : `exit ${check.exitCode}`;
    return `${label} failed · ${code} · ${durationText(check.durationMs)}`;
  }
  return `${label} passed · ${durationText(check.durationMs)}`;
}

export function claimedText(claim: number, runnerName: string | null): string {
  return `Claimed by ${runnerName ? `runner ${runnerName}` : 'a runner'} · claim ${claim}`;
}

export function takenOverText(claim: number, runnerName: string | null): string {
  return `Taken over by a new process on ${runnerName ? `runner ${runnerName}` : 'this runner'} · claim ${claim}`;
}

export function releasedText(claim: number, runnerName: string | null): string {
  return `Handed back by ${runnerName ? `runner ${runnerName}` : 'its runner'} · claim ${claim}`;
}

/**
 * J-T13's refused push, in the mockup's words. The count is the runner's total; the outside-queue
 * clause names the commits that arrived on the upstream from outside this queue, and a commit
 * another account landed is named by its subject here (it is on the upstream every reader can see)
 * while its ids stay out of `data` (`landedBy: { reason: 'ANOTHER_ACCOUNT' }`).
 */
export function pushRefusedText(moved: UpstreamMovedCommitsEnriched | null): string {
  if (!moved || moved.total <= 0) return 'Push refused · the target moved';
  const outside = moved.commits.filter((commit) => commit.outsideQueue);
  const count = moved.total === 1 ? '1 commit' : `${moved.total} commits`;
  if (outside.length === 0) return `Push refused · main moved ${count}`;
  const subjects = outside.slice(0, 3).map((commit) => commit.subject || shortShaOf(commit.sha));
  const more = outside.length > subjects.length ? ', …' : '';
  const fromOutside = outside.length === 1
    ? '1 from outside the queue'
    : `${outside.length} from outside the queue`;
  return `Push refused · main moved ${count}, ${fromOutside} (${subjects.join(', ')}${more})`;
}

export function movedMainText(moved: UpstreamMovedCommitsEnriched | null, tail: string): string {
  if (!moved || moved.total <= 0) return `main moved since the check — ${tail}`;
  return `main moved ${moved.total === 1 ? '1 commit' : `${moved.total} commits`} since the check — ${tail}`;
}

export function resultText(input: {
  state: string;
  effectiveState?: string;
  phase: string | null;
  targetRef: string;
  upstreamRef: string;
  landedSha?: string | null;
  targetShaBefore?: string | null;
  sourceFullyApplied?: boolean | null;
  errorCode?: string | null;
}): string {
  const state = input.effectiveState ?? input.state;
  const target = branchNameOf(input.targetRef);
  switch (state) {
    case 'LANDED':
      return `Landed on ${target} · ${shortShaOf(input.landedSha ?? input.targetShaBefore)}`;
    case 'ALREADY_LANDED':
      return `Already on ${target} · ${shortShaOf(input.targetShaBefore)}`;
    case 'NOTHING_TO_LAND':
      return input.sourceFullyApplied === true
        ? `Nothing to push · ${target} already has every commit of this branch`
        : `Nothing to push · the branch carried no commits`;
    case 'READY':
      return `Ready to merge into ${target}`;
    case 'CONFLICT':
      if (input.phase === 'MAIN_SYNC') {
        return `Could not sync ${branchNameOf(input.upstreamRef)} into ${target} · merge conflict`;
      }
      return 'Could not merge · conflict';
    case 'CHECK_FAILED':
      return 'Check failed · nothing was pushed';
    case 'ERROR':
      return `Stopped with an error${input.errorCode ? ` · ${input.errorCode}` : ''}`;
    case 'CANCELLED':
      return 'Stopped · not landed';
    case 'SUPERSEDED':
      return 'Superseded · a newer attempt asks the same question';
    default:
      return `Ended · ${state}`;
  }
}

export function handedToText(input: {
  assignee: 'COORDINATOR' | 'OWNER';
  itemKind: string;
  targetRef?: string | null;
}): string {
  if (input.itemKind === 'PROMOTION_APPROVAL') {
    return `Asked the owner to merge into ${branchNameOf(input.targetRef)}`;
  }
  return input.assignee === 'OWNER'
    ? 'Asked the owner to fix it'
    : 'Asked the coordinator to fix it';
}

export function stopRequestedText(claim: number | null): string {
  return claim != null && claim > 0 ? `Stop requested · claim ${claim}` : 'Stop requested';
}

/** A generation a stop ended: either from the queue (it never ran) or when its answer came back. */
export function cancelledText(beforeItRan: boolean): string {
  return beforeItRan
    ? 'Stopped · cancelled before it ran'
    : 'Stopped · cancelled when the answer came back';
}

export function abandonedText(by: 'OWNER' | 'COORDINATOR', reason: string | null): string {
  const who = by === 'OWNER' ? 'the owner' : 'the coordinator';
  return reason ? `Abandoned by ${who} · ${reason}` : `Abandoned by ${who}`;
}

export function timedOutText(input: {
  limitSeconds: number | null;
  heartbeatAt: Date | null;
  at: Date;
}): string {
  const silentMs = input.heartbeatAt ? Math.max(0, input.at.getTime() - input.heartbeatAt.getTime()) : null;
  const silent = silentMs == null ? 'no report' : `no report for ${minutesText(silentMs / 1_000)}`;
  return input.limitSeconds == null
    ? `Timed out · ${silent}`
    : `Timed out · ${silent} (limit ${minutesText(input.limitSeconds)})`;
}

/** LS4's rerun line: the requester is the session or the user the retry row records, never copied. */
export function retryText(input: {
  requestedBy: 'COORDINATOR' | 'OWNER' | null;
  reason: string | null;
}): string {
  const who = input.requestedBy === 'COORDINATOR' ? 'the coordinator'
    : input.requestedBy === 'OWNER' ? 'the owner' : null;
  const head = who ? `Rerun by ${who}` : 'Rerun';
  return input.reason ? `${head} · ${input.reason}` : head;
}

export function skippedCheckText(reason: string | null): string {
  return reason ? `Merge check skipped · ${reason}` : 'Merge check skipped';
}

export function handlingText(itemState: 'OPEN' | 'CLOSED'): string {
  return itemState === 'OPEN' ? 'Handling the earlier failure' : 'Handled the earlier failure';
}

export function confirmationText(input: {
  automatic: boolean;
  targetRef: string;
}): string {
  return input.automatic
    ? 'Confirmed by Automatic'
    : `Merge to ${branchNameOf(input.targetRef)} confirmed by the owner`;
}

export function automaticAttemptText(attempt: number, limit: number): string {
  return attempt < limit
    ? `Automatic merge ${attempt} of ${limit} · if main moves again, it asks the owner`
    : `Automatic merge ${attempt} of ${limit} · it asks the owner now`;
}

export function fixesItemText(): string {
  return 'Filed to fix an exception';
}

/** J-T1a / J-T1e's answer about work that could still move: the row goes back to the queue, or —
 *  with a stop already asked — ends CANCELLED. It is not an answer, and the timeline says so rather
 *  than leaving the attempt with no record of why it was asked again. */
export function requeuedText(): string {
  return 'Sent back to the queue · the task\'s work had not stopped moving';
}

/** The promotion's current state, as the round's timeline states it. `blockedReason` is the
 *  candidate's NOW, never history: 0409's column is cleared when a recheck is queued, and a past
 *  block is read off the attempt row that recorded it. */
export function promotionStateText(state: string): string {
  switch (state) {
    case 'CHECKING': return 'Merge round · checking';
    case 'READY': return 'Merge round · waiting for the owner';
    case 'CONFIRMED': return 'Merge round · merging';
    case 'RECHECKING': return 'Merge round · merging after main moved';
    case 'MERGED': return 'Merge round · merged';
    case 'BLOCKED': return 'Merge round · blocked';
    case 'SUPERSEDED': return 'Merge round · candidate superseded';
    case 'DECLINED': return 'Merge round · declined';
    case 'CANCELLED': return 'Merge round · cancelled';
    default: return `Merge round · ${state.toLowerCase()}`;
  }
}

// ── the runner read's timeline page ──────────────────────────────────────────────────────────────

/** One page of one attempt's timeline. `INTEGRATION_EVENT_PAGE_SIZE` entries at most. */
export const INTEGRATION_EVENT_PAGE_SIZE = 100;

/** Where a timeline page starts: the attempt, and the narrowing a reader already has. */
export interface IntegrationEventSelectors {
  jobId: string;
  /** The claim generation, from 0 (the enqueue). */
  claim?: number;
  /** The round inside that claim, from 1. */
  round?: number;
  /** The continuation a previous page answered with. */
  cursor?: string;
}

/** One stored row, as the query returns it before it becomes an entry. */
interface EventRow {
  id: string;
  seq: string;
  kind: string;
  claim: string;
  round: number | null;
  checkName: string | null;
  checkIndex: number | null;
  phase: string | null;
  step: string | null;
  actorType: string | null;
  actorSessionId: string | null;
  actorUserId: string | null;
  reason: string | null;
  data: unknown;
  text: string;
  at: Date;
}

const EVENT_COLUMNS = Prisma.sql`
  "id", "seq", "kind", "claim_generation" AS "claim", "round", "check_name" AS "checkName",
  "check_index" AS "checkIndex", "phase", "step", "actor_type" AS "actorType",
  "actor_session_id" AS "actorSessionId", "actor_user_id" AS "actorUserId",
  "reason", "data", "text", "at"`;

/**
 * Every fact of every attempt of one landing subject, oldest first, at most `limitPerJob` per
 * attempt — the landing page draws the whole subject in one read, and a subject holds few attempts.
 * A row cap per attempt keeps one pathological attempt from making the page read the ledger's
 * whole history for it.
 */
export async function readSubjectEvents(
  prisma: Pick<PrismaService, '$queryRaw'>,
  jobIds: readonly string[],
  limitPerJob: number,
): Promise<Map<string, IntegrationTimelineEntry<Date>[]>> {
  const out = new Map<string, IntegrationTimelineEntry<Date>[]>();
  if (jobIds.length === 0) return out;
  const ids = Prisma.join(jobIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await prisma.$queryRaw<Array<EventRow & { jobId: string }>>(Prisma.sql`
    SELECT "jobId", "id", "seq", "kind", "claim", "round", "checkName", "checkIndex", "phase", "step",
           "actorType", "actorSessionId", "actorUserId", "reason", "data", "text", "at"
      FROM (
        SELECT "job_id" AS "jobId", ${EVENT_COLUMNS},
               row_number() OVER (
                 PARTITION BY "job_id"
                 ORDER BY "claim_generation", COALESCE("round", 0), "at", "seq") AS "rn"
          FROM "project_integration_job_event"
         WHERE "job_id" IN (${ids})
      ) ranked
     WHERE "rn" <= ${limitPerJob}
     ORDER BY "jobId", "claim", COALESCE("round", 0), "at", "seq"`);
  for (const row of rows) {
    const list = out.get(row.jobId) ?? [];
    list.push(eventEntry(row));
    out.set(row.jobId, list);
  }
  return out;
}

/**
 * `GET /runner/projects/:id/integration?jobId=…&claim=…&round=…`'s timeline slot: one attempt's
 * facts in production order, narrowed by claim and round and continued by an opaque cursor. A job
 * that is not this project's is answered as one that does not exist — the runner read has already
 * established the project and the acting session, so the job is resolved within them.
 */
export async function readIntegrationJobTimeline(
  prisma: Pick<PrismaService, 'projectIntegrationJob' | '$queryRaw'>,
  projectId: string,
  selectors: IntegrationEventSelectors,
): Promise<IntegrationTimelinePage<Date>> {
  const job = await prisma.projectIntegrationJob.findFirst({
    where: { id: selectors.jobId, projectId },
    select: { id: true },
  });
  if (!job) throw new NotFoundException('integration job not found');
  return readEventPage(prisma, selectors);
}

/** One page of one attempt's facts, in the ledger's own order. Shared with nothing else: the
 *  landing view reads a whole subject in display order (`readSubjectEvents`). */
export async function readEventPage(
  prisma: Pick<PrismaService, '$queryRaw'>,
  selectors: IntegrationEventSelectors,
): Promise<IntegrationTimelinePage<Date>> {
  const cursor = selectors.cursor ? decodeEventCursor(selectors.cursor) : null;
  // A ROUND FILTER SPELLS "ROUND N" THE WAY THE SORT DOES — a fact with no round belongs to round
  // 0, the enqueue/first claim, and `round=0` is how a caller asks for those.
  const narrowed = Prisma.sql`
    ${selectors.claim !== undefined ? Prisma.sql`AND "claim_generation" = ${BigInt(selectors.claim)}` : Prisma.empty}
    ${selectors.round !== undefined ? Prisma.sql`AND COALESCE("round", 0) = ${selectors.round}` : Prisma.empty}
    ${cursor ? Prisma.sql`AND "seq" > ${BigInt(cursor.seq)}` : Prisma.empty}`;
  // PAGES CONTINUE ON `seq`, NOT ON `at`. A fact's own instant may be backdated (a v2 check's
  // start, a check start reconstructed from the result's durations), so a fact written after a
  // page can sort before that page's last line — continuing on the instant would starve it for
  // ever. The ledger's sequence is the one order every appended fact moves forward in.
  const rows = await prisma.$queryRaw<EventRow[]>(Prisma.sql`
    SELECT "id", "seq", "kind", "claim_generation" AS "claim", "round", "check_name" AS "checkName",
           "check_index" AS "checkIndex", "phase", "step", "actor_type" AS "actorType",
           "actor_session_id" AS "actorSessionId", "actor_user_id" AS "actorUserId",
           "reason", "data", "text", "at"
      FROM "project_integration_job_event"
     WHERE "job_id" = ${selectors.jobId}::uuid
       ${narrowed}
     ORDER BY "seq" ASC
     LIMIT ${INTEGRATION_EVENT_PAGE_SIZE + 1}`);
  const entries = rows.slice(0, INTEGRATION_EVENT_PAGE_SIZE).map((row) => eventEntry(row));
  const last = rows.length > INTEGRATION_EVENT_PAGE_SIZE ? entries.at(-1) : null;
  return {
    jobId: selectors.jobId,
    entries,
    nextCursor: last ? encodeEventCursor(last) : null,
  };
}

/** One stored row, in the shape every reader of the timeline uses. */
export function eventEntry(row: EventRow): IntegrationTimelineEntry<Date> {
  return {
    id: row.id,
    seq: Number(row.seq),
    kind: row.kind as IntegrationTimelineEntry<Date>['kind'],
    at: row.at,
    claim: Number(row.claim),
    round: row.round,
    check: row.checkName && row.checkIndex != null
      ? { name: row.checkName as 'TASK_ACCEPTANCE' | 'MERGE_CHECK', index: row.checkIndex }
      : null,
    phase: row.phase as IntegrationTimelineEntry<Date>['phase'],
    step: row.step,
    actor: row.actorType
      ? {
        type: row.actorType as IntegrationTimelineActor['type'],
        sessionId: row.actorSessionId,
        userId: row.actorUserId,
      }
      : null,
    reason: row.reason,
    data: row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : null,
    text: row.text,
  };
}

/** The continuation a page answers with: the ledger position of its last entry. Opaque to the
 *  caller. Only the sequence travels: it is the one key that moves forward for every append. */
function encodeEventCursor(entry: IntegrationTimelineEntry<Date>): string {
  return Buffer.from(JSON.stringify({ s: entry.seq }), 'utf8').toString('base64url');
}

/** A cursor this module issued, or a 400 — never a query that silently starts somewhere else. */
function decodeEventCursor(raw: string): { seq: number } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Number.isSafeInteger(parsed.s) && (parsed.s as number) >= 1) {
      return { seq: parsed.s as number };
    }
  } catch {
    // The refusal below is the answer for every malformed cursor, whatever its shape.
  }
  throw new BadRequestException('cursor is not one this read issued');
}
