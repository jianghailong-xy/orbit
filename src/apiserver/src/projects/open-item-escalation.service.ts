import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

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

/**
 * The one clock this platform adds (`docs/project-integration-line-contract.md` §4.6 X-E1).
 *
 * WHAT IT IS FOR. An exception item has an assignee, and the project's coordinator conversation can
 * be one of them. A conversation that is not reading — because it is wedged, because nobody restarts
 * it, because it is busy with something else — leaves the item waiting with no end, and the whole
 * point of the item was that somebody is expected to act on it. So an item unhandled for longer than
 * its project's window stops being the coordinator's and becomes the account owner's.
 *
 * WHY A CLOCK IS ALLOWED HERE AND NOWHERE ELSE. Every other input in this system is routed on a
 * COMMITTED FACT — evidence revised, a receipt written, a turn ended — and elapsed time is not one:
 * a timer that starts agent work invents work nobody asked for, which is exactly the loop the
 * completion-input contract took out. This clock is the exception because what it produces is not
 * agent work. It writes the item's assignee and nothing else; a person then reads it in their own
 * open items. No turn, no session, no wake row, no delivery — the assertions in
 * `exception-escalation.pg.spec.ts` count all four across the whole database, before and after.
 *
 * WHAT MAKES IT SAFE TO RUN ANYWHERE. The statement is its own compare-and-set: it selects only
 * items that are still OPEN, still the coordinator's and already due, and the same UPDATE takes them
 * out of that selection. Two apiservers ticking at the same moment escalate each item once between
 * them, and a tick that runs every minute for an hour after an item came due escalates it on the
 * first one and reports nothing on the other fifty-nine.
 */
@Injectable()
export class ProjectOpenItemEscalationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectOpenItemEscalationService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    /** X-E1's one reader: an item that became the owner's is one of the four things their phone is
     *  told about (§7.6 V12). `@Optional()`, so a build or a spec without PushModule escalates
     *  exactly as before — the assignee is the fact, and the banner is a consequence of it. */
    @Optional() private readonly push?: PushService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweep()
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
   */
  async sweep(): Promise<EscalatedOpenItem[]> {
    return this.prisma.$queryRaw<EscalatedOpenItem[]>(Prisma.sql`
      UPDATE "project_open_item"
         SET "assignee" = 'OWNER', "assignee_reason" = 'ESCALATED', "assigned_at" = now(),
             "escalated_at" = now(), "updated_at" = now()
       WHERE "state" = 'OPEN' AND "assignee" = 'COORDINATOR' AND "escalate_at" <= now()
      RETURNING "id" AS "itemId", "project_id" AS "projectId", "owner_id" AS "ownerId"`);
  }
}
