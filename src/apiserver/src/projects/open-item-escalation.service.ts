import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { LANDED_RESULTS } from './project-criterion-landing';
import { INTEGRATION_ITEM_KINDS, openItemOwed } from './project-open-item';

/**
 * How often the clock looks. Not how long anything waits: each item carries its own
 * `escalate_at`, frozen from its project's window when it was opened (§4.1, X-E2), so a tick is
 * only the resolution at which a due item is noticed.
 */
const TICK_MS = 60_000;

/** One item this tick handed over, for whoever tells the owner about it. */
export interface EscalatedOpenItem {
  itemId: string;
  projectId: string;
  ownerId: string;
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
 * The clock counts the coordinator's silence, not the item's age. An item is opened with
 * `escalate_at` = the moment it started waiting + its project's window (§4.1, frozen by X-E2), and
 * that is when it goes to the owner if nothing is carrying it. It is carried while the conversation
 * the project is coordinated from — live, and holding a delivery of the item that was not taken back
 * — has moved since the item was put on it: been handed a turn, or finished one. The item then stays
 * the coordinator's until a full window (its own, `escalate_at - waiting_since`) has passed since
 * that conversation last moved. So a conversation that is busy, or working through a queue, keeps
 * what it was given; one that is wedged, has gone quiet or has ended hands it over one window after
 * it stopped; and an item that never reached anybody goes when its window runs out, as it always did.
 *
 * Moving is read from committed turn facts: `delivered_at`, written when `dequeueTurn` hands a turn
 * to an engine, and `answered_at`, when that turn completes. Only a turn an engine was actually
 * handed counts — ending or interrupting a conversation retires its queued turns in place as
 * ANSWERED, and a turn nobody ran is not the conversation moving — and only a `message` turn, since
 * a control turn (an interrupt, an end, a reload) is acked on delivery and is somebody else acting on
 * the conversation. Both columns are `timestamp`, written in UTC.
 */
export function escalatesAt(alias: string): Prisma.Sql {
  const item = Prisma.raw(`"${alias}"`);
  return Prisma.sql`GREATEST(${item}."escalate_at", (
    SELECT max(COALESCE(turn."answered_at", turn."delivered_at") AT TIME ZONE 'UTC')
           + (${item}."escalate_at" - ${item}."waiting_since")
      FROM "project" proj
      JOIN "session" coordinator ON coordinator."id" = proj."coordinator_session_id"
      JOIN "project_open_item_delivery" delivery
        ON delivery."session_id" = coordinator."id"
       AND delivery."item_id" = ${item}."id"
       AND delivery."purpose" = 'ITEM'
       AND delivery."returned_at" IS NULL
      JOIN "conversation_turn" turn
        ON turn."session_id" = coordinator."id"
       AND turn."kind" = 'message'
       AND turn."delivered_at" IS NOT NULL
       AND COALESCE(turn."answered_at", turn."delivered_at") AT TIME ZONE 'UTC' >= delivery."created_at"
     WHERE proj."id" = ${item}."project_id"
       AND proj."coordinator_enabled"
       AND ${item}."assignee" = 'COORDINATOR'
       -- The conversation can still take a turn: it has not ended (sessionHasEnded, in SQL), and
       -- nobody has asked it to (the inbox hands no message to a conversation whose end is asked).
       AND coordinator."deleted_at" IS NULL
       AND coordinator."completed_at" IS NULL
       AND coordinator."archived_at" IS NULL
       AND coordinator."cancel_requested_at" IS NULL
       AND (coordinator."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT')
            OR (coordinator."status" = 'INTERRUPTED' AND COALESCE(coordinator."end_reason", '') = ''))))`;
}

/**
 * The one clock this platform adds (`docs/project-integration-line-contract.md` §4.6 X-E1).
 *
 * WHAT IT IS FOR. An exception item has an assignee, and the project's coordinator conversation can
 * be one of them. A conversation that is not reading — because it is wedged, because nobody restarts
 * it, because the item never reached it — leaves the item waiting with no end, and the whole point of
 * the item was that somebody is expected to act on it. So an item nobody has carried for longer than
 * its project's window stops being the coordinator's and becomes the account owner's. Carried is
 * read off the conversation, not the item (`escalatesAt`): a coordinator that has the item and is
 * still taking turns is acting on it however long ago it was opened, and handing its work to the owner
 * at the two-hour mark only locked the conversation out of what it was doing (§4.7).
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
      // The backstop first, so what the sweep then hands over is only what somebody still owes. Its
      // failure does not cost the sweep, which asks `openItemOwed` itself.
      this.reconcile()
        .catch((e) => this.logger.error(`reconcile failed: ${(e as Error).message}`))
        .then(() => this.sweep())
        .then((escalated) => {
          // Told to the person it just became the problem of, and to nobody else: the sweep itself
          // stays a write of one column, which is what makes it safe to run on every replica.
          for (const item of escalated) void this.push?.notifyOwnerItem(item.itemId);
        })
        .catch((e) => this.logger.error(`sweep failed: ${(e as Error).message}`));
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
   * The backstop (§4.2): close every OPEN item nobody owes any more, and say which ones those were.
   *
   * An item is closed by the transaction that moves what it is about, one edge per fact, and this
   * catches the edge somebody missed. It writes the ending that edge would have written —
   * PROMOTION_MOVED_ON for an item about a candidate (SUPERSEDED when the candidate was, as
   * `closePromotionItems` writes it), TASK_CLOSED for one about a cancelled or replaced task, both by
   * the PLATFORM — with a `resolution_note` that starts `backstop:` and names the fact, so an item
   * closed here can be told apart from one its edge closed and a missing edge is something a query
   * can count. Each one is also a warning in the log, which is where somebody learns an edge is
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
         SET "state" = CASE WHEN stale."promotionState" = 'SUPERSEDED' THEN 'SUPERSEDED'
                            ELSE 'RESOLVED' END,
             "resolution" = CASE WHEN item."promotion_id" IS NOT NULL THEN 'PROMOTION_MOVED_ON'
                                 ELSE 'TASK_CLOSED' END,
             "resolved_by" = 'PLATFORM', "resolved_at" = now(), "updated_at" = now(),
             "resolution_note" = 'backstop: ' || stale."about" || stale."why"
                                 || '; no edge closed this item when that happened'
        FROM (
          SELECT stale_item."id",
                 promotion."state" AS "promotionState",
                 CASE WHEN stale_item."promotion_id" IS NOT NULL
                      THEN 'promotion ' || promotion."id"::text || '@' || promotion."state"
                      ELSE 'task ' || task."id"::text || '@' || task."status"::text END AS "about",
                 CASE WHEN stale_item."kind" = 'PROMOTION_APPROVAL'
                        THEN ' is not READY, so the card asks nothing'
                      WHEN stale_item."promotion_id" IS NOT NULL THEN ' is no longer live'
                      WHEN task."superseded_by_task_id" IS NOT NULL
                        THEN ' was replaced by task ' || task."superseded_by_task_id"::text
                      ELSE ' was cancelled' END AS "why"
            FROM "project_open_item" stale_item
            LEFT JOIN "project_promotion" promotion ON promotion."id" = stale_item."promotion_id"
            LEFT JOIN "task" task ON task."id" = stale_item."task_id"
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
