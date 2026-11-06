-- 0476 — the wiki chat's session (contracts/wiki.contract.json `chat.binding`, `chat.source` and
-- `chat.notes`; docs/wiki-contract.md §28.1, §28.2 and §28.4; docs/project-source-contract.md SR54;
-- task C5 of the wiki chat project).
--
-- WHAT IT ADDS
-- ============
--   1. `session.wiki_chat_space_id` — the space a chat belongs to. A session is a chat exactly when it
--      is set. Written only by the chat's create, in the session row's own INSERT, and never afterwards:
--      a session is a chat for its whole life or never, and the trigger below refuses an UPDATE that
--      would change it. No foreign key (storage.ids: a reference into history): deleting a space
--      leaves its chats as sessions and this id a tombstone. A NULL default is catalog-only: no
--      rewrite, no scan.
--   2. `session_wiki_chat_space_idx` over (wiki_chat_space_id, created_at), which the chats read of a
--      space walks newest first. Partial, so the sessions that are no chat (all of them before this
--      migration) are not in it. schema.prisma cannot spell a partial index, so it lives here alone,
--      as 0231's `session_source_codebase_idx` does.
--   3. `CHAT_UPSTREAM`, SOURCE's sixth kind (SR54): `session_source_kind_chk` takes it,
--      `session_source_kind_selector_chk` allows it only as a ref-valued selector, and
--      `session_source_snapshot_chk` makes it the one non-UNBOUND shape whose codebase and
--      configRevision are NULL and which contains nothing it must hold. The three are added back
--      NOT VALID inside this file's transaction and validated after its COMMIT, as 0436 does: inside,
--      the ALTER's ACCESS EXCLUSIVE lock covers catalog changes only; outside, each VALIDATE scans
--      under SHARE UPDATE EXCLUSIVE, which blocks no read and no write. No row holds the new kind
--      before this migration, so every row passes as it passed the CHECKs it replaces.
--   4. `conversation_turn.wiki_context` — the page and the selection an owner's message to a chat
--      carried (`{ page?, selection? }`, chat.notes.wikiContext): ids, never text. Delivery reads the
--      sentences and footnotes they name when it hands the turn to the runner (chat.notes), so the
--      turn's content stays the owner's words alone.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing row reads NULL in both new columns, so no session is a chat and nothing any of them
-- does changes (chat.binding.otherSessions). An older apiserver writes neither column, and rolling the
-- code back leaves them unread.

BEGIN;

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "wiki_chat_space_id" UUID;

ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "wiki_context" JSONB;

-- `UPDATE OF`, as 0231's SOURCE guard: a statement that does not name the column cannot change it, so
-- the session table's heartbeat-rate writes never call this.
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

COMMIT;

-- After the COMMIT, each in its own transaction: see 3. above.
ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_chk";
ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_selector_chk";
ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_snapshot_chk";

-- Outside the transaction too: building it reads the whole table, and here it holds the table's SHARE
-- lock only while it does, rather than until a COMMIT that also waits on the three scans above.
CREATE INDEX IF NOT EXISTS "session_wiki_chat_space_idx"
  ON "session" ("wiki_chat_space_id", "created_at") WHERE "wiki_chat_space_id" IS NOT NULL;
