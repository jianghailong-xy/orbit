-- 0476 — the wiki chat's session (contracts/wiki.contract.json `chat.binding`, `chat.source` and
-- `chat.notes`; docs/wiki-contract.md §28.1, §28.2 and §28.4; docs/project-source-contract.md SR54;
-- task C5 of the wiki chat project). 0479 finishes it: it validates the CHECKs below and builds the index.
--
-- WHAT IT ADDS
-- ============
--   1. `session.wiki_chat_space_id` — the space a chat belongs to. A session is a chat exactly when it
--      is set. Written only by the chat's create, in the session row's own INSERT, and never afterwards:
--      a session is a chat for its whole life or never, and the trigger below refuses an UPDATE that
--      would change it. No foreign key (storage.ids: a reference into history): deleting a space
--      leaves its chats as sessions and this id a tombstone. A NULL default is catalog-only: no
--      rewrite, no scan.
--   2. `CHAT_UPSTREAM`, SOURCE's sixth kind (SR54): `session_source_kind_chk` takes it,
--      `session_source_kind_selector_chk` allows it only as a ref-valued selector, and
--      `session_source_snapshot_chk` makes it the one non-UNBOUND shape whose codebase and
--      configRevision are NULL and which contains nothing it must hold. The three are added back
--      NOT VALID, which every new and updated row is held to at once, and 0479 validates them. No row
--      holds the new kind before this migration, so every row passes as it passed the CHECKs they
--      replace.
--   3. `conversation_turn.wiki_context` — the page and the selection an owner's message to a chat
--      carried (`{ page?, selection? }`, chat.notes.wikiContext): ids, never text. Delivery reads the
--      sentences and footnotes they name when it hands the turn to the runner (chat.notes), so the
--      turn's content stays the owner's words alone.
--
-- TAKING THE LOCKS IN SHORT TRIES
-- ===============================
-- `session` and `conversation_turn` are read by every runner call and every inbox poll. Holding a
-- lock on either is short here, but waiting for one is the danger, as for 0478: a statement waiting
-- for a lock queues each later reader and writer of the table behind it. With production's
-- lock_timeout of 30 s (docker-compose.yml), a long wait also fails the migration, and a failed
-- migration stops the apiserver from starting, and the image before it too (P3009).
--
-- `migrate deploy` sends a file that contains a DO statement to the server whole, as ONE statement,
-- which PostgreSQL runs as one transaction. A file without one goes a statement at a time (drilled
-- with this repo's Prisma 7.10 and the server's statement log, task C5, 2026-11-06). So this whole
-- file is one transaction, and every lock it takes is held until it ends. Hence:
--   - The guard's function first. Replacing a function writes pg_proc and locks no table. It is a
--     plain statement, where db-write-inventory.spec.ts reads trigger functions' bodies.
--   - Then ONE DO, which takes both tables in each try: `session` first, then `conversation_turn`,
--     in the order every transaction that takes both does (the lock-order ranks, 30 then 60), each in
--     ACCESS EXCLUSIVE mode, which the ADD COLUMNs, the trigger and the CHECK swaps need. lock_timeout
--     is 2 s per lock. A try that cannot have both gives back the one it had, waits 1 s in which
--     everything else runs, and tries again. A deadlock is taken as a failed try too. At most 45
--     tries, each at most 2 s + 2 s + 1 s: under 4 minutes, inside statement_timeout's 300 s. After
--     the last try it raises a clear error that says what to do.
--   - Inside the try, catalog changes only: no statement here reads a row. So the two locks are held
--     for milliseconds once taken. The three VALIDATE scans and the index build are 0479's, a file
--     without a DO, whose statements go one by one, outside any transaction.
-- Every statement is safe to run twice (IF NOT EXISTS, IF EXISTS).
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing row reads NULL in both new columns, so no session is a chat and nothing any of them
-- does changes (chat.binding.otherSessions). An older apiserver writes neither column, and rolling the
-- code back leaves them unread.

-- The guard's function. `UPDATE OF`, as 0231's SOURCE guard: a statement that does not name the column
-- cannot change it, so the session table's heartbeat-rate writes never call this.
CREATE OR REPLACE FUNCTION session_wiki_chat_space_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."wiki_chat_space_id" IS DISTINCT FROM OLD."wiki_chat_space_id" THEN
    RAISE EXCEPTION
      'WIKI_CHAT_SPACE_IMMUTABLE: session % was made a chat or not when it was created; a chat is a new session',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Both tables in one try, then the catalog changes.
DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session", "conversation_turn" IN ACCESS EXCLUSIVE MODE;

      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "wiki_chat_space_id" UUID;

      ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "wiki_context" JSONB;

      DROP TRIGGER IF EXISTS "session_wiki_chat_space_guard" ON "session";
      CREATE TRIGGER "session_wiki_chat_space_guard"
        BEFORE UPDATE OF "wiki_chat_space_id" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_wiki_chat_space_guard();

      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_chk"
        CHECK ("source_kind" IS NULL OR "source_kind" IN (
          'VERIFICATION_SUBJECT', 'PINNED_REVISION', 'TASK_KNOWN_GOOD',
          'DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM', 'CHAT_UPSTREAM')) NOT VALID;

      -- §4.1's truth table, with the chat's row: origin/main's tip is a ref, like an upstream's.
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_selector_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_selector_chk"
        CHECK ("source_kind" IS NULL
           OR ("source_kind" IN ('VERIFICATION_SUBJECT', 'TASK_KNOWN_GOOD') AND "source_revision_sha" IS NOT NULL)
           OR ("source_kind" IN ('DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM', 'CHAT_UPSTREAM') AND "source_ref" IS NOT NULL)
           OR "source_kind" = 'PINNED_REVISION') NOT VALID;

      -- The shapes per state, 0231's two and the chat's between them. A chat resolves against no
      -- `ProjectCodebase`, so it has no binding and no configuration version to freeze (SR54), and it must
      -- contain nothing: it is not a task with prerequisites. Its identity and authority are still there —
      -- the workspace's repository, asked through origin.
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_snapshot_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_snapshot_chk"
        CHECK (CASE WHEN "source_state" = 'UNBOUND' THEN
                 "source_kind" IS NULL AND "source_codebase_id" IS NULL
                 AND "source_repo_url" IS NULL AND "source_root_commit_sha" IS NULL
                 AND "source_ref" IS NULL AND "source_revision_sha" IS NULL
                 AND "source_config_revision" IS NULL AND "source_ref_authority" IS NULL
                 AND "source_required_contains" = '{}'::CHAR(40)[]
                 AND "source_base_sha" IS NULL AND "source_resolved_at" IS NULL
                 AND "source_resolved_by_runner_id" IS NULL
                 AND "source_refusal_code" IS NULL AND "source_refusal_detail" IS NULL
               WHEN "source_kind" = 'CHAT_UPSTREAM' THEN
                 "source_codebase_id" IS NULL AND "source_config_revision" IS NULL
                 AND "source_repo_url" IS NOT NULL AND "source_ref_authority" IS NOT NULL
                 AND "source_ref" IS NOT NULL AND "source_revision_sha" IS NULL
                 AND "source_required_contains" = '{}'::CHAR(40)[]
               ELSE
                 "source_kind" IS NOT NULL AND "source_codebase_id" IS NOT NULL
                 AND "source_repo_url" IS NOT NULL AND "source_config_revision" IS NOT NULL
                 AND "source_ref_authority" IS NOT NULL
                 AND (("source_ref" IS NULL) <> ("source_revision_sha" IS NULL))
               END) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0476: "session" and "conversation_turn" were not both free in 45 tries of 2 s each. Once what holds them has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0476_wiki_chat_session) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
