-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 2: the maintenance run's cursor, and what it keeps of a dossier.
-- contracts/wiki.contract.json `maintenance` is the authority for everything below (design §3
-- `wiki_cursor`, §8.2 step 1), and src/apiserver/src/wiki/wiki-dossier.pg.spec.ts holds it to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_cursor    one row per space (source 'facts'): the watermark — the position of the last
--                  committed fact a succeeded maintenance run covered — the furthest position a
--                  dossier page handed out, the backlog as last counted with its oldest fact and the
--                  lag, and the run's health: last_ok_at, last_run_at, last_outcome,
--                  consecutive_failures, last_error.
--   wiki_dossier   what is kept of a dossier once it is handed out: its sources and its hash, one row
--                  per space and session, rewritten each time the session is handed out again. The
--                  dossier's TEXT has no column anywhere: it is cut, redacted and handed over, never
--                  stored (hard constraint 4).
--   task_list.hidden  a list the owner's list index leaves out: the space's «Wiki maintenance» list,
--                  whose tasks are the maintenance runs. false for every list there is.
--
-- A POSITION is three columns, not a jsonb: the time of a fact to the millisecond, its kind and its
-- id, compared as a row — `(at, kind, ref) > (…)` — which is the one order the facts are read in, and
-- what lets an advance be a single compare-and-set on the watermark. The three are set together or
-- not at all. `ref` is TEXT because it names rows of five tables, and a uuid's canonical text sorts
-- as the uuid does.
--
-- TENANCY
-- -------
-- Both tables reach their space through (space_id, owner_id) -> wiki_space(id, owner_id), ON DELETE
-- CASCADE, as every other wiki child does (0307), and neither points at "user". wiki_dossier.session_id
-- is a history reference and carries no foreign key (contract `storage.historyRefs`): a dossier row of
-- a session deleted since is a tombstone the next page overwrites or the space's cascade removes.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No row is written, read or locked. task_list gains one NOT NULL column with a constant default,
-- which PostgreSQL adds to the catalog without rewriting the table; nothing that reads task_list
-- today reads it, and every existing list stays visible. No trigger, function or type is created,
-- replaced or dropped; the wiki tables of 0307–0313 are named only as a foreign key's target.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0315: origin/main and project/34VR0RwUSIcaoO7ZZqv52 stood at 0313 when this was written
-- (2026-09-28), and 0314 was reserved for the project's import task. Every statement can run twice:
-- CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE TABLE, and ADD COLUMN IF
-- NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_cursor" (
  "id"                   UUID NOT NULL,
  "space_id"             UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  "source"               TEXT NOT NULL DEFAULT 'facts',
  "position_at"          TIMESTAMPTZ(3),
  "position_kind"        TEXT,
  "position_ref"         TEXT,
  "issued_at"            TIMESTAMPTZ(3),
  "issued_kind"          TEXT,
  "issued_ref"           TEXT,
  "backlog"              INTEGER NOT NULL DEFAULT 0,
  "pending_sessions"     INTEGER NOT NULL DEFAULT 0,
  "oldest_pending_at"    TIMESTAMPTZ(3),
  "lag_seconds"          INTEGER,
  "counted_at"           TIMESTAMPTZ(3),
  "last_ok_at"           TIMESTAMPTZ(3),
  "last_run_at"          TIMESTAMPTZ(3),
  "last_outcome"         TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_error"           TEXT,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_cursor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_cursor_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_cursor_source_chk" CHECK ("source" IN ('facts')),
  -- A position is whole or absent, and its kind is one of the five facts (maintenance.cursor.factKinds).
  CONSTRAINT "wiki_cursor_position_chk"
    CHECK (("position_at" IS NULL) = ("position_kind" IS NULL) AND ("position_at" IS NULL) = ("position_ref" IS NULL)),
  CONSTRAINT "wiki_cursor_issued_chk"
    CHECK (("issued_at" IS NULL) = ("issued_kind" IS NULL) AND ("issued_at" IS NULL) = ("issued_ref" IS NULL)),
  CONSTRAINT "wiki_cursor_position_kind_chk" CHECK ("position_kind" IS NULL OR "position_kind" IN
    ('session_settled', 'task_terminal', 'approval_answered', 'merge_receipt', 'criterion_revised')),
  CONSTRAINT "wiki_cursor_issued_kind_chk" CHECK ("issued_kind" IS NULL OR "issued_kind" IN
    ('session_settled', 'task_terminal', 'approval_answered', 'merge_receipt', 'criterion_revised')),
  -- The watermark never passes what a page handed out: an advance is checked against it.
  CONSTRAINT "wiki_cursor_position_issued_chk"
    CHECK ("position_at" IS NULL OR ("issued_at" IS NOT NULL
       AND ("position_at", "position_kind", "position_ref") <= ("issued_at", "issued_kind", "issued_ref"))),
  CONSTRAINT "wiki_cursor_counts_chk"
    CHECK ("backlog" >= 0 AND "pending_sessions" >= 0 AND "consecutive_failures" >= 0 AND ("lag_seconds" IS NULL OR "lag_seconds" >= 0)),
  CONSTRAINT "wiki_cursor_last_outcome_chk"
    CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('succeeded', 'failed', 'truncated')),
  CONSTRAINT "wiki_cursor_last_error_chk"
    CHECK ("last_error" IS NULL OR (btrim("last_error") <> '' AND char_length("last_error") <= 2000))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_cursor_space_id_source_key" ON "wiki_cursor" ("space_id", "source");

CREATE TABLE IF NOT EXISTS "wiki_dossier" (
  "id"          UUID NOT NULL,
  "space_id"    UUID NOT NULL,
  "owner_id"    UUID NOT NULL,
  "session_id"  UUID NOT NULL,
  "hash"        CHAR(64) NOT NULL,
  "source_ids"  JSONB NOT NULL,
  "tokens"      INTEGER NOT NULL,
  "truncated"   BOOLEAN NOT NULL,
  -- The page it was last handed out on: the position that page's cursor token names.
  "page_at"     TIMESTAMPTZ(3) NOT NULL,
  "page_kind"   TEXT NOT NULL,
  "page_ref"    TEXT NOT NULL,
  "issued_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_dossier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_dossier_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_dossier_hash_chk" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  -- [{ ref, kind, id }, …]: the records the dossier's lines came from, and nothing of their text.
  CONSTRAINT "wiki_dossier_source_ids_chk" CHECK (jsonb_typeof("source_ids") = 'array'),
  CONSTRAINT "wiki_dossier_tokens_chk" CHECK ("tokens" >= 0),
  CONSTRAINT "wiki_dossier_page_kind_chk" CHECK ("page_kind" IN
    ('session_settled', 'task_terminal', 'approval_answered', 'merge_receipt', 'criterion_revised'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_dossier_space_id_session_id_key" ON "wiki_dossier" ("space_id", "session_id");

ALTER TABLE "task_list" ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false;
