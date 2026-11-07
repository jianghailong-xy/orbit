-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, the Trash (docs/mocks/wiki-trash, owner's picks of 2026-11-07): deleting a wiki moves it to Trash, where it
-- is kept 365 days and can be restored; after that, or when the owner deletes it permanently, it is deleted in the
-- background in small batches. contracts/wiki.contract.json `space.trash` and docs/wiki-contract.md are the authority.
--
-- WHY
-- ---
-- The first delete (9dced799a) removed a wiki and all it holds in one transaction. On production, under a CPU-saturated
-- host, that transaction ran past its 60 s deadline for a wiki of 14,165 entries and was rolled back whole (2026-11-07).
-- Moving a wiki to Trash is now one short UPDATE of its row; what it holds goes later, a batch at a time.
--
-- WHAT IS ADDED, to wiki_space
-- ----------------------------
--   deleted_at              when it was moved to Trash; NULL for every wiki in use.
--   purge_at                when it is due to be deleted for good: 365 days after deleted_at, or the moment the owner
--                           asked for it. Set exactly when deleted_at is.
--   purge_lease_until       which purge holds it, as a lease: a purge takes a due wiki only while no other one's lease
--                           runs, so two apiserver processes never delete the same wiki's rows side by side.
--   trashed_slug            the slug it had. While it is in Trash its slug is a placeholder of its own id, and its
--   trashed_repo_url_norm   repository NULL, so that a new wiki can be made under the same name and on the same
--                           repository, and nothing that finds a wiki by its name or by its repository finds this one —
--                           the workspaces on that repository among them, which are in a wiki by their URL alone.
--                           Restoring puts both back.
-- A CHECK holds the five together, and a partial index finds the wikis whose purge is due.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No row is written: every wiki keeps NULL in all five and stays as it is. The unique keys on (owner_id, slug) and
-- (owner_id, repo_url_norm) stay as they are. Code from before this migration neither reads nor writes these columns.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ------------------------------
-- Adding columns, the CHECK and the index needs ACCESS EXCLUSIVE on wiki_space, which every write of the wiki reads FOR
-- KEY SHARE through a foreign key. Holding it is short: the table has one row per wiki. Waiting for it is the danger, as
-- 0482 says: a waiting ALTER queues each later reader and writer behind it, and production's lock_timeout of 30 s would
-- fail the migration and stop the apiserver from starting. So the lock is asked for 2 s at a time, with 1 s between
-- tries, up to 60 tries, in one DO statement. The CHECK is proved of the stored rows under the lock: a handful of rows.
--
-- RE-RUNNABILITY
-- --------------
-- 0486 follows 0483, the highest number on main, the project branches and the pushed task branches on 2026-11-07, and
-- leaves 0484 and 0485 to two task branches not yet pushed (0484_wiki_same, 0485_session_last_user_from): neither names
-- a column added here, so either order is the same schema. The whole file can run twice: columns and the index IF NOT
-- EXISTS, the CHECK only when the table has none of that name.
-- If the DO runs out of tries, nothing of it stays and its error says what to do.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "wiki_space"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(3),
        ADD COLUMN IF NOT EXISTS "purge_at" TIMESTAMPTZ(3),
        ADD COLUMN IF NOT EXISTS "purge_lease_until" TIMESTAMPTZ(3),
        ADD COLUMN IF NOT EXISTS "trashed_slug" TEXT,
        ADD COLUMN IF NOT EXISTS "trashed_repo_url_norm" TEXT;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = '"wiki_space"'::regclass
                        AND conname = 'wiki_space_trash_chk') THEN
        ALTER TABLE "wiki_space" ADD CONSTRAINT "wiki_space_trash_chk" CHECK (
          -- In Trash or not, all at once: a due date and the name it had come with the move.
          ("deleted_at" IS NULL) = ("purge_at" IS NULL)
          AND ("deleted_at" IS NULL) = ("trashed_slug" IS NULL)
          -- A wiki in Trash holds no repository, so a new one can; a wiki in use keeps no trashed name and no lease.
          AND ("deleted_at" IS NULL OR "repo_url_norm" IS NULL)
          AND ("deleted_at" IS NOT NULL OR ("trashed_repo_url_norm" IS NULL AND "purge_lease_until" IS NULL))
          AND ("purge_at" IS NULL OR "purge_at" >= "deleted_at" - interval '1 second')
        );
      END IF;
      CREATE INDEX IF NOT EXISTS "wiki_space_purge_idx" ON "wiki_space" ("purge_at") WHERE "deleted_at" IS NOT NULL;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE EXCEPTION '0486: "wiki_space" was not free in 60 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0486_wiki_space_trash) and deploy again.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
