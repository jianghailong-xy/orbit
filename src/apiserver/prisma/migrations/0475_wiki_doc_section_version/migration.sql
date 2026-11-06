-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, the wiki chat (project 34sYUuoSpnReXXn6j28WR, task C3): the versions a section keeps.
-- docs/wiki-chat-design.md section 8.4 and docs/wiki-contract.md section 30 (contracts/wiki.contract.json
-- `docs.versions`) are the authority for everything below; src/apiserver/src/wiki/wiki-doc-versions.pg.spec.ts
-- holds these CHECKs to the contract's closed sets.
--
-- WHAT IS ADDED
-- -------------
--   wiki_doc_section_version   one row per section a write replaced: the section as it stood — its blocks,
--                              its sentences (text, status, footnote numbers, new tokens, withdrawal), its
--                              footnotes, the origin/main commit it was generated at, the fingerprint of its
--                              material, the model, its statistics and ledger, and when it was generated — with
--                              why it was replaced (reason: maintenance, build, merge, landing, chat or
--                              restore, and the title, commit or plan version the reason names), when, and
--                              what replaced it: the job that wrote (job_id), or the owner's restore of an
--                              earlier version (restored_version_id). replaced_at says when; seq orders a
--                              section's versions, the newest last, two writes in the same millisecond too.
--
-- WHO WRITES IT. WikiDocs.write, in its own transaction, for every section it replaces whoever asked for the
-- write (a maintenance run, a build, a follow job), and the owner's restore of a version; a section written
-- for the first time replaced nothing, and one left unchanged was not written again. At most 5 versions a
-- section (docs.versions.rules.perSection): keeping one more deletes the oldest in the same transaction.
--
-- TENANCY
-- -------
-- As every wiki child reaches its parent (0307, 0326): (space_id, owner_id) references wiki_space ON DELETE
-- CASCADE, so a space's delete takes its versions. The document and section are named by slug and key, as
-- the plan names them across its versions, not by the rows a rewrite deletes: a version outlives the section
-- row it was taken from. The job and the version a restore put back are history references with no foreign
-- key (contract `storage.historyRefs`).
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No existing row is written, read or locked, and no existing table gains a column: the table starts empty,
-- and wiki_space is named only as the parent its foreign key references. No function, trigger or type is
-- created, replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0475: main, every origin/project/* and every pushed origin/orbit/* branch stood at 0474 or below when this
-- was written (2026-11-06); task C5 of the same project, written beside it, was told to take a later number.
-- Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS, with the table's constraints inside its
-- CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_doc_section_version" (
  "id"                  UUID NOT NULL,
  "space_id"            UUID NOT NULL,
  "owner_id"            UUID NOT NULL,
  "doc_slug"            TEXT NOT NULL,
  "section_key"         TEXT NOT NULL,
  -- The section as it stood.
  "blocks"              JSONB NOT NULL,
  "sentences"           JSONB NOT NULL,
  "footnotes"           JSONB NOT NULL,
  "repo_sha"            TEXT NOT NULL,
  "material_sha256"     CHAR(64) NOT NULL,
  "model"               TEXT,
  "stats"               JSONB NOT NULL DEFAULT '{}',
  "dispositions"        JSONB NOT NULL DEFAULT '[]',
  "generated_at"        TIMESTAMPTZ(3) NOT NULL,
  -- Why, when and by what it was replaced.
  "reason"              TEXT NOT NULL,
  "reason_title"        TEXT,
  "reason_sha"          TEXT,
  "reason_plan_version" INTEGER,
  "job_id"              UUID,
  "restored_version_id" UUID,
  "replaced_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seq"                 BIGSERIAL NOT NULL,
  CONSTRAINT "wiki_doc_section_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_doc_section_version_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_doc_section_version_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_doc_section_version_slug_chk" CHECK ("doc_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("doc_slug") <= 64),
  CONSTRAINT "wiki_doc_section_version_key_chk" CHECK ("section_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("section_key") <= 64),
  -- [{ kind, text? }, …], [{ block, text, status, notes, newTokens, withdrawn }, …] and [{ kind, ref, … }, …]: the
  -- section's rows as they stood, a sentence's notes the places of its footnotes in the list beside it.
  CONSTRAINT "wiki_doc_section_version_rows_chk" CHECK (
    jsonb_typeof("blocks") = 'array' AND jsonb_typeof("sentences") = 'array' AND jsonb_typeof("footnotes") = 'array'
    AND jsonb_typeof("stats") = 'object' AND jsonb_typeof("dispositions") = 'array'),
  CONSTRAINT "wiki_doc_section_version_repo_sha_chk" CHECK ("repo_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "wiki_doc_section_version_material_chk" CHECK ("material_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "wiki_doc_section_version_model_chk" CHECK ("model" IS NULL OR (btrim("model") <> '' AND char_length("model") <= 200)),
  CONSTRAINT "wiki_doc_section_version_reason_chk" CHECK ("reason" IN ('maintenance', 'build', 'merge', 'landing', 'chat', 'restore')),
  -- A merge, a landing and a chat name their session's, task's, project's or chat's title; a merge and a landing
  -- the commit they put on main; a build the plan version it wrote. No other reason names any of it.
  CONSTRAINT "wiki_doc_section_version_title_chk" CHECK (
    ("reason" IN ('merge', 'landing', 'chat')) = ("reason_title" IS NOT NULL)
    AND ("reason_title" IS NULL OR (btrim("reason_title") <> '' AND char_length("reason_title") <= 500))),
  CONSTRAINT "wiki_doc_section_version_sha_chk" CHECK (
    ("reason" IN ('merge', 'landing')) = ("reason_sha" IS NOT NULL)
    AND ("reason_sha" IS NULL OR "reason_sha" ~ '^[0-9a-f]{7,64}$')),
  CONSTRAINT "wiki_doc_section_version_plan_version_chk" CHECK (
    ("reason" = 'build') = ("reason_plan_version" IS NOT NULL)
    AND ("reason_plan_version" IS NULL OR "reason_plan_version" >= 1)),
  -- What replaced it: the job that wrote, or the owner's restore of an earlier version — one of the two.
  CONSTRAINT "wiki_doc_section_version_replaced_by_chk" CHECK (
    ("reason" = 'restore') = ("job_id" IS NULL)
    AND ("reason" = 'restore') = ("restored_version_id" IS NOT NULL))
);
-- A section's versions, newest first: its version list, its latest change on the document read, and the
-- retention that keeps the newest five.
CREATE INDEX IF NOT EXISTS "wiki_doc_section_version_section_idx"
  ON "wiki_doc_section_version" ("space_id", "doc_slug", "section_key", "seq");
-- A space's versions, newest first: Activity's Docs rows.
CREATE INDEX IF NOT EXISTS "wiki_doc_section_version_space_seq_idx" ON "wiki_doc_section_version" ("space_id", "seq");
