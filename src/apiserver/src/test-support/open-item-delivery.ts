import { Prisma, PrismaClient } from '@prisma/client';

/** Fixtures for tests of post-delivery behavior: the engine received the item when it was assigned.
 * The delivery itself is written by the product door; only its observed timestamp is simulated. */
export async function receiveOpenItem(db: PrismaClient, itemId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "conversation_turn" turn SET "delivered_at" = item."waiting_since"
      FROM "project_open_item_delivery" delivery, "project_open_item" item
     WHERE item."id" = ${itemId}::uuid AND delivery."item_id" = item."id"
       AND delivery."purpose" = 'ITEM'
       AND turn."session_id" = delivery."session_id"
       AND turn."client_turn_id" = delivery."client_turn_id"`);
}
