import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/** How the board reads, in the order a reader cares about. */
const KIND_LABEL: Record<string, string> = {
  quota_hold: 'Dispatch held by quota',
  disk_hold: 'Dispatch held by low disk',
  foreman_filed: 'Stalled, coordinating task dispatched',
  completion_reverted: 'Completion reverted',
};

/**
 * Reports a list's conditions into the conversation that steers it.
 *
 * The delivery model is a piggyback, not a push: conditions are appended to the next message the
 * console session receives, and nothing here ever starts a turn. That is a deliberate choice
 * rather than a limitation.
 *
 * A push would mean a second thing that can wake an agent on a timer, sitting next to the foreman,
 * which already exists to do exactly that and already carries the escalating backoff and the cap
 * it needed to stop re-firing. Two independent wake paths against one condition is the shape that
 * produced both of this deployment's runaway-dispatch incidents — the foreman that filed a fresh
 * coordinator every stall window, and the auto-run reconciler's two 60s timers re-driving the same
 * failed tasks. A quota outage is not more urgent than the foreman's own stall detection; it is
 * the same event, and it does not need its own alarm clock.
 *
 * So: the sweep records (cheap, always), the console reports what it has been told (free, when
 * someone is already talking to it), and the foreman remains the only thing that wakes anybody.
 */
@Injectable()
export class ListEventsService {
  private readonly logger = new Logger(ListEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append this session's list conditions to `content`, or return it unchanged.
   *
   * Returns unchanged for every session that is not some list's console — which is nearly all of
   * them — at the cost of one indexed lookup already being made for the owner.
   *
   * `tx` is the delivery transaction: the read and the delivered-stamp have to be atomic with the
   * turn being handed out, or a redelivery after a crash would report the same conditions twice or
   * (worse) mark them reported into a message that never arrived.
   */
  async appendFor(
    tx: Prisma.TransactionClient,
    sessionId: string,
    content: string | null | undefined,
  ): Promise<string | null | undefined> {
    try {
      const lists = await tx.taskList.findMany({
        where: { ownerSessionId: sessionId },
        select: { id: true, title: true },
      });
      if (lists.length === 0) return content;
      const blocks: string[] = [];
      for (const list of lists) {
        const block = await this.blockFor(tx, list.id, list.title);
        if (block) blocks.push(block);
      }
      if (blocks.length === 0) return content;
      return `${content ?? ''}\n\n${blocks.join('\n\n')}`;
    } catch (e) {
      // A note for a human must never cost the turn it was going to ride along with.
      this.logger.warn(
        `could not attach list conditions to session ${sessionId}: ${e instanceof Error ? e.message : e}`,
      );
      return content;
    }
  }

  private async blockFor(
    tx: Prisma.TransactionClient,
    listId: string,
    title: string,
  ): Promise<string | null> {
    const events = await tx.taskListEvent.findMany({ where: { listId } });
    // Due when it has never been reported, or when the condition has been seen again since it was.
    // Comparing the two timestamps is what makes a standing outage announce itself once per
    // conversation rather than once per 60s sweep — the alternative, clearing the stamp on every
    // upsert, re-reports 240 times an hour into a session that has nothing new to act on.
    const due = events.filter((e) => !e.deliveredAt || e.deliveredAt < e.lastSeenAt);
    if (due.length === 0) return null;
    const now = new Date();
    await tx.taskListEvent.updateMany({
      where: { id: { in: due.map((e) => e.id) } },
      data: { deliveredAt: now },
    });
    const lines = due
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map(
        (e) =>
          `  ${KIND_LABEL[e.kind] ?? e.kind} | ${e.detail} | first seen ${e.firstSeenAt.toISOString()}` +
          `, last seen ${e.lastSeenAt.toISOString()}, seen ${e.occurrences} time(s)`,
      );
    return [
      // Spelled base62, the same as the `id` the agent gets back from `tasklist_get`. Prose is the
      // one boundary `PublicIdInterceptor` cannot reach — it rewrites response *fields*, and a
      // message body is not one — so the encode happens here, where the id becomes text. The
      // lookup and the delivered-stamp above stay on the uuid the column holds.
      `<list-conditions list="${uuidToBase62(listId)}" title="${title}">`,
      ...lines,
      `  The above is what the control plane observed since you last received a message, not something the user said.`,
      `  A high "seen" count with a recent "last seen" = the condition still holds; an old "last seen" = it has passed on its own.`,
      `  For a fuller picture of where things stand, read it yourself with tasklist_get / task_list.`,
      `</list-conditions>`,
    ].join('\n');
  }
}
