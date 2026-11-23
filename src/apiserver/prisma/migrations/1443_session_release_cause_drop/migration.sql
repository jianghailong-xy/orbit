-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1443: session.release_cause and its CHECK go (docs/session-three-state-design.md §12.6, removal step R8, decision
-- D9; project 3508bDBDE5xPH43TYuiqP). Deploy 3, the last migration of the removal.
--
-- WHAT IT CHANGES
-- ---------------
--   ALTER TABLE session DROP CONSTRAINT session_release_cause_chk   (1261, widened by 1403 and validated by 1404)
--   ALTER TABLE session DROP COLUMN release_cause                    (1261)
-- The session keeps no fact about failure: a failure is the carrying turn's outcome and error, copied to
-- last_turn_outcome; why an end was asked for is end_reason; released is finished_at.
--
-- WHAT DEPENDS ON THE COLUMN
-- --------------------------
-- On a database migrated to 1442, pg_depend lists exactly the CHECK on session.release_cause (two rows: the
-- constraint's own reference and its automatic one): 1401's second clause and 1406 were removed before they were
-- deployed (removal step R1), and the three ended-triggers stopped reading the column in 1425 (R4). No function
-- body, trigger, index or view names it (sessions/session-release-column-compat.pg.spec.ts). The DO block below
-- checks that again on the database it runs on, and refuses to drop anything if another object depends on the
-- column, instead of letting DROP COLUMN take it away or fail half-way.
--
-- WHY NOW, AND WHY NOT EARLIER
-- ----------------------------
-- Prisma selects every column of a model it declares, so the column can go only one release after the field left
-- schema.prisma (removal step R5, deploy 2). Deploy 2 no longer reads or writes it; a deploy-1 server still wrote it
-- during deploy 2's hand-over, harmlessly. Once deploy 2 is live on every server nothing touches it.
--
-- ROLLBACK
-- --------
-- Irreversible: the values are gone. A rollback of the code to deploy 2 after this file works, because deploy 2's
-- Prisma model has no release_cause field and no SQL of deploy 2 names the column (the compat spec runs deploy 2's
-- writers on a database without it). A rollback to deploy 1 is not possible after this file: deploy 1 writes the
-- column. This file must stay the last of the removal; nothing after it may need the column back.
--
-- LOCKS
-- -----
-- Both statements take ACCESS EXCLUSIVE on session, for a catalog change only (DROP COLUMN rewrites no row, DROP
-- CONSTRAINT checks none). Asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries, as 1261 does,
-- so a long reader makes it wait and try again rather than queue every writer behind it. How it is sent: the file
-- holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction. Nothing in it COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1443: after 1442 (main, project/*, pushed orbit/* and probe/* scanned 2026-11-22; written as 1431, then 1435), the
-- last of deploy 3 and of the removal. Can run
-- twice: IF EXISTS on both, and the dependency check reads nothing once the column is gone.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
  others text;
BEGIN
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ')
    INTO others
    FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refclassid = 'pg_class'::regclass
     AND d.refobjid = '"session"'::regclass
     AND a.attname = 'release_cause'
     AND NOT (d.classid = 'pg_constraint'::regclass
              AND d.objid = (SELECT oid FROM pg_constraint
                              WHERE conrelid = '"session"'::regclass AND conname = 'session_release_cause_chk'));
  IF others IS NOT NULL THEN
    RAISE EXCEPTION 'session.release_cause is still read by %: nothing was dropped', others;
  END IF;

  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_cause_chk";
      ALTER TABLE "session" DROP COLUMN IF EXISTS "release_cause";
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
