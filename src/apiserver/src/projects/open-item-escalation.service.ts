import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { INTEGRATION_CLAIM_STALE_MS } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { isLockNotAvailable } from '../tasks/task-supersession';
import { DEFAULT_CHECK_TIMEOUT_SECONDS, INTEGRATION_PROGRESS_V2_PROTOCOL } from './project-integration-job';
import { LANDED_RESULTS } from './project-criterion-landing';
import {
  INTEGRATION_ITEM_KINDS,
  LANDING_LEASE_EXPIRED_KIND,
  OPEN_ITEM_TURN_PREFIX,
  openItemOwed,
} from './project-open-item';
import { PROJECT_LIVE_SESSION_STATUS_SQL } from './live-session-status';

/**
 * How often the clock looks. Not how long anything waits: each item carries its own
 * `escalate_at`, frozen from its project's window when it was opened (§4.1, X-E2), so a tick is
 * only the resolution at which a due item is noticed.
 */
const TICK_MS = 60_000;

/**
 * The delivery-key prefix as a SQL literal rather than a bind parameter: a fixed string this module
 * owns, inlined like the live-status list, so `escalatesAt` adds no parameter to the statements that
 * embed it (`project-list-attention.spec.ts` pins theirs).
 */
const OPEN_ITEM_TURN_PREFIX_SQL = Prisma.raw(`'${OPEN_ITEM_TURN_PREFIX}'`);

/** One item this tick handed over, for whoever tells the owner about it. */
export interface EscalatedOpenItem {
  itemId: string;
  projectId: string;
  ownerId: string;
}

/** One `LANDING_LEASE_EXPIRED` item the tick opened (§4.6 X-E5), for the same reason. */
export interface OpenedLeaseItem {
  itemId: string;
  projectId: string;
  ownerId: string;
}

/** §4.6 X-E5's grace past `LEASE_EXPIRED`: the claim has been expired for a quarter of an hour. */
const LANDING_LEASE_GRACE_SECONDS = 15 * 60;

/**
 * How long X-E5's alarm waits for any one lock before it gives up the whole tick's alarm: the
 * `lock_timeout` `openLeaseExpiredItems` runs its statement under. A timeout costs only a tick —
 * nothing was written, and the next tick asks again from committed rows a minute later — while a
 * wait costs others: for as long as it lasts, a FOR UPDATE NOWAIT on a parent the statement holds is
 * refused, and the statement's snapshot ages, so a card opened and closed meanwhile is not seen. 200
 * ms bounds each such wait to that long, and is still far longer than the wait two replicas ticking
 * at the same moment meet at the unique index — the other's insert of the same key, a round trip
 * from its commit — so that meeting still ends in ON CONFLICT DO NOTHING rather than a timeout
 * (WHAT IT CAN STILL WAIT FOR, on the method).
 */
const LEASE_ALARM_LOCK_TIMEOUT_MS = 200;

/** §7.2 V6's base lease — `INTEGRATION_CLAIM_STALE_MS` — as the statement below counts it. */
const LEASE_SECONDS = INTEGRATION_CLAIM_STALE_MS / 1_000;

/**
 * §7.2 V6's limit as SQL, over the aliases `leaseExpiredClaims` joins: the job as `j`, its
 * codebase as `cb`, the task of the session the job names as `acceptance_task`, and its candidate
 * as `p`. The same rule `integrationJobLimitSeconds` states in TypeScript (`checksFor` decides
 * which checks a job runs, and each one's budget is its timeout):
 *
 *  - a v2 claim reports every 30 seconds whatever it is doing, so the lease is the limit;
 *  - a legacy claim reports only when a step starts, so a legacy CHECK is silent for as long as its
 *    checks run: the lease plus every check's budget, and every other phase is git work.
 */
function leaseLimitSeconds(alias: string): Prisma.Sql {
  const job = Prisma.raw(`"${alias}"`);
  return Prisma.sql`CASE
      WHEN ${job}."progress_protocol" = ${INTEGRATION_PROGRESS_V2_PROTOCOL} THEN ${LEASE_SECONDS}::int
      WHEN ${job}."phase" IS DISTINCT FROM 'CHECK' THEN ${LEASE_SECONDS}::int
      ELSE ${LEASE_SECONDS}::int
           + CASE WHEN (${job}."kind" = 'LAND_TASK' OR p."source_kind" = 'TASK_BRANCH')
                   AND acceptance_task."acceptance_command" IS NOT NULL
                   AND acceptance_task."acceptance_expected_exit_code" IS NOT NULL
                  THEN COALESCE(acceptance_task."acceptance_timeout_seconds",
                                ${DEFAULT_CHECK_TIMEOUT_SECONDS})::int
                  ELSE 0 END
           + CASE WHEN cb."merge_check_command" IS NOT NULL
                   AND NOT (${job}."kind" = 'LAND_TASK' AND ${job}."skip_merge_check")
                  THEN COALESCE(cb."merge_check_timeout_seconds",
                                ${DEFAULT_CHECK_TIMEOUT_SECONDS})::int
                  ELSE 0 END
    END`;
}

/**
 * §4.6 X-E5's fact as SQL: the FROM and WHERE through which `openLeaseExpiredItems`' one statement
 * finds the claims that are due, over the aliases `leaseLimitSeconds` reads. The statement spells it
 * twice — in its `due` CTE, whose claims' parents it takes, and in the SELECT that writes the items,
 * which re-checks each job on its newest version — so both are chosen by the same predicate.
 */
function leaseExpiredClaims(): Prisma.Sql {
  return Prisma.sql`
        FROM "project_integration_job" j
        JOIN "project_codebase" cb ON cb."id" = j."codebase_id"
        LEFT JOIN "session" s ON s."id" = j."session_id"
        LEFT JOIN "task" acceptance_task ON acceptance_task."id" = s."task_id"
        -- task_id is a foreign key on the item; the job's is a history reference (0423), so it is
        -- written only while the row it names is there — the liveTaskId mapping the result path uses.
        LEFT JOIN "task" live_task ON live_task."id" = j."task_id"
        LEFT JOIN "project_promotion" p ON p."id" = j."promotion_id"
        LEFT JOIN "project_landing" landing ON landing."id" = j."landing_id"
        LEFT JOIN "runner" r ON r."id" = j."runner_id"
       WHERE j."state" = 'RUNNING'
         AND COALESCE(j."heartbeat_at", j."claimed_at") IS NOT NULL
         -- One item per claim, ever (§4.2): a claim that reported and went silent again is the same
         -- silence the owner was already told about, so an item already ended under this key is
         -- not opened a second time. A takeover is a new key and asks afresh.
         AND NOT EXISTS (
           SELECT 1 FROM "project_open_item" seen
            WHERE seen."project_id" = j."project_id"
              AND seen."dedupe_key" = 'LE:' || j."id"::text || ':' || j."claim_generation"::text)
         -- §7.2 V6's limit, plus X-E5's fifteen minutes.
         AND EXTRACT(EPOCH FROM (now() - COALESCE(j."heartbeat_at", j."claimed_at")))
             > (${leaseLimitSeconds('j')} + ${LANDING_LEASE_GRACE_SECONDS})
         -- readInFlightJobs' own local-lock rule, spelled as it spells it: a job claimed at its last
         -- report while an older job of the same runner, repository and ref still holds the
         -- in-process lock is queueing, not lost. A NULL heartbeat is "not behind" there, so the
         -- conjunction is COALESCEd rather than the column.
         AND NOT COALESCE(
           j."heartbeat_at" <= j."claimed_at"
           AND EXISTS (
             SELECT 1 FROM "project_integration_job" o
               JOIN "project_codebase" ocb ON ocb."id" = o."codebase_id"
              WHERE o."state" = 'RUNNING'
                AND o."runner_id" = j."runner_id"
                AND o."target_ref" = j."target_ref"
                AND ocb."canonical_repo_url" = cb."canonical_repo_url"
                AND o."claimed_at" < j."claimed_at"
                AND o."id" <> j."id"), false)`;
}

/** One item the backstop closed, or found landed and left open, as its log line reads it. */
export interface ReconciledOpenItem {
  itemId: string;
  projectId: string;
  ownerId: string;
  kind: string;
  assignee: string;
  assigneeReason: string;
  /** What the item is about as it stands now: `promotion <id>@<state>` or `task <id>@<status>`. */
  about: string;
  createdAt: Date;
}

/**
 * The moment an item the coordinator holds becomes the owner's, as SQL over the `project_open_item`
 * row aliased `alias` — the one definition the clock acts on and every reader of the item shows.
 *
 * An item the coordinator has TAKEN UP has no deadline (`NULL`, §4.6 revision 13): the
 * conversation the project is coordinated from answered one of this item's own delivery turns since
 * it last became the coordinator's, and can still act on it. What it cannot settle it asks the owner
 * about (`ask_owner`) or hands over itself (`open_item_hand_over`); the clock does not decide for it
 * that it is taking too long — that card reached an owner on 2026-10-08 about a fix that had landed
 * and been merged into main two hours earlier.
 *
 * The clock is for the coordinator that cannot ask: one that never answered the item (stuck in an
 * earlier turn, never handed it), or one that answered and is now down, ended, replaced or switched
 * off. For those it follows concrete progress on this item. An item is opened with `escalate_at`
 * equal to `waiting_since + the project's frozen window` (§4.1, X-E2). The latest progress fact (the
 * answered delivery turn, a task linked as a fix, the linked task's work session, or an integration
 * handling job) moves that deadline by one window. A generic conversation turn is not progress on
 * this item. While a linked task is `IN_PROGRESS`, its task-work session is live, or a coordinator
 * handling job is queued/running, the item has no deadline either: H4's in-flight handling is still
 * progress and cannot be handed to the owner mid-operation. Once that work ends, the latest recorded
 * instant is used and the item can escalate after one quiet window.
 *
 * Progress is read from committed facts: delivery answers, task/session timestamps, and handling
 * job state. No turn, session, wake row, or delivery is written by the clock.
 */
export function escalatesAt(alias: string): Prisma.Sql {
  const item = Prisma.raw(`"${alias}"`);
  return Prisma.sql`CASE
    -- A live concrete fix owns the clock. The item remains OPEN, but it is not handed to the owner
    -- while the task/session or the coordinator's integration retry is still in flight.
    WHEN EXISTS (
      SELECT 1
        FROM "task" fix
       WHERE fix."fixes_open_item_id" = ${item}."id"
         AND fix."status" = 'IN_PROGRESS'
    )
      OR EXISTS (
        SELECT 1
          FROM "task" fix
          JOIN "session" work ON work."task_id" = fix."id"
                             AND work."starts_task_work" = true
         WHERE fix."fixes_open_item_id" = ${item}."id"
           AND work."deleted_at" IS NULL
           AND work."completed_at" IS NULL
           AND work."archived_at" IS NULL
           AND work."cancel_requested_at" IS NULL
           AND work."status" IN (${Prisma.raw(PROJECT_LIVE_SESSION_STATUS_SQL)})
           AND (work."status" <> 'INTERRUPTED' OR work."end_reason" IS NULL)
      )
      OR EXISTS (
        SELECT 1
          FROM "project_integration_job" handling
         WHERE handling."id" = ${item}."handling_job_id"
           AND handling."state" IN ('QUEUED', 'RUNNING')
      )
    THEN NULL
    -- Taken up (revision 13): the project's coordinator answered one of this item's own delivery
    -- turns since the item last became its own ("Ask the coordinator again" moves waiting_since), and
    -- that conversation can still act on it — switched on, not filed, trashed or asked to end, and
    -- not down. It keeps the item until it closes it, asks the owner or hands it over.
    WHEN EXISTS (
      SELECT 1
        FROM "project" owning
        JOIN "session" coordinator ON coordinator."id" = owning."coordinator_session_id"
        JOIN "conversation_turn" answered ON answered."session_id" = coordinator."id"
       WHERE owning."id" = ${item}."project_id"
         AND owning."coordinator_enabled" = true
         AND coordinator."deleted_at" IS NULL
         AND coordinator."completed_at" IS NULL
         AND coordinator."archived_at" IS NULL
         AND coordinator."cancel_requested_at" IS NULL
         AND coordinator."status" IN (${Prisma.raw(PROJECT_LIVE_SESSION_STATUS_SQL)})
         AND (coordinator."status" <> 'INTERRUPTED' OR coordinator."end_reason" IS NULL)
         AND starts_with(answered."client_turn_id", ${OPEN_ITEM_TURN_PREFIX_SQL} || ${item}."id"::text || ':')
         AND answered."kind" = 'message'
         AND answered."answered_at" >= ${item}."waiting_since"
    )
    THEN NULL
    ELSE GREATEST(
      ${item}."escalate_at",
      COALESCE((
        SELECT max(progress."at") + (${item}."escalate_at" - ${item}."waiting_since")
          FROM (
            -- Only the turn this item was delivered on counts. Generic chat turns are intentionally
            -- absent: they are conversation activity, not progress on this exception.
            SELECT turn."answered_at" AS "at"
              FROM "project_open_item_delivery" delivery
              JOIN "conversation_turn" turn
                ON turn."session_id" = delivery."session_id"
               AND turn."client_turn_id" = delivery."client_turn_id"
             WHERE delivery."item_id" = ${item}."id"
               AND delivery."purpose" = 'ITEM'
               AND turn."kind" = 'message'
               AND turn."answered_at" IS NOT NULL
            UNION ALL
            -- updated_at is the durable write instant for both filing a new fix and attaching an
            -- existing task through task_update.
            SELECT fix."updated_at" AS "at"
              FROM "task" fix
             WHERE fix."fixes_open_item_id" = ${item}."id"
            UNION ALL
            SELECT GREATEST(
                     COALESCE(work."last_turn_at", work."created_at"),
                     COALESCE(work."finished_at", work."completed_at", work."archived_at", work."deleted_at")
                   ) AS "at"
              FROM "task" fix
              JOIN "session" work
                ON work."task_id" = fix."id"
               AND work."starts_task_work" = true
             WHERE fix."fixes_open_item_id" = ${item}."id"
            UNION ALL
            SELECT ${item}."handling_started_at" AS "at"
             WHERE ${item}."handling_started_at" IS NOT NULL
            UNION ALL
            SELECT handling."finished_at" AS "at"
              FROM "project_integration_job" handling
             WHERE handling."id" = ${item}."handling_job_id"
               AND handling."finished_at" IS NOT NULL
          ) progress
      ), ${item}."escalate_at")
    )
  END`;
}

/**
 * The one clock this platform adds (`docs/project-integration-line-contract.md` §4.6 X-E1).
 *
 * WHAT IT IS FOR. An exception item has an assignee, and the project's coordinator conversation can
   * be one of them. Once that conversation has taken the item up it keeps it, and asks the owner
   * itself when it needs them (§4.6 revision 13). The clock is for the coordinator that cannot ask —
   * one that never answered the item, or is down, ended, replaced or switched off. For those, a
   * concrete fix or handling job is evidence that somebody is acting on the item, so an in-flight
   * operation keeps it with that actor; once the operation ends, the item moves to the owner only
   * after a full frozen window with no item-specific progress. Generic chat is intentionally not a
   * clock reset (§4.7 H4).
 *
 * WHY A CLOCK IS ALLOWED HERE AND NOWHERE ELSE. Every other input in this system is routed on a
 * COMMITTED FACT — evidence revised, a receipt written, a turn ended — and elapsed time is not one:
 * a timer that starts agent work invents work nobody asked for, which is exactly the loop the
 * completion-input contract took out. This clock is the exception because what it produces is not
 * agent work. It writes the item's assignee and nothing else; a person then reads it in their own
 * open items. No turn, no session, no wake row, no delivery — the assertions in
 * `exception-escalation.pg.spec.ts` count all four across the whole database, before and after.
 * Reading a conversation's turns to decide WHEN changes none of that: they are read, never written.
 *
 * WHAT MAKES IT SAFE TO RUN ANYWHERE. The statement is its own compare-and-set: it selects only
 * items that are still OPEN, still the coordinator's and already due, and the same UPDATE takes them
 * out of that selection. Two apiservers ticking at the same moment escalate each item once between
 * them, and a tick that runs every minute for an hour after an item came due escalates it on the
 * first one and reports nothing on the other fifty-nine.
 *
 * THE BACKSTOP RIDES THE SAME TICK. Before the sweep, `reconcile` closes the items nobody owes any
 * more (`openItemOwed`) — the ones an edge that should have closed them missed — so what the clock
 * hands to a person is only what somebody still owes. That is not a second clock (§8.3): it is this
 * tick, and it writes an item's ending and nothing an agent would run either.
 */
@Injectable()
export class ProjectOpenItemEscalationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectOpenItemEscalationService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** The landed items `reconcile` has already reported from this process, so a missing edge is one
   *  warning rather than one a minute for as long as the item stays open. */
  private readonly reportedLanded = new Set<string>();
  /** The alarm's `lock_timeout`, `LEASE_ALARM_LOCK_TIMEOUT_MS`. Nothing in production sets it; a
   *  spec that has to hold the alarm at one of its waits while it arranges what happens beside it
   *  sets a longer one on its own instance. */
  readonly leaseAlarmLockTimeoutMs: number = LEASE_ALARM_LOCK_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    /** X-E1's one reader: an item that became the owner's is one of the four things their phone is
     *  told about (§7.6 V12) — and an item the backstop closed may have been one their badge counted.
     *  `@Optional()`, so a build or a spec without PushModule escalates exactly as before — the
     *  assignee is the fact, and the banner is a consequence of it. */
    @Optional() private readonly push?: PushService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      // Three writes, each with its own failure: the backstop first, so what the sweep then hands
      // over is only what somebody still owes (and a backstop that failed does not cost the sweep,
      // which asks `openItemOwed` itself); then the sweep, a statement like the backstop; then
      // X-E5's lease alarm, one statement in a transaction of its own under a lock timeout, which a
      // sweep that threw must not skip — a silent runner's card is the only warning there is. An
      // alarm that was not granted a lock in time does not throw: it opens nothing, logs that it
      // left this tick's alarm to the next one, and returns no item.
      void this.reconcile()
        .catch((e) => this.logger.error(`reconcile failed: ${(e as Error).message}`))
        .then(() => this.sweep())
        .then((escalated) => {
          // Told to the person it just became the problem of, and to nobody else: the sweep itself
          // stays a write of one column, which is what makes it safe to run on every replica.
          for (const item of escalated) void this.push?.notifyOwnerItem(item.itemId);
        })
        .catch((e) => this.logger.error(`sweep failed: ${(e as Error).message}`))
        .then(() => this.openLeaseExpiredItems())
        .then((opened) => {
          for (const item of opened) void this.push?.notifyOwnerItem(item.itemId);
        })
        .catch((e) => this.logger.error(`lease-expired items failed: ${(e as Error).message}`));
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Hand over every item that has waited out its window, and say which ones those were.
   *
   * Returns the rows rather than announcing them, because who tells the owner is not this service's
   * question: the escalation is the durable fact, and a notification is one reader of it. A caller
   * that has none still leaves the owner with the item in front of them, which is what `needsYou`
   * on `GET /projects/:id/open-items` reads.
   *
   * `assigned_at` moves with the assignee on purpose: a delivery's turn key names the assignment it
   * was made under (§4.4 X-D2), so an item that later comes back to a coordinator is delivered
   * afresh instead of replaying the turn the previous assignee never read.
   *
   * Due is `escalatesAt`, not the column. The column is the half of it that costs nothing and is
   * asked first, so a conversation's turns are read only for items that have outlived the window
   * they were opened with.
   *
   * And owed (`openItemOwed`): an item about a candidate or a task that has moved on is nobody's to
   * act on, so it is not handed to the owner and nobody is told about it — whether or not
   * `reconcile` has closed it yet.
   */
  async sweep(): Promise<EscalatedOpenItem[]> {
    return this.prisma.$queryRaw<EscalatedOpenItem[]>(Prisma.sql`
      UPDATE "project_open_item" item
         SET "assignee" = 'OWNER', "assignee_reason" = 'ESCALATED', "assigned_at" = now(),
             "escalated_at" = now(), "updated_at" = now()
       WHERE item."state" = 'OPEN' AND item."assignee" = 'COORDINATOR' AND item."escalate_at" <= now()
         AND ${escalatesAt('item')} <= now()
         AND ${openItemOwed('item')}
      RETURNING item."id" AS "itemId", item."project_id" AS "projectId", item."owner_id" AS "ownerId"`);
  }

  /**
   * §4.6 X-E5: open one owner item per claim whose runner has stopped reporting, and say which ones
   * were opened.
   *
   * THE FACT. A RUNNING job's CURRENT claim is `LEASE_EXPIRED` — §7.2 V6's one definition, the same
   * one `inFlightJobs.timedOut`, the retry doors and the abandon door read (`integrationJobLimitSeconds`
   * states its limit here, and this statement spells that limit in SQL) — and has been for more than
   * fifteen minutes. A job waiting its turn on its runner's local lock is not timed out, exactly as
   * `readInFlightJobs` decides it, so that queue is never mistaken for silence.
   *
   * THE SHAPE. One `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`, like the sweep: a statement
   * that is its own compare-and-set, run in a transaction of its own whose only other statement sets
   * its lock timeout (BOUNDED, below). The partial unique index over OPEN items is the conflict
   * target, so two apiservers ticking at the same moment open each item once, a tick a minute for an
   * hour opens nothing after the first, and the caller therefore pushes once. A key already written
   * and since settled is left alone too: one claim is one card, ever (§4.2), and a takeover writes a
   * new generation's key. The SELECT locks each job it writes about, and READ COMMITTED locks a row's
   * newest version and checks the WHERE again on it, so a report or a result that committed after
   * the statement's snapshot is seen and its claim dropped: a claim that is talking again does not
   * get a card about its silence (`landing-lease-expired.pg.spec.ts` (20)).
   *
   * THE LOCK ORDER (`common/lock-order.ts`). The item's foreign keys check its project (rank 40),
   * its task (50), its candidate and its job (60) FOR KEY SHARE at the end of the statement, and a
   * key waits for a row it cannot lock. Left to the keys, the project and the task came after the
   * job — the order J-T8's stop and a project delete met head-on: `task_reopen` holds the task FOR
   * UPDATE and then ends the same job, a delete holds the project FOR UPDATE and then deletes the
   * job through its cascade, and PostgreSQL aborted one side ((19), (21)). Taking them first with
   * locks that wait, in a transaction of the tick's own (e88d5dd38), held the task for as long as
   * the insert then waited on the job, and a task-side FOR UPDATE NOWAIT (a supersession, a
   * MOVE_TASK approval) was refused against it ((23)). So the statement takes every one of those
   * rows itself, before its keys do and SKIP LOCKED: the `held` CTE takes the due claims' projects,
   * then their tasks, then their candidates FOR KEY SHARE — the mode the keys take, each set sorted
   * by id, in a UNION ALL that PostgreSQL runs branch by branch — and the SELECT takes the jobs FOR
   * SHARE, in id order, and writes only the claims whose every parent the CTE holds. A claim whose
   * job another transaction is writing (a report, a chunk or a result in flight), or one of whose
   * parents is held FOR UPDATE, being deleted or having a key changed, is left out: it is the next
   * tick's, a minute later ((22)). The keys then find every row they check already held by this
   * statement, and are granted it at once. No session row is locked: the item's `session_id` is a
   * history column, not a key.
   *
   * WHAT IT CAN STILL WAIT FOR. SKIP LOCKED does not queue for a lock held on the row version it
   * reads, and it does not cover that row's newer versions: PostgreSQL's FOR KEY SHARE, the
   * parents' mode, also locks the versions an UPDATE made without changing a key, and waits for one
   * held FOR UPDATE, being deleted or re-keyed by a transaction that is still open, SKIP LOCKED or
   * not. The first of the three arrays the SELECT reads takes the whole `held` CTE, before any job
   * row is locked or any item written, so that wait holds only parents taken in rank order and
   * closes no cycle with a transaction that keeps the order ((24)). Once the statement holds a job,
   * the one place left that waits is the unique index: for another tick's uncommitted insert of the
   * same key, or for an open transaction that is ending or deleting a committed OPEN item of that
   * key, the job held FOR SHARE meanwhile — and the ticks insert in job id order, so no two of them
   * can each be waiting on a key the other has written.
   *
   * BOUNDED. Every one of those waits is cut at `LEASE_ALARM_LOCK_TIMEOUT_MS`. The transaction sets
   * that `lock_timeout` before the statement, so a wait that outlives it cancels the statement and
   * rolls the transaction back with nothing written; the method logs that it left the alarm to the
   * next tick and returns no item, and every due claim's alarm, not only the one whose row was
   * waited for, is the next tick's ((25)). What the timeout keeps short rather than closes is two
   * windows, each as long as the statement runs: its own milliseconds, and no wait in it longer
   * than the timeout. While it runs it holds the due projects, tasks and candidates it has taken
   * FOR KEY SHARE, so a FOR UPDATE NOWAIT on one of them — a supersession's
   * (`TasksService.lockTaskForSupersessionWrite`), a MOVE_TASK approval's — is refused with the 409
   * that says a run is starting on the task. And it reads through the snapshot it started with, so
   * a card another replica opened under a due key after that, and somebody closed before the
   * statement reached its insert, is not seen by its NOT EXISTS, and the partial unique index,
   * which covers OPEN items only, does not stop a second one: that claim's card can be opened
   * again. A wait cut at the timeout opens nothing, and the tick that next asks sees the card
   * ((26)). The complete fix of that second window is a unique index over every state of the key,
   * which would make one claim one card a constraint; it was not made.
   *
   * WHAT IT WRITES. The item and nothing else: `OWNER` / `ESCALATED` from birth, `escalated_at` at
   * the opening instant, and `escalate_at` / `remind_at` NULL (it is already the owner's, and there
   * is no second reminder). Its title is §4.2's, `No word from the runner: <task>` — with
   * `Merge check` / `Merge to main` for the promotion jobs — while "Now yours — no report from the
   * runner for <N>m" is the push's own heading (§4.6, revision 23). No delivery to a coordinator
   * conversation (X-D7), and no turn, session, wake or job write: the tick never ends, releases or
   * abandons a job — a result, a stop, a retry door and the abandon doors (J-T10, the owner's and
   * the coordinator's) do that, each in its own transaction.
   *
   * WHAT ENDS IT. Every edge in the transaction that moves the claim on (`resolveLeaseExpiredItems`):
   * a report, a release, a takeover's first report, any terminal state. A generation that changed
   * without one of those edges leaves an item `reconcile` closes as not owed.
   */
  async openLeaseExpiredItems(): Promise<OpenedLeaseItem[]> {
    const statement = Prisma.sql`
      WITH due AS MATERIALIZED (
        -- The claims that are due, read without a lock: what the parents below are taken for.
        SELECT j."id" AS "jobId", j."project_id" AS "projectId", live_task."id" AS "taskId",
               j."promotion_id" AS "promotionId"
        ${leaseExpiredClaims()}),
      -- The rows the item's foreign keys check, taken before the keys check them and in rank order:
      -- the projects (40), then the tasks that are still there (50), then the candidates (60), each
      -- set sorted by id, FOR KEY SHARE (the keys' own mode) and SKIP LOCKED, which leaves a row out
      -- instead of waiting when another transaction holds it FOR UPDATE, is deleting it or is
      -- changing its key (what PostgreSQL still waits for is under WHAT IT CAN STILL WAIT FOR above).
      -- PostgreSQL runs the branches of a UNION ALL in the order they are written, and
      -- MATERIALIZED keeps the CTE a scan of its own rather than folded into a reader.
      held AS MATERIALIZED (
        SELECT 'project' AS "parent", held_project."id"
          FROM (SELECT pr."id" FROM "project" pr
                 WHERE pr."id" IN (SELECT "projectId" FROM due)
                 ORDER BY pr."id"
                   FOR KEY SHARE SKIP LOCKED) held_project
        UNION ALL
        SELECT 'task', held_task."id"
          FROM (SELECT t."id" FROM "task" t
                 WHERE t."id" IN (SELECT "taskId" FROM due)
                 ORDER BY t."id"
                   FOR KEY SHARE SKIP LOCKED) held_task
        UNION ALL
        SELECT 'promotion', held_promotion."id"
          FROM (SELECT c."id" FROM "project_promotion" c
                 WHERE c."id" IN (SELECT "promotionId" FROM due)
                 ORDER BY c."id"
                   FOR KEY SHARE SKIP LOCKED) held_promotion)
      INSERT INTO "project_open_item" (
        "id", "project_id", "owner_id", "kind", "assignee", "assignee_reason",
        "task_id", "session_id", "integration_job_id", "promotion_id",
        "dedupe_key", "title", "payload",
        "waiting_since", "assigned_at", "escalated_at", "escalate_at", "remind_at")
      SELECT gen_random_uuid(), j."project_id", j."owner_id", 'LANDING_LEASE_EXPIRED',
             'OWNER', 'ESCALATED',
             live_task."id", j."session_id", j."id", j."promotion_id",
             'LE:' || j."id"::text || ':' || j."claim_generation"::text,
             -- §4.2's title for this kind: 'No word from the runner: <task>', and the promotion
             -- jobs name what they were merging instead. The heading "Now yours — no report from
             -- the runner for <N>m" is the push's and the card's (§4.6, revision 23), not the row's.
             'No word from the runner: ' || CASE j."kind"
               WHEN 'CHECK_PROMOTION' THEN 'Merge check'
               WHEN 'LAND_PROMOTION' THEN 'Merge to main'
               ELSE COALESCE(live_task."title", 'a task') END,
             jsonb_build_object(
               'jobId', j."id"::text,
               'jobKind', j."kind",
               'claimGeneration', j."claim_generation",
               'runnerId', j."runner_id"::text,
               'runner', r."name",
               'lastReportAt', to_char(COALESCE(j."heartbeat_at", j."claimed_at") AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'heartbeatAt', to_char(COALESCE(j."heartbeat_at", j."claimed_at") AT TIME ZONE 'UTC',
                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'leaseExpiredAt', to_char((COALESCE(j."heartbeat_at", j."claimed_at")
                                           + (${leaseLimitSeconds('j')} * interval '1 second'))
                                         AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'generation', j."generation",
               'phase', j."phase",
               'step', j."step",
               'round', j."round",
               -- The check the claim was on: its index and how many checks the run has (0434's
               -- current_check column; absent before a check starts and on a legacy claim). Not the
               -- M of the Step row's round, which the card takes from jobKind (7.2 V6). No backticks
               -- in here: this whole statement is a JS template literal.
               'checkIndex', NULLIF(j."current_check"->>'index', '')::int,
               'checkCount', NULLIF(j."current_check"->>'count', '')::int,
               'progressProtocol', j."progress_protocol",
               'pushReported', (j."push_reported_generation" IS NOT NULL
                                AND j."push_reported_generation" = j."claim_generation"),
               'landingSessionId', landing."session_id"::text),
             now(), now(), now(), NULL, NULL
        ${leaseExpiredClaims()}
         -- Only the claims whose every parent the CTE holds. A job's project is never NULL, so no
         -- row reaches the lock below before the first of these arrays is read, and each of them
         -- reads the whole CTE: every parent is held before the first job is.
         AND j."project_id" = ANY(ARRAY(SELECT "id" FROM held WHERE "parent" = 'project'))
         AND (live_task."id" IS NULL
              OR live_task."id" = ANY(ARRAY(SELECT "id" FROM held WHERE "parent" = 'task')))
         AND (j."promotion_id" IS NULL
              OR j."promotion_id" = ANY(ARRAY(SELECT "id" FROM held WHERE "parent" = 'promotion')))
      -- The job FOR SHARE SKIP LOCKED: a transaction writing it (a report, a chunk or a result in
      -- flight) holds it in a mode FOR SHARE conflicts with, and that claim is the next tick's
      -- rather than a wait. A report that committed after this statement's snapshot is not missed:
      -- READ COMMITTED locks the job's newest version and checks the WHERE again on it, which sees
      -- the renewed heartbeat and drops the row. In id order, so every tick inserts its keys in the
      -- same order.
      ORDER BY j."id"
      FOR SHARE OF j SKIP LOCKED
      ON CONFLICT ("project_id", "dedupe_key") WHERE "state" = 'OPEN' DO NOTHING
      RETURNING "id" AS "itemId", "project_id" AS "projectId", "owner_id" AS "ownerId"`;
    const lockTimeout = `${this.leaseAlarmLockTimeoutMs}ms`;
    let opened: OpenedLeaseItem[];
    try {
      opened = await this.prisma.$transaction(async (tx) => {
        // SET LOCAL lock_timeout, in the function form that takes its value as a parameter: it ends
        // with this transaction, so the pooled connection's next user never runs under it.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
        return tx.$queryRaw<OpenedLeaseItem[]>(statement);
      });
    } catch (error) {
      // A lock not granted within the timeout: the statement asks for nothing NOWAIT, so this is the
      // one way it raises lock_not_available. PostgreSQL cancelled it and the transaction rolled back,
      // so nothing was written, and the next tick asks again from committed rows.
      if (!isLockNotAvailable(error)) throw error;
      this.logger.warn(`${LANDING_LEASE_EXPIRED_KIND} alarm left to the next tick: a lock it waited for `
        + `was not granted within ${this.leaseAlarmLockTimeoutMs} ms, so it opened nothing`);
      return [];
    }
    for (const item of opened) {
      this.logger.warn(`opened ${LANDING_LEASE_EXPIRED_KIND} ${item.itemId} of project `
        + `${item.projectId}: the runner stopped reporting`);
    }
    return opened;
  }

  /**
   * The backstop (§4.2): close every OPEN item nobody owes any more, and say which ones those were.
   *
   * An item is closed by the transaction that moves what it is about, one edge per fact, and this
   * catches the edge somebody missed. By the same facts and in the same order, it writes the ending
   * that edge would have written: `resolveByFact`'s three statements, one per family — a task's
   * failure (`TASK_DONE` / `SUCCESSOR_FILED` / `TASK_CLOSED` / `RETRIED`), an integration item about
   * a dead task (`SUCCESSOR_FILED` when a successor took it over, `TASK_CLOSED` when it was
   * cancelled) and a delivery review (`RETRIED` / `SUCCESSOR_FILED` / `TASK_CLOSED`) — and for an item
   * about a candidate the edge's own `PROMOTION_MOVED_ON`, with the state `closePromotionItems`
   * writes (SUPERSEDED when the candidate was). An X-E5 item whose claim moved without an edge
   * (`LANDING_LEASE_EXPIRED`) ends with the same `JOB_MOVED_ON` its edges write, RESOLVED, naming
   * `job <id>@<state>`. All by the PLATFORM, with a `resolution_note` that
   * starts `backstop:` and names the fact as it stands — the one thing here an edge never writes — so
   * an item closed here can be told apart from one its edge closed and a missing edge is something a
   * query can count. Each one is also a warning in the log, which is where somebody learns an edge is
   * missing: the kind, what the item was about and where that stands now, how long it was open,
   * and whose it was. The owners whose items closed have their badge recounted, since an item they
   * held may have been one of the four it counts.
   *
   * A compare-and-set like the sweep: the statement takes only OPEN items that are not owed and moves
   * them out of that set, so two replicas close each item once and the next tick finds nothing.
   *
   * An integration item whose task LANDED after it was opened is left open — that the work reached
   * another branch is in no row (`openItemOwed`) — and reported instead, once per process.
   */
  async reconcile(): Promise<ReconciledOpenItem[]> {
    const closed = await this.prisma.$queryRaw<ReconciledOpenItem[]>(Prisma.sql`
      UPDATE "project_open_item" item
         SET "state" = CASE WHEN stale."kind" = ${LANDING_LEASE_EXPIRED_KIND} THEN 'RESOLVED'
                            WHEN stale."promotionState" = 'SUPERSEDED' THEN 'SUPERSEDED'
                            ELSE 'RESOLVED' END,
             "resolution" = stale."resolution",
             "resolved_by" = 'PLATFORM', "resolved_at" = now(), "updated_at" = now(),
             "resolution_note" = 'backstop: ' || stale."about" || stale."why"
                                 || '; no edge closed this item when that happened'
        FROM (
          SELECT stale_item."id", stale_item."kind",
                 promotion."state" AS "promotionState",
                 CASE WHEN stale_item."kind" = ${LANDING_LEASE_EXPIRED_KIND}
                        THEN 'job ' || job."id"::text || '@' || job."state"
                      WHEN stale_item."promotion_id" IS NOT NULL
                      THEN 'promotion ' || promotion."id"::text || '@' || promotion."state"
                      ELSE 'task ' || task."id"::text || '@' || task."status"::text END AS "about",
                 -- resolveByFact's three CASEs, family by family, in their own order: the ending
                 -- each family's edge writes, read off the same two rows that edge reads. X-E5's
                 -- item is about one claim, and every edge that moves that claim writes
                 -- JOB_MOVED_ON — the same ending here, whatever state the job is in now.
                 CASE WHEN stale_item."kind" = ${LANDING_LEASE_EXPIRED_KIND} THEN 'JOB_MOVED_ON'
                      WHEN stale_item."promotion_id" IS NOT NULL THEN 'PROMOTION_MOVED_ON'
                      WHEN stale_item."kind" = 'TASK_FAILED' THEN
                        CASE WHEN task."status" = 'DONE' THEN 'TASK_DONE'
                             WHEN task."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                             WHEN task."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                             ELSE 'RETRIED' END
                      WHEN stale_item."kind" = 'DELIVERY_REVIEW' THEN
                        CASE WHEN task."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                             WHEN task."status" = 'CANCELLED' THEN 'TASK_CLOSED'
                             ELSE 'RETRIED' END
                      WHEN stale_item."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS)})
                        THEN CASE WHEN task."superseded_by_task_id" IS NOT NULL THEN 'SUCCESSOR_FILED'
                                  ELSE 'TASK_CLOSED' END
                      ELSE 'TASK_CLOSED' END AS "resolution",
                 -- The fact, not the ending — the same branch of each family's CASE, said in words.
                 -- A review whose task was returned to work reads "left DONE" and is never called the
                 -- cancellation it is not; one whose task really was cancelled is.
                 CASE WHEN stale_item."kind" = ${LANDING_LEASE_EXPIRED_KIND}
                        THEN ' is no longer the claim that stopped reporting'
                      WHEN stale_item."kind" = 'PROMOTION_APPROVAL'
                        THEN ' is not READY, so the card asks nothing'
                      WHEN stale_item."promotion_id" IS NOT NULL THEN ' is no longer live'
                      WHEN stale_item."kind" = 'TASK_FAILED' THEN
                        CASE WHEN task."status" = 'DONE' THEN ' left FAILED'
                             WHEN task."superseded_by_task_id" IS NOT NULL
                               THEN ' was superseded by task ' || task."superseded_by_task_id"::text
                             WHEN task."status" = 'CANCELLED' THEN ' was cancelled'
                             ELSE ' is being attempted again' END
                      WHEN stale_item."kind" = 'DELIVERY_REVIEW' THEN
                        CASE WHEN task."superseded_by_task_id" IS NOT NULL
                               THEN ' was superseded by task ' || task."superseded_by_task_id"::text
                             WHEN task."status" = 'CANCELLED' THEN ' was cancelled'
                             ELSE ' left DONE' END
                      ELSE CASE WHEN task."superseded_by_task_id" IS NOT NULL
                                  THEN ' was superseded by task ' || task."superseded_by_task_id"::text
                                ELSE ' was cancelled' END END AS "why"
            FROM "project_open_item" stale_item
            LEFT JOIN "project_promotion" promotion ON promotion."id" = stale_item."promotion_id"
            LEFT JOIN "task" task ON task."id" = stale_item."task_id"
            LEFT JOIN "project_integration_job" job ON job."id" = stale_item."integration_job_id"
           WHERE stale_item."state" = 'OPEN' AND NOT ${openItemOwed('stale_item')}
        ) stale
       WHERE item."id" = stale."id" AND item."state" = 'OPEN'
      RETURNING item."id" AS "itemId", item."project_id" AS "projectId", item."owner_id" AS "ownerId",
                item."kind", item."assignee", item."assignee_reason" AS "assigneeReason",
                stale."about", item."created_at" AS "createdAt"`);
    for (const item of closed) {
      this.logger.warn(`backstop closed ${item.kind} ${item.itemId} of project ${item.projectId}: `
        + `${item.about}, open ${openFor(item.createdAt)}, `
        + `with ${item.assignee} (${item.assigneeReason})`);
    }
    for (const ownerId of new Set(closed.map((item) => item.ownerId))) {
      this.push?.scheduleBadgeSync(ownerId);
    }
    await this.reportLanded();
    return closed;
  }

  /**
   * The integration items about a task that has since LANDED, which `openItemOwed` keeps owed: the
   * item asks for the work on this project's line, and a receipt on some other branch does not say
   * that happened. Read only, and each one reported once by this process.
   */
  private async reportLanded(): Promise<void> {
    const landed = await this.prisma.$queryRaw<Array<ReconciledOpenItem & {
      /** The branches its landed receipts name. */
      branches: string;
    }>>(Prisma.sql`
      SELECT item."id" AS "itemId", item."project_id" AS "projectId", item."owner_id" AS "ownerId",
             item."kind", item."assignee", item."assignee_reason" AS "assigneeReason",
             'task ' || task."id"::text || '@' || task."status"::text AS "about",
             item."created_at" AS "createdAt",
             string_agg(DISTINCT receipt."target_branch", ', ') AS "branches"
        FROM "project_open_item" item
        JOIN "task" task ON task."id" = item."task_id"
        JOIN "session_merge_receipt" receipt
          ON receipt."task_id" = item."task_id"
         AND receipt."result" IN (${Prisma.join(LANDED_RESULTS)})
         AND receipt."created_at" AT TIME ZONE 'UTC' > item."created_at"
       WHERE item."state" = 'OPEN' AND item."promotion_id" IS NULL
         AND item."kind" IN (${Prisma.join(INTEGRATION_ITEM_KINDS)})
         AND ${openItemOwed('item')}
       GROUP BY item."id", task."id"`);
    for (const item of landed) {
      if (this.reportedLanded.has(item.itemId)) continue;
      this.reportedLanded.add(item.itemId);
      this.logger.warn(`backstop left ${item.kind} ${item.itemId} of project ${item.projectId} open: `
        + `${item.about} landed on ${item.branches} after it was opened, `
        + `open ${openFor(item.createdAt)}, with ${item.assignee} (${item.assigneeReason})`);
    }
  }
}

/** How long an item has been open, as a log line says it: `3d4h`, `5h12m`, `7m`. */
function openFor(since: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - since.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}
