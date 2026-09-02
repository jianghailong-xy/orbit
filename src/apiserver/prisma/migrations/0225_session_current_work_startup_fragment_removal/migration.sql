-- 0210 added an append-only startup-context table so an explicit CURRENT_WORK send could join the
-- opening turn's envelope while that turn was still waiting for a runner. Nothing ever reached it:
-- every explicit `intent` was refused with 503 SESSION_TURN_PROTOCOL_DISABLED unless
-- ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED was 1, and it is 0 in the only deployment there is.
-- The table therefore holds no rows, and the 503 was what stopped a coordinator from messaging a
-- session that was waiting for one. Both halves are removed here.
--
-- What is deliberately NOT removed: `conversation_turn` itself and the exact-target CURRENT_WORK
-- steer that joins a turn already running. Those are the live-turn half of the protocol, they keep
-- their columns, their CHECKs and their same-session target FK, and the unique key that FK needs
-- (`conversation_turn_session_id_id_key`) stays with them.

-- Fail closed. This drops a table; refuse to run at all if it is not the empty one 0210 created,
-- rather than deleting authored input nobody knew was there. Deliberately not wrapped in an
-- explicit BEGIN/COMMIT: Prisma already runs the file in one transaction, and an explicit one
-- reports "transaction is aborted" instead of the message below.
DO $$
DECLARE
  fragments bigint;
BEGIN
  SELECT count(*) INTO fragments FROM "conversation_turn_startup_fragment";
  IF fragments <> 0 THEN
    RAISE EXCEPTION
      'SESSION_STARTUP_FRAGMENT_REMOVAL_HAS_ROWS: % startup fragment(s) would be destroyed',
      fragments;
  END IF;
END $$;

-- The attachment side first: the FK is what makes the table undroppable, and the CHECK that names
-- the column has to go before the column can. With one owner left there is nothing to arbitrate.
ALTER TABLE "attachment" DROP CONSTRAINT "attachment_single_message_owner_check";
ALTER TABLE "attachment" DROP CONSTRAINT "attachment_startup_fragment_id_fkey";
DROP INDEX "attachment_startup_fragment_id_idx";
ALTER TABLE "attachment" DROP COLUMN "startup_fragment_id";

-- Explicit, though DROP TABLE would cascade to them: the inventory replay in
-- db-write-inventory.spec.ts models a dropped table's cascade, but naming what goes is what lets a
-- reader of this file see it without replaying anything.
DROP INDEX "conversation_turn_startup_target_created_idx";
DROP INDEX "conversation_turn_startup_session_client_key";
DROP TABLE "conversation_turn_startup_fragment";
