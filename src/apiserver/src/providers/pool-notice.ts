import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';

/**
 * The transcript lines a pool owes its sessions (`session.pool_switch_notice`), carried by the next
 * `init` / `resumed` the runner reports (RunnerApiController.events) — never a run event of this server's
 * own: the runner numbers a session's events, and a row written here would take the seq its next event is
 * about to use (server-must-not-insert-run-event-rows). The line is owed by the claim that moves a
 * shared-pool session onto another key (QueueService.resolveSharedPool) or a login-pool session onto
 * another account (QueueService.resolveLoginPool), and by the pool gateway when a login pool's account is
 * spent or signed out (PoolLoginGatewayService, `owe`); the carrier is queued by the claim that follows it.
 * A plain class rather than a provider, since those two live on either side of the ProvidersModule →
 * QueueModule import.
 */
export class PoolNotices {
  private readonly logger = new Logger('PoolNotices');

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * A `reload` that asks nothing of the engine — no model, no mode, no provider, so the inbox hands it out
   * with no environment (RunnerApiController.reloadProviderEnv) and the runner re-spawns nothing — for a
   * line to ride on. A runner answers every reload with a `resumed` event, and the inbox delivers a reload
   * ahead of the message waiting behind it, so on a resident engine the line lands just before the turn
   * it is about. On an engine a claim starts, the start's own event has taken the line by then, and the
   * `resumed` this earns carries nothing and draws nothing. Passing a provider also refreshes the
   * environment: a direct Claude credential or runner account change must restart its warm process.
   */
  async carrier(sessionId: string, provider?: string): Promise<void> {
    const clientTurnId = `pool-key-switch:${randomUUID()}`;
    await withTransactionRetry(this.prisma, async (tx) => {
      // The seq is allocated under the Session's own lock, as every other producer of a turn does.
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const last = await tx.conversationTurn.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.conversationTurn.create({
        data: {
          sessionId,
          seq: (last?.seq ?? 0) + 1,
          kind: 'reload',
          content: provider ? JSON.stringify({ provider }) : '{}',
          clientTurnId,
          status: 'PENDING',
        },
      });
    }, loggedRetry(this.logger, 'queue.queueSwitchNoticeCarrier'));
    this.realtime.notifyInbox(sessionId);
  }

  /**
   * Owe `sessionId`'s transcript `notice` — unless it already owes one, which is left as it stands and
   * carried first. True when this call owed it. No carrier is queued here: the gateway owes a line while
   * the turn it is about is still running, and that turn's failure answers every row queued behind it —
   * the claim that next runs the session queues the carrier (QueueService.resolveLoginPool), and an
   * engine that claim starts carries the line on its own `init`.
   */
  async owe(sessionId: string, notice: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, poolSwitchNotice: null },
      data: { poolSwitchNotice: notice },
    });
    return count > 0;
  }
}
