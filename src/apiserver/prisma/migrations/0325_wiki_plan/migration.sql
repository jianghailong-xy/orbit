-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 11: the plan. Before a wiki's documents are written, the local model
-- drafts a plan — categories, the documents in each, every document's reader, scope and outline, and
-- where each section's material comes from — and the owner confirms it. contracts/wiki.contract.json
-- `plan` is the authority for everything below, and src/apiserver/src/wiki/wiki-plan.pg.spec.ts holds
-- these CHECKs to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_plan           one row per VERSION of a space's plan: its number, its status (draft,
--                       confirmed, superseded), who made it (a maintenance run's drafting job, or the
--                       owner), the version it revises, its categories, the fields it declared as
--                       needing adding, the document count it was held to, the gate's report, the
--                       repository check the runner reported with the sha it checked at, and who
--                       confirmed it when.
--   wiki_plan_doc       one row per document of a version: its category, slug, title, the reader's
--                       question, who it is written for, what it covers and what it leaves to which
--                       other document, its expected length, and whether it is protected.
--   wiki_plan_section   one row per section of a document: its order, its stable key, title, kind,
--                       what it covers, its length, and the conditions its material is taken by
--                       (design-doc sections, code files and symbols, contracts; for a session
--                       condition the projects, time window, keywords, anchor paths, entry kinds
--                       and topics).
--   wiki_plan_proposal  a change to the plan a maintenance run proposed: why, the document as it
--                       should read, the facts that led to it, and the owner's answer.
--
-- A CONFIRMED VERSION IS NEVER CHANGED. Documents and sections are only ever inserted: an edit, a
-- redraft or an accepted proposal is a new version with rows of its own, and the one row a version
-- ever has updated is its own wiki_plan row, when it is confirmed or superseded. At most one version of
-- a space is a draft and at most one is confirmed (two partial unique indexes).
--
-- TENANCY
-- -------
-- As every wiki child reaches its parent (0307): wiki_plan and wiki_plan_proposal reach wiki_space
-- through (space_id, owner_id), a document its version through (plan_id, owner_id), a section its
-- document through (doc_id, owner_id), all ON DELETE CASCADE — a space's delete takes its plan and its
-- proposals. The session and user ids that say who drafted, confirmed or decided are history
-- references with no foreign key (contract `storage.historyRefs`), and so is wiki_plan.proposal_id,
-- the proposal whose acceptance made a version: provenance, which a cascade from its proposal must
-- not take away.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No existing row is written, read or locked, and no existing table gains a column: the four tables
-- start empty, and wiki_space is named only as the parent two foreign keys reference. No function,
-- trigger or type is created, replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0325: origin/main stood at 0324 and project/34VR0RwUSIcaoO7ZZqv52 at 0322 when this was written
-- (2026-09-29), and the project's coordinator gave 0325 to this task and 0326 to the documents'
-- storage. Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS, with each table's
-- constraints inside its CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_plan" (
  "id"                   UUID NOT NULL,
  "space_id"             UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  "version"              INTEGER NOT NULL,
  "status"               TEXT NOT NULL,
  "origin"               TEXT NOT NULL,
  "base_version"         INTEGER,
  "proposal_id"          UUID,
  "categories"           JSONB NOT NULL,
  "new_fields"           JSONB NOT NULL DEFAULT '[]',
  "docs_min"             INTEGER NOT NULL,
  "docs_max"             INTEGER NOT NULL,
  "gate"                 JSONB NOT NULL,
  "repo_sha"             TEXT,
  "repo_check"           JSONB,
  "model"                TEXT,
  "author_session_id"    UUID,
  "author_user_id"       UUID,
  "confirmed_by_user_id" UUID,
  "confirmed_at"         TIMESTAMPTZ(3),
  "superseded_at"        TIMESTAMPTZ(3),
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_plan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_plan_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_plan_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_plan_version_chk" CHECK ("version" >= 1),
  CONSTRAINT "wiki_plan_status_chk" CHECK ("status" IN ('draft', 'confirmed', 'superseded')),
  CONSTRAINT "wiki_plan_origin_chk" CHECK ("origin" IN ('maintenance', 'owner')),
  -- A version revises an earlier one, or none: the first draft of a space.
  CONSTRAINT "wiki_plan_base_version_chk" CHECK ("base_version" IS NULL OR ("base_version" >= 1 AND "base_version" < "version")),
  -- A drafting job's version names the maintenance run that submitted it; the owner's, the owner.
  CONSTRAINT "wiki_plan_author_chk" CHECK (
    ("origin" = 'maintenance' AND "author_session_id" IS NOT NULL AND "author_user_id" IS NULL)
    OR ("origin" = 'owner' AND "author_user_id" IS NOT NULL AND "author_session_id" IS NULL)),
  -- Who confirmed it and when, together; a draft was never confirmed, a confirmed version was.
  CONSTRAINT "wiki_plan_confirmed_chk" CHECK (
    ("confirmed_at" IS NULL) = ("confirmed_by_user_id" IS NULL)
    AND ("status" <> 'confirmed' OR "confirmed_at" IS NOT NULL)
    AND ("status" <> 'draft' OR "confirmed_at" IS NULL)),
  CONSTRAINT "wiki_plan_superseded_chk" CHECK (("status" = 'superseded') = ("superseded_at" IS NOT NULL)),
  CONSTRAINT "wiki_plan_docs_range_chk" CHECK ("docs_min" >= 1 AND "docs_min" <= "docs_max" AND "docs_max" <= 200),
  -- [{ key, title, question, forAgents }, …] and [{ at, name, why }, …].
  CONSTRAINT "wiki_plan_categories_chk" CHECK (jsonb_typeof("categories") = 'array'),
  CONSTRAINT "wiki_plan_new_fields_chk" CHECK (jsonb_typeof("new_fields") = 'array'),
  CONSTRAINT "wiki_plan_gate_chk" CHECK (jsonb_typeof("gate") = 'object'),
  -- The runner's check of the repository references and the commit it checked them at, together.
  CONSTRAINT "wiki_plan_repo_chk" CHECK (
    ("repo_sha" IS NULL) = ("repo_check" IS NULL)
    AND ("repo_sha" IS NULL OR "repo_sha" ~ '^[0-9a-f]{7,64}$')
    AND ("repo_check" IS NULL OR jsonb_typeof("repo_check") = 'object')),
  CONSTRAINT "wiki_plan_model_chk" CHECK ("model" IS NULL OR (btrim("model") <> '' AND char_length("model") <= 200))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_space_id_version_key" ON "wiki_plan" ("space_id", "version");
-- At most one draft and one confirmed version a space.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_space_id_draft_key" ON "wiki_plan" ("space_id") WHERE "status" = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_space_id_confirmed_key" ON "wiki_plan" ("space_id") WHERE "status" = 'confirmed';

CREATE TABLE IF NOT EXISTS "wiki_plan_doc" (
  "id"         UUID NOT NULL,
  "plan_id"    UUID NOT NULL,
  "owner_id"   UUID NOT NULL,
  "position"   INTEGER NOT NULL,
  "category"   TEXT NOT NULL,
  "slug"       TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "question"   TEXT NOT NULL,
  "audience"   TEXT[] NOT NULL DEFAULT '{}',
  "scope_in"   TEXT[] NOT NULL DEFAULT '{}',
  "scope_out"  JSONB NOT NULL DEFAULT '[]',
  "length_min" INTEGER NOT NULL,
  "length_max" INTEGER NOT NULL,
  "protected"  BOOLEAN NOT NULL DEFAULT false,
  "extra"      JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "wiki_plan_doc_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_plan_doc_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_plan_doc_plan_fkey"
    FOREIGN KEY ("plan_id", "owner_id") REFERENCES "wiki_plan" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_plan_doc_position_chk" CHECK ("position" >= 0),
  CONSTRAINT "wiki_plan_doc_category_chk" CHECK ("category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("category") <= 64),
  CONSTRAINT "wiki_plan_doc_slug_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 64),
  CONSTRAINT "wiki_plan_doc_title_chk" CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  CONSTRAINT "wiki_plan_doc_question_chk" CHECK (btrim("question") <> '' AND char_length("question") <= 1000),
  CONSTRAINT "wiki_plan_doc_length_chk" CHECK ("length_min" >= 1 AND "length_min" <= "length_max" AND "length_max" <= 100000),
  -- [{ text, docs: [slug, …] }, …]: what the document leaves out, and which documents it is left to.
  CONSTRAINT "wiki_plan_doc_scope_out_chk" CHECK (jsonb_typeof("scope_out") = 'array'),
  CONSTRAINT "wiki_plan_doc_extra_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_doc_plan_id_slug_key" ON "wiki_plan_doc" ("plan_id", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_doc_plan_id_position_key" ON "wiki_plan_doc" ("plan_id", "position");

CREATE TABLE IF NOT EXISTS "wiki_plan_section" (
  "id"       UUID NOT NULL,
  "doc_id"   UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "key"      TEXT NOT NULL,
  "title"    TEXT NOT NULL,
  "kind"     TEXT NOT NULL,
  "covers"   TEXT NOT NULL,
  "length"   INTEGER NOT NULL,
  "sources"  JSONB NOT NULL,
  "extra"    JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "wiki_plan_section_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_plan_section_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_plan_section_doc_fkey"
    FOREIGN KEY ("doc_id", "owner_id") REFERENCES "wiki_plan_doc" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_plan_section_position_chk" CHECK ("position" >= 0),
  CONSTRAINT "wiki_plan_section_key_chk" CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("key") <= 64),
  CONSTRAINT "wiki_plan_section_title_chk" CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  CONSTRAINT "wiki_plan_section_kind_chk" CHECK ("kind" IN (
    'overview', 'concepts', 'flow', 'interface', 'data', 'ops', 'pitfalls', 'decisions', 'conventions', 'other')),
  CONSTRAINT "wiki_plan_section_covers_chk" CHECK (btrim("covers") <> '' AND char_length("covers") <= 2000),
  CONSTRAINT "wiki_plan_section_length_chk" CHECK ("length" >= 1 AND "length" <= 100000),
  -- { docs: [{ path, section }], code: [{ path, symbols }], contracts: [{ path }], sessions: {…} | null }.
  CONSTRAINT "wiki_plan_section_sources_chk" CHECK (jsonb_typeof("sources") = 'object'),
  CONSTRAINT "wiki_plan_section_extra_chk" CHECK (jsonb_typeof("extra") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_section_doc_id_key_key" ON "wiki_plan_section" ("doc_id", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_section_doc_id_position_key" ON "wiki_plan_section" ("doc_id", "position");

CREATE TABLE IF NOT EXISTS "wiki_plan_proposal" (
  "id"                 UUID NOT NULL,
  "space_id"           UUID NOT NULL,
  "owner_id"           UUID NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "base_version"       INTEGER NOT NULL,
  "reason"             TEXT NOT NULL,
  "change"             JSONB NOT NULL,
  "facts"              JSONB NOT NULL,
  "gate"               JSONB NOT NULL,
  "author_session_id"  UUID NOT NULL,
  "decided_by_user_id" UUID,
  "decided_at"         TIMESTAMPTZ(3),
  "decision_note"      TEXT,
  "result_version"     INTEGER,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_plan_proposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_plan_proposal_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_plan_proposal_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_plan_proposal_status_chk" CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "wiki_plan_proposal_base_version_chk" CHECK ("base_version" >= 1),
  CONSTRAINT "wiki_plan_proposal_reason_chk" CHECK (btrim("reason") <> '' AND char_length("reason") <= 2000),
  -- { doc, category? }: the document as it should read, and the category it opens when it needs one.
  CONSTRAINT "wiki_plan_proposal_change_chk" CHECK (jsonb_typeof("change") = 'object'),
  -- [{ kind, id }, …]: the entries and sessions that led to it.
  CONSTRAINT "wiki_plan_proposal_facts_chk" CHECK (jsonb_typeof("facts") = 'array'),
  CONSTRAINT "wiki_plan_proposal_gate_chk" CHECK (jsonb_typeof("gate") = 'object'),
  -- A pending proposal is undecided; a decided one says who decided it when.
  CONSTRAINT "wiki_plan_proposal_decided_chk" CHECK (
    ("status" = 'pending') = ("decided_at" IS NULL) AND ("decided_at" IS NULL) = ("decided_by_user_id" IS NULL)),
  -- An accepted proposal names the draft its acceptance made; no other one names any.
  CONSTRAINT "wiki_plan_proposal_result_chk" CHECK (("status" = 'accepted') = ("result_version" IS NOT NULL)),
  CONSTRAINT "wiki_plan_proposal_note_chk" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 2000)
);
-- The owner's pending proposals of a space, oldest first.
CREATE INDEX IF NOT EXISTS "wiki_plan_proposal_space_id_status_idx" ON "wiki_plan_proposal" ("space_id", "status", "created_at");
