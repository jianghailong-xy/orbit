-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- share_link.wiki_space_id: a public link can be rooted at a wiki space — the space's home and
-- every document written for it, read-only (docs/share-links-design.md §10).
--
-- WHAT CHANGES
-- ------------
--   wiki_space_id   The fourth root column beside session_id, task_id and project_id. Exactly one of
--                   the four is set: `share_link_one_root_chk` is replaced by the same CHECK over all
--                   four (one ALTER, so there is no moment without it).
--   the foreign key `(wiki_space_id, owner_id)` → `wiki_space (id, owner_id)`, ON DELETE CASCADE:
--                   the composite key every table of the wiki is reached through (0307), so a link
--                   can only ever be rooted at a space of its own owner's, and deleting the space
--                   deletes its links. A row whose wiki_space_id is NULL is not checked against it
--                   (MATCH SIMPLE), which is every session, task and project link.
--   one more partial unique index, `(wiki_space_id) WHERE revoked_at IS NULL`: at most one link per
--                   space that has not ended, as 0306 holds for the other three roots.
--
-- The layer a wiki link has (`footnotes`) lives in `include` as every layer does; nothing about the
-- column changes.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written or deleted: every existing link keeps its one root, which the new CHECK still
-- counts as one. `wiki_space` is named only as the table the foreign key references. No function,
-- trigger or type is created, replaced or dropped, and no task, project or session object is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0403: the highest number on every branch of origin and in every local worktree was 0402 when this
-- landed (2026-10-08). Every statement can run twice: ADD COLUMN IF NOT EXISTS, the CHECK
-- dropped IF EXISTS and added in the same ALTER, the foreign key inside a `duplicate_object` guard,
-- and CREATE UNIQUE INDEX IF NOT EXISTS.

ALTER TABLE "share_link" ADD COLUMN IF NOT EXISTS "wiki_space_id" UUID;

-- Exactly one root, of four.
ALTER TABLE "share_link"
  DROP CONSTRAINT IF EXISTS "share_link_one_root_chk",
  ADD CONSTRAINT "share_link_one_root_chk"
    CHECK (num_nonnulls("session_id", "task_id", "project_id", "wiki_space_id") = 1);

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_wiki_space_fkey"
    FOREIGN KEY ("wiki_space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One link per space that has not ended.
CREATE UNIQUE INDEX IF NOT EXISTS "share_link_wiki_space_active_key"
  ON "share_link" ("wiki_space_id") WHERE "revoked_at" IS NULL;
