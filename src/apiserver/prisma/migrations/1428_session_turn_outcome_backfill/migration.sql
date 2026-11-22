-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1428: the turn outcome of every failure the status alone records (docs/session-three-state-design.md §12.6,
-- removal step R6, decision D9; project 3508bDBDE5xPH43TYuiqP). Deploy 3.
--
-- WHY
-- ---
-- "Released by a failure" is `finished_at IS NOT NULL AND end_reason IS NULL AND last_turn_outcome = 'FAILED'`
-- (common/session-release.ts). Deploy 2 also read `status = 'FAILED'` beside the turn outcome, the status bridge,
-- because the writers of deploy 1 and earlier (the reaper, the runner's finalize, the refused source, the import)
-- record a failure in the status alone: their rows say FAILED and carry no FAILED turn outcome (the hand-over shapes
-- H2, H4, H6 of common/session-release-shapes.fixture.ts, and every such row released before deploy 2). Removal step
-- R7 drops the bridge (1429 and the release module); this file first writes, for each of those rows, the turn
-- outcome the bridge was answering with, so that no stored row changes its answer.
--
-- WHAT IT WRITES
-- --------------
-- <bridged>: finished_at IS NOT NULL AND end_reason IS NULL AND status = 'FAILED'
--            AND last_turn_outcome IS DISTINCT FROM 'FAILED' AND deleted_at IS NULL
--
--   1. conversation_turn, one statement: on each <bridged> session, the turn §12.1's rule names as carrying the
--      failure, the work turn (kind message or shell) IN_FLIGHT, else the oldest PENDING one, gets outcome FAILED and
--      the session's error, when it has no outcome yet. Only the outcome and the error: where the turn stands in the
--      queue is not this file's to move. After a deploy-1 release the drains have answered every turn but the one a
--      refused source leaves PENDING (W4), so that is in practice the only turn written. Old turns with no outcome
--      stay null; 1202 already covered the FAILED rows that existed before 1201. The rule's last resort (the latest
--      work turn, which only the finalize with nothing in flight and the API-error backstop take) is not applied: a
--      stored row does not say which writer released it.
--   2. session, one statement: last_turn_outcome = 'FAILED' on every <bridged> row; and last_turn_outcome =
--      'CANCELLED' on the residual shape A2 (released, status other than FAILED, no end reason, last_turn_outcome
--      FAILED: a failed turn's copy kept through a release that was no failure), by the coordinator's ruling of
--      2026-11-21 on task 351QPAh8wuz6nl3n1ghm2, touching no turn. The <bridged> half never writes A2: it writes only
--      FAILED rows. Production held 0 A2 rows on 2026-11-21 and 2026-11-22.
--   Statement 1 runs first: it finds its sessions by <bridged>, which statement 2 empties.
--
-- Deleted rows (Trash) are not written: a failed transcript import (W5) is released FAILED into Trash with no turn,
-- and nothing failed in a conversation there; the readers of the failure question do not reach a trashed row (the
-- evidence of task 351QPAh8wuz6nl3n1ghm2 lists them).
--
-- AFTERWARDS
-- ----------
-- SELECT count(*) FROM session WHERE <bridged> is 0, and so is the A2 count. Every stored row then answers "released
-- by a failure" the same with or without the bridge, but for A2 (now a stop, as ruled) and trashed rows.
--
-- TRIGGERS IT FIRES
-- -----------------
-- Statement 2 names last_turn_outcome, which the three ended-triggers of 1425 list (AFTER UPDATE OF ... FOR EACH ROW).
-- Their WHEN clauses read the failure question with the bridge, which answers the same before and after for every
-- <bridged> row, so each fires where it fired for the write that released the row, and its function only closes
-- what is still open on an ended session: OPEN requests to it (recipient_ended, when no retry is armed), a held
-- reply's comment due (asker_stopped), an unanswered review whose reviewer it is (reviewer_ended, only for a filed
-- row: a failure is not "ended" to it). Whatever those writes closed then is closed already; the pre-check of the
-- task's evidence counts what is still open on these rows (0 expected). For an A2 row, which turns into a stop,
-- reviewer_ended fires as a stop's release fires it. The statement-level open-list epoch triggers of both tables bump their epochs. No BEFORE UPDATE
-- trigger of session lists last_turn_outcome, and none of conversation_turn lists outcome or error.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- Deploy 3 only, once deploy 2 is live on every server: a deploy-1 server would go on releasing failures without a
-- turn outcome after this file ran. 1429 (the bridge leaves the triggers) and the release module without the bridge
-- ride the same deploy, after it.
--
-- LOCKS, SIZE
-- -----------
-- Row locks only (ROW EXCLUSIVE on both tables). Production had 12,201 sessions on 2026-11-22; the FAILED rows the
-- statements touch are a few hundred at most, so each is one set-based statement, not batches. Asked for in one DO
-- statement with lock_timeout 2 s, 1 s apart, up to 45 tries, as 1261 does, so a row a live writer holds makes it
-- wait and try again rather than queue behind it. How it is sent: the file holds a DO block, so prisma migrate deploy
-- (7.10) sends it whole, as one transaction; the two statements commit together. Nothing in it COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1428: the next free number above 1427 (main, project/* and pushed orbit/* scanned 2026-11-22). Not a multiple of
-- 10. Can run twice: a second run finds no row of either shape.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      UPDATE "conversation_turn" AS t
         SET "outcome" = 'FAILED',
             "error" = s."error"
        FROM "session" AS s
       WHERE t."session_id" = s."id"
         AND s."finished_at" IS NOT NULL
         AND s."end_reason" IS NULL
         AND s."status" = 'FAILED'
         AND s."last_turn_outcome" IS DISTINCT FROM 'FAILED'
         AND s."deleted_at" IS NULL
         AND t."outcome" IS NULL
         AND t."id" = (
           SELECT c."id"
             FROM "conversation_turn" AS c
            WHERE c."session_id" = s."id"
              AND c."kind" IN ('message', 'shell')
              AND c."status" IN ('IN_FLIGHT', 'PENDING')
            ORDER BY (c."status" = 'IN_FLIGHT') DESC, c."seq" ASC
            LIMIT 1
         );

      UPDATE "session"
         SET "last_turn_outcome" = CASE WHEN "status" = 'FAILED' THEN 'FAILED' ELSE 'CANCELLED' END
       WHERE "finished_at" IS NOT NULL
         AND "end_reason" IS NULL
         AND (("status" = 'FAILED' AND "last_turn_outcome" IS DISTINCT FROM 'FAILED' AND "deleted_at" IS NULL)
              OR ("status" <> 'FAILED' AND "last_turn_outcome" = 'FAILED'));
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
