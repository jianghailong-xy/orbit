import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * turn-complete's one Feishu step (docs/feishu-bot-design.md §7.5, §1.3 item 6): after the turn's transaction has
 * committed, in a statement of its own, register the turn's reply when the session has a Feishu chain. One INSERT … SELECT
 * reads the chain spoken in last (feishu_thread, of the session's own account) and the turn's last assistant text — the
 * workspace's own words, not a sub-agent's — and writes nothing when either is missing. `turn_id` is unique, so a
 * re-posted completion writes nothing more; a turn whose first completion had no words (it was handed out again) is
 * registered by the completion that has them.
 *
 * It never throws: a failure is logged and the turn-complete that called it answers as it would have. Nothing here
 * talks to Feishu; FeishuOutboxService (feishu-outbox.ts) does, on any replica.
 */
export async function registerFeishuReply(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  logger: Pick<Logger, 'warn'>,
  turn: { sessionId: string; ownerId: string; turnId: string },
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "feishu_outbox" ("id", "owner_id", "app_id", "session_id", "turn_id", "chat_id", "root_message_id", "text")
      SELECT ${randomUUID()}::uuid, t."owner_id", t."app_id", t."session_id", ${turn.turnId}::uuid, t."chat_id", t."root_message_id", e."text"
      FROM (
        SELECT "owner_id", "app_id", "session_id", "chat_id", "root_message_id" FROM "feishu_thread"
        WHERE "session_id" = ${turn.sessionId}::uuid AND "owner_id" = ${turn.ownerId}::uuid
        ORDER BY "last_spoken_at" DESC, "id" DESC
        LIMIT 1
      ) AS t
      CROSS JOIN LATERAL (
        SELECT "payload"->>'text' AS "text" FROM "run_event"
        WHERE "turn_id" = ${turn.turnId}::uuid AND "session_id" = ${turn.sessionId}::uuid AND "type" = ${RunEventType.ASSISTANT}
          AND "payload"->>'parentToolUseId' IS NULL AND btrim(coalesce("payload"->>'text', '')) <> ''
        ORDER BY "seq" DESC
        LIMIT 1
      ) AS e
      ON CONFLICT ("turn_id") DO NOTHING`;
  } catch (error) {
    logger.warn(`turn ${turn.turnId} of session ${turn.sessionId}: its Feishu reply was not registered: ${messageOf(error)}`);
  }
}
