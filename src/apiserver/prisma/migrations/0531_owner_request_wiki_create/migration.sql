-- 0531: a fifth owner request kind, WIKI_CREATE — an agent asking the owner to create a wiki for its workspace's
-- repository (docs/wiki-explicit-creation-design.md §3.6, project 34w5Xsc80OaZkbtsbrfEb).
--
--   owner_request.repo_url_norm  WIKI_CREATE: the repository the wiki is for, normalized as wiki_space.repo_url_norm is,
--                                read by the server from the asking session's workspace. NULL for every other kind.
--   owner_request.workspace_id   WIKI_CREATE: the asking session's workspace, which the wiki's maintenance reads the
--                                repository from when the owner presses Create wiki. History, no foreign key.
--   owner_request_wiki_create_pending_key  at most one PENDING WIKI_CREATE per (owner, repository): a second filing
--                                meets it and answers the open card.
--
-- Constraint swaps, two nullable columns and one partial index: no row is written, no trigger or function is named.
-- Every statement can run twice.
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "repo_url_norm" TEXT;
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "workspace_id" UUID;

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE'));
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_wiki_create_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_wiki_create_chk"
  CHECK (("kind" = 'WIKI_CREATE') = ("repo_url_norm" IS NOT NULL AND "workspace_id" IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "owner_request_wiki_create_pending_key"
  ON "owner_request" ("owner_id", "repo_url_norm") WHERE "kind" = 'WIKI_CREATE' AND "state" = 'PENDING';
