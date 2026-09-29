-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 9 (revised 2026-09-28): the documents. A space's documents are
-- written section by section from the plan its owner confirmed (criterion 11, 0325), every footnote
-- pointing at a first-hand original — a design-document section, code or a contract at a commit, or
-- one of Orbit's own records — with its verbatim quote, and the entry it was found through kept as
-- the via entry. contracts/wiki.contract.json `docs` is the authority for everything below, and
-- src/apiserver/src/wiki/wiki-docs.pg.spec.ts holds these CHECKs to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_doc           one row per document of a space, named by the plan document's slug (stable
--                      from version to version): the confirmed version it was last written from
--                      (plan_id, plan_version, plan_doc_id), its status (ok, or needs_review when
--                      more than 5% of its sentences state something no verified footnote backs),
--                      the origin/main commit its last write read the repository at, and when it was
--                      written.
--   wiki_doc_section   one row per written section, named by the plan section's key: the plan
--                      section it was written from, the fingerprint of its material (the runner's,
--                      over the section's plan definition and what it gathered), the origin/main
--                      commit it was generated at (repo_sha: a maintenance run compares it with
--                      origin/main to rewrite a section whose design documents, code or contracts
--                      changed), its blocks, the model, its statistics, when it was generated, and
--                      stale_at — set when a sentence of it was withdrawn, so the next maintenance run
--                      writes it again.
--   wiki_doc_sentence  one row per sentence: its text, its status (sourced, transition, unsourced,
--                      unverified, withdrawn), the fact tokens no sourced sentence or heading of the
--                      document has (for an unsourced one), and — once withdrawn — when, why, and the
--                      entry it came through.
--   wiki_doc_footnote  one row per footnote of a sentence: its kind (a repository original:
--                      design_doc, code, contract; or a record: turn, event, tool_call, task,
--                      task_comment, approval, owner_decision, merge_receipt, note), where it points
--                      (path@sha#Lstart-end, or a record id and the character range its quote was
--                      found at), the verbatim quote (redacted), the lines it quotes from, the
--                      verdict (verified, not_found, no_quote, unresolved), who checked it (the server
--                      re-reads a record; the runner checks the repository, at the sha), and the via
--                      entry.
--
-- A VIEW, NOT KNOWLEDGE. No source kind names these tables, so a document is never a source; the
-- push and the agent's search and get read wiki_entry alone. The phase-2 topic articles
-- (wiki_topic_summary, 0317) stay, readable as they are, until the clients have moved over.
--
-- TENANCY
-- -------
-- As every wiki child reaches its parent (0307): wiki_doc reaches wiki_space through (space_id,
-- owner_id), a section its document through (doc_id, owner_id), a sentence its section through
-- (section_id, owner_id) and a footnote its sentence through (sentence_id, owner_id), all ON DELETE
-- CASCADE — a space's delete takes its documents, and a section's rewrite takes its sentences and
-- their footnotes with it. The plan rows a document was written from (plan_id, plan_doc_id,
-- plan_section_id), the entries a footnote came through or a withdrawal names (via_entry_id,
-- withdrawn_entry_id) and a footnote's record (ref) are history references with no foreign key
-- (contract `storage.historyRefs`): provenance, which takes no lock on those tables and outlives them.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No existing row is written, read or locked, and no existing table gains a column: the four tables
-- start empty, and wiki_space is named only as the parent one foreign key references. No function,
-- trigger or type is created, replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0326: origin/main and project/34VR0RwUSIcaoO7ZZqv52 both stood at 0325 when this was written
-- (2026-09-29), no other branch had a 0326, and the project's coordinator gave 0326 to the documents'
-- storage. Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS, with each table's
-- constraints inside its CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_doc" (
  "id"           UUID NOT NULL,
  "space_id"     UUID NOT NULL,
  "owner_id"     UUID NOT NULL,
  "slug"         TEXT NOT NULL,
  "plan_id"      UUID NOT NULL,
  "plan_version" INTEGER NOT NULL,
  "plan_doc_id"  UUID NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'ok',
  "repo_sha"     TEXT NOT NULL,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_doc_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_doc_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_doc_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_doc_slug_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 64),
  CONSTRAINT "wiki_doc_plan_version_chk" CHECK ("plan_version" >= 1),
  CONSTRAINT "wiki_doc_status_chk" CHECK ("status" IN ('ok', 'needs_review')),
  -- The origin/main commit its last write read the repository at.
  CONSTRAINT "wiki_doc_repo_sha_chk" CHECK ("repo_sha" ~ '^[0-9a-f]{40}$')
);
-- One document of a slug a space: the plan's document across its versions.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_doc_space_id_slug_key" ON "wiki_doc" ("space_id", "slug");

CREATE TABLE IF NOT EXISTS "wiki_doc_section" (
  "id"              UUID NOT NULL,
  "doc_id"          UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "key"             TEXT NOT NULL,
  "plan_section_id" UUID NOT NULL,
  "material_sha256" CHAR(64) NOT NULL,
  "blocks"          JSONB NOT NULL,
  "repo_sha"        TEXT NOT NULL,
  "model"           TEXT,
  "stats"           JSONB NOT NULL DEFAULT '{}',
  "generated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stale_at"        TIMESTAMPTZ(3),
  CONSTRAINT "wiki_doc_section_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_doc_section_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_doc_section_doc_fkey"
    FOREIGN KEY ("doc_id", "owner_id") REFERENCES "wiki_doc" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_doc_section_key_chk" CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("key") <= 64),
  CONSTRAINT "wiki_doc_section_material_chk" CHECK ("material_sha256" ~ '^[0-9a-f]{64}$'),
  -- [{ kind, text? }, …]: paragraph and item blocks hold sentences; a heading or a code block its text.
  CONSTRAINT "wiki_doc_section_blocks_chk" CHECK (jsonb_typeof("blocks") = 'array'),
  CONSTRAINT "wiki_doc_section_stats_chk" CHECK (jsonb_typeof("stats") = 'object'),
  -- The origin/main commit it was generated at.
  CONSTRAINT "wiki_doc_section_repo_sha_chk" CHECK ("repo_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "wiki_doc_section_model_chk" CHECK ("model" IS NULL OR (btrim("model") <> '' AND char_length("model") <= 200))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_doc_section_doc_id_key_key" ON "wiki_doc_section" ("doc_id", "key");

CREATE TABLE IF NOT EXISTS "wiki_doc_sentence" (
  "id"                 UUID NOT NULL,
  "section_id"         UUID NOT NULL,
  "owner_id"           UUID NOT NULL,
  "position"           INTEGER NOT NULL,
  "block"              INTEGER NOT NULL,
  "text"               TEXT NOT NULL,
  "status"             TEXT NOT NULL,
  "new_tokens"         TEXT[] NOT NULL DEFAULT '{}',
  "withdrawn_at"       TIMESTAMPTZ(3),
  "withdrawn_entry_id" UUID,
  "withdrawn_reason"   TEXT,
  CONSTRAINT "wiki_doc_sentence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_doc_sentence_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_doc_sentence_section_fkey"
    FOREIGN KEY ("section_id", "owner_id") REFERENCES "wiki_doc_section" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_doc_sentence_position_chk" CHECK ("position" >= 0 AND "block" >= 0),
  CONSTRAINT "wiki_doc_sentence_text_chk" CHECK (btrim("text") <> '' AND char_length("text") <= 20000),
  CONSTRAINT "wiki_doc_sentence_status_chk" CHECK ("status" IN ('sourced', 'transition', 'unsourced', 'unverified', 'withdrawn')),
  -- Only an unsourced sentence names the fact tokens nothing sourced carries.
  CONSTRAINT "wiki_doc_sentence_new_tokens_chk" CHECK ("status" = 'unsourced' OR cardinality("new_tokens") = 0),
  CONSTRAINT "wiki_doc_sentence_withdrawn_reason_chk" CHECK (
    "withdrawn_reason" IS NULL OR "withdrawn_reason" IN ('rejected', 'retired', 'superseded', 'anchor_changed', 'anchor_missing')),
  -- A withdrawn sentence says when, why and through which entry; no other one says any of it.
  CONSTRAINT "wiki_doc_sentence_withdrawn_chk" CHECK (
    ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
    AND ("withdrawn_at" IS NULL) = ("withdrawn_reason" IS NULL)
    AND ("withdrawn_at" IS NULL) = ("withdrawn_entry_id" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_doc_sentence_section_id_position_key" ON "wiki_doc_sentence" ("section_id", "position");

CREATE TABLE IF NOT EXISTS "wiki_doc_footnote" (
  "id"           UUID NOT NULL,
  "sentence_id"  UUID NOT NULL,
  "owner_id"     UUID NOT NULL,
  "position"     INTEGER NOT NULL,
  "kind"         TEXT NOT NULL,
  "ref"          TEXT NOT NULL,
  "sha"          TEXT,
  "line_start"   INTEGER,
  "line_end"     INTEGER,
  "char_start"   INTEGER,
  "char_end"     INTEGER,
  "locator"      JSONB NOT NULL DEFAULT '{}',
  "quote"        TEXT,
  "excerpt"      TEXT,
  "verdict"      TEXT NOT NULL,
  "checked_by"   TEXT NOT NULL,
  "via_entry_id" UUID,
  CONSTRAINT "wiki_doc_footnote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_doc_footnote_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_doc_footnote_sentence_fkey"
    FOREIGN KEY ("sentence_id", "owner_id") REFERENCES "wiki_doc_sentence" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_doc_footnote_position_chk" CHECK ("position" >= 0),
  CONSTRAINT "wiki_doc_footnote_kind_chk" CHECK ("kind" IN (
    'design_doc', 'code', 'contract', 'turn', 'event', 'tool_call', 'task', 'task_comment', 'approval', 'owner_decision', 'merge_receipt', 'note')),
  CONSTRAINT "wiki_doc_footnote_verdict_chk" CHECK ("verdict" IN ('verified', 'not_found', 'no_quote', 'unresolved')),
  CONSTRAINT "wiki_doc_footnote_checked_by_chk" CHECK ("checked_by" IN ('server', 'runner')),
  -- A repository path, or a record's id.
  CONSTRAINT "wiki_doc_footnote_ref_chk" CHECK (btrim("ref") <> '' AND char_length("ref") <= 1000),
  -- A repository original is pinned to the commit it was read at and the lines it quotes, and the
  -- runner checked it there; a record is read again, and checked, by the server.
  CONSTRAINT "wiki_doc_footnote_repository_chk" CHECK (
    ("kind" IN ('design_doc', 'code', 'contract')) = ("sha" IS NOT NULL)
    AND ("kind" IN ('design_doc', 'code', 'contract')) = ("checked_by" = 'runner')
    AND ("sha" IS NULL OR "sha" ~ '^[0-9a-f]{7,64}$')
    AND ("sha" IS NULL) = ("line_start" IS NULL)
    AND ("line_start" IS NULL) = ("line_end" IS NULL)
    AND ("line_start" IS NULL OR ("line_start" >= 1 AND "line_end" >= "line_start"))
    AND ("sha" IS NOT NULL OR "excerpt" IS NULL)
    AND ("sha" IS NULL OR "verdict" <> 'unresolved')),
  -- Where in the record's redacted text the quote was found; only a record has one.
  CONSTRAINT "wiki_doc_footnote_chars_chk" CHECK (
    ("char_start" IS NULL) = ("char_end" IS NULL)
    AND ("char_start" IS NULL OR ("sha" IS NULL AND "char_start" >= 0 AND "char_end" > "char_start"))),
  -- A footnote with no quote was not checked; a verified one has its quote.
  CONSTRAINT "wiki_doc_footnote_quote_chk" CHECK (
    ("verdict" <> 'no_quote' OR "quote" IS NULL)
    AND ("verdict" <> 'verified' OR "quote" IS NOT NULL)
    AND ("quote" IS NOT NULL OR "verdict" IN ('no_quote', 'unresolved'))
    AND ("quote" IS NULL OR (btrim("quote") <> '' AND char_length("quote") <= 1000))),
  CONSTRAINT "wiki_doc_footnote_excerpt_chk" CHECK ("excerpt" IS NULL OR char_length("excerpt") <= 4000),
  CONSTRAINT "wiki_doc_footnote_locator_chk" CHECK (jsonb_typeof("locator") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_doc_footnote_sentence_id_position_key" ON "wiki_doc_footnote" ("sentence_id", "position");
-- What an entry's rejection, retirement or broken anchor withdraws: the footnotes that came through it.
CREATE INDEX IF NOT EXISTS "wiki_doc_footnote_via_entry_idx" ON "wiki_doc_footnote" ("owner_id", "via_entry_id")
  WHERE "via_entry_id" IS NOT NULL;
