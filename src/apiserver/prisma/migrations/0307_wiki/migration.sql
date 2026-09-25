-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 1: the nine tables docs/wiki-design.md §3 describes. contracts/wiki.contract.json
-- is the authority for every closed set, limit and state below, and
-- src/apiserver/src/wiki/wiki-schema.pg.spec.ts reads that file and holds this schema to it.
--
-- WHAT IS STORED
-- --------------
-- The canonical store is the ENTRY: one atomic claim (principle, convention, decision, pitfall,
-- recipe, concept) with its sources and anchors. Pages, the decision log, the timeline and the
-- agent's slice are views rebuilt from entries; none of them is a table.
--
--   wiki_space            one owner's wiki for one codebase (repo_url_norm), with its settings
--   wiki_space_workspace  which workspaces read a space: a workspace belongs to at most one
--   wiki_topic            a named group of entries, and the anchor paths that fall under it
--   wiki_entry            the lineage row: its id survives every revision, and it carries the
--                         current revision's content, status, trust and the flags the push reads
--   wiki_entry_revision   every revision, only ever inserted; UNIQUE (entry_id, revision)
--   wiki_source           a first-hand record a revision cites, and a quote from it
--   wiki_changeset        one submission (an agent's proposal, the owner's edit), with its
--                         idempotency key and its place in Review
--   wiki_changeset_op     one op of it, and the owner's decision on it
--   wiki_exposure         which session was given which revision of which entry, and how
--
-- TENANCY
-- -------
-- wiki_space is the one table with a foreign key to "user" (ON DELETE CASCADE). Every other table
-- carries owner_id too, and reaches its parent through (parent_id, owner_id) -> parent(id,
-- owner_id), ON DELETE CASCADE: a binding, topic, entry or changeset reaches its space; a revision
-- or an exposure its entry; a source its revision; an op its changeset. So a child row can never
-- belong to another owner than its parent, and deleting an owner still deletes every row here,
-- through the space. Every key here also says ON UPDATE CASCADE, Prisma's default, so
-- `prisma migrate diff` finds nothing between these tables and their models in schema.prisma.
--
-- Why the children do NOT also point at "user": a foreign key check takes FOR KEY SHARE on the row
-- it names, and the user row is rank 10 in docs/postgres-lock-order.md, the one lockOwnerTaskGraph
-- holds FOR UPDATE. wiki_exposure is written from dequeueTurn with the session row (rank 30)
-- already in hand; a user key there would take rank 10 after rank 30, the exact shape of the cycles
-- that document exists to prevent. Through the space instead, a wiki write locks wiki rows only.
--
-- A binding also reaches its workspace through (workspace_id, owner_id), so a space can only be
-- bound to its own owner's workspaces. That needs a key on workspace(id, owner_id), which this
-- migration adds: the one statement here outside the wiki tables (see below).
--
-- HISTORY REFERENCES CARRY NO FOREIGN KEY
-- ---------------------------------------
-- wiki_changeset.session_id and tool_call_id, wiki_entry_revision.author_user_id,
-- author_session_id, author_tool_call_id and changeset_op_id, wiki_exposure.session_id and
-- wiki_source.ref are snapshots of where something came from, the way 0238's deciding_session_id
-- is: a deleted record leaves the id behind as a tombstone (wiki_source.state records it), and no
-- wiki write takes a lock on session, task or tool_call.
--
-- Inside the wiki, entries point at each other two more ways, each with a composite key:
--   * supersedes_id / superseded_by_id -> wiki_entry(id, owner_id), NO ACTION. Both ends of a
--     supersession live in one space, so the cascade that deletes a space deletes both in one
--     statement and the check at its end finds nothing left.
--   * wiki_changeset_op.entry_id / result_entry_id -> wiki_entry(id, owner_id), ON DELETE CASCADE.
--     An op is reached from its space two ways (through its changeset and through its entry), and
--     a NO ACTION key checked before the other cascade arrives would refuse deleting the space.
--     Deleting an entry takes the ops about it with it: delete means forget.
--
-- CLOSED SETS
-- -----------
-- Every closed set is TEXT with a CHECK (the 0259 practice), never an enum, and admits exactly the
-- contract's values: wiki_entry.kind (assumption included — storage admits the phase-3 word so that
-- phase needs no migration; every phase-1 door refuses it), status, trust and anchor_state; every
-- anchor's type, through wiki_anchors_valid(); wiki_entry_revision.author_kind; wiki_source.kind and
-- state; wiki_changeset.origin and status; wiki_changeset_op.op, decision and decision_reason;
-- wiki_exposure.channel. The contract's length limits are CHECKs as well (title, summary, topics,
-- aliases, quote, slug), so a writer that skipped KIND_SPECS still cannot store past them.
--
-- STATE SHAPES
-- ------------
-- The invariants contracts/wiki.contract.json states are CHECKs, so no writer can leave a row half
-- way: an entry is superseded exactly when it names its successor, has retired_at exactly when its
-- status is terminal, and has trust 'proposed' exactly when it is proposed or rejected; an op has
-- decided_at exactly when it is decided, a reason exactly when it was rejected, an entry exactly
-- when it is not an add, and a base revision exactly when it is an amend, supersede or retire; a
-- changeset has decided_at exactly when it is settled, and an expiry whenever it is pending; a
-- deleted source has no quote; a url source is tainted; a push names its session.
--
-- SEARCH
-- ------
-- wiki_entry_search_text(title, summary, aliases, fields) is the text keyword search reads: the
-- title, the summary, the aliases and every string inside fields, with * and ` removed exactly as
-- 0095 and stripMarks in sessions.service.ts remove them (asterisks and backticks, never _). It is
-- a function so that the query side can repeat the index's expression by calling it: a trigram
-- index over an expression is used only by a query that repeats that expression exactly, and a
-- query that spells the same text any other way scans every row. It is declared IMMUTABLE around
-- array_to_string, which is only STABLE in general but immutable over text[], the usual wrapper for
-- this (and because of it PostgreSQL does not inline the function, so the index and a query both
-- keep the same call). pg_trgm is 0068's.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- One statement reaches outside the wiki: CREATE UNIQUE INDEX "workspace_id_owner_id_key" ON
-- "workspace" ("id", "owner_id"), the key the binding's foreign key needs. It adds no column and
-- changes no row; id alone is already unique, so no row can violate it. Otherwise "user" and
-- "workspace" are named only as the tables foreign keys reference. No trigger is created, and no
-- existing function, type or table is altered or dropped. The two functions created here are the
-- wiki's own. There is no INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0307: the highest number on main and on every branch of origin and every local branch was 0306
-- when this was written (2026-09-25). Every statement can run twice: CREATE TABLE and CREATE INDEX
-- IF NOT EXISTS with the constraints inside the CREATE TABLE, and CREATE OR REPLACE FUNCTION.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- Every anchor is an object whose type is one of the contract's anchor types. strict mode, so a
-- missing, non-string or unknown type makes the filter unknown and the element uncounted, and a
-- nested array is never unwrapped into looking like an anchor.
CREATE OR REPLACE FUNCTION "wiki_anchors_valid"("anchors" JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN jsonb_typeof("anchors") = 'array' THEN
      jsonb_array_length("anchors") = jsonb_array_length(jsonb_path_query_array("anchors",
        'strict $[*] ? (@.type == "path" || @.type == "symbol" || @.type == "commit" || @.type == "criterion" || @.type == "merge_evidence" || @.type == "command" || @.type == "record")'))
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION "wiki_entry_search_text"("title" TEXT, "summary" TEXT, "aliases" TEXT[], "fields" JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT replace(replace(
    coalesce("title", '') || ' ' ||
    coalesce("summary", '') || ' ' ||
    coalesce(array_to_string("aliases", ' '), '') || ' ' ||
    coalesce(jsonb_path_query_array("fields", 'strict $.** ? (@.type() == "string")')::text, ''),
    '*', ''), '`', '')
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_id_owner_id_key" ON "workspace" ("id", "owner_id");

CREATE TABLE IF NOT EXISTS "wiki_space" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "slug"            TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "repo_url_norm"   TEXT,
  "root_commit_sha" CHAR(40),
  "settings"        JSONB NOT NULL DEFAULT '{}',
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_space_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_space_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_space_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_space_slug_chk"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 64),
  CONSTRAINT "wiki_space_title_chk"
    CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  -- The normal form project_codebase.canonical_repo_url is held to, and no scheme: both
  -- git@github.com:a/b.git and https://github.com/a/b read github.com/a/b.
  CONSTRAINT "wiki_space_repo_url_norm_chk"
    CHECK ("repo_url_norm" IS NULL OR ("repo_url_norm" = btrim("repo_url_norm")
       AND "repo_url_norm" <> ''
       AND "repo_url_norm" NOT LIKE '%/'
       AND "repo_url_norm" NOT LIKE '%.git'
       AND "repo_url_norm" NOT LIKE '%://%')),
  CONSTRAINT "wiki_space_root_commit_sha_chk"
    CHECK ("root_commit_sha" IS NULL OR "root_commit_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "wiki_space_settings_chk" CHECK (jsonb_typeof("settings") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_space_owner_id_slug_key" ON "wiki_space" ("owner_id", "slug");
-- NULLs are distinct: any number of spaces with no repository.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_space_owner_id_repo_url_norm_key"
  ON "wiki_space" ("owner_id", "repo_url_norm");

CREATE TABLE IF NOT EXISTS "wiki_space_workspace" (
  "id"           UUID NOT NULL,
  "space_id"     UUID NOT NULL,
  "owner_id"     UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_space_workspace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_space_workspace_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_space_workspace_workspace_fkey"
    FOREIGN KEY ("workspace_id", "owner_id") REFERENCES "workspace" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_space_workspace_workspace_id_key"
  ON "wiki_space_workspace" ("workspace_id");
CREATE INDEX IF NOT EXISTS "wiki_space_workspace_space_id_idx" ON "wiki_space_workspace" ("space_id");

CREATE TABLE IF NOT EXISTS "wiki_topic" (
  "id"            UUID NOT NULL,
  "space_id"      UUID NOT NULL,
  "owner_id"      UUID NOT NULL,
  "slug"          TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "description"   TEXT,
  "path_prefixes" TEXT[] NOT NULL DEFAULT '{}',
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_topic_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_topic_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_topic_slug_chk"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 64),
  CONSTRAINT "wiki_topic_title_chk"
    CHECK (btrim("title") <> '' AND char_length("title") <= 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_topic_space_id_slug_key" ON "wiki_topic" ("space_id", "slug");

CREATE TABLE IF NOT EXISTS "wiki_entry" (
  "id"                 UUID NOT NULL,
  "owner_id"           UUID NOT NULL,
  "space_id"           UUID NOT NULL,
  "kind"               TEXT NOT NULL,
  "status"             TEXT NOT NULL,
  "trust"              TEXT NOT NULL,
  "current_revision"   INTEGER NOT NULL,
  "title"              TEXT NOT NULL,
  "summary"            TEXT NOT NULL,
  "fields"             JSONB NOT NULL,
  "topics"             TEXT[] NOT NULL DEFAULT '{}',
  "aliases"            TEXT[] NOT NULL DEFAULT '{}',
  "anchors"            JSONB NOT NULL DEFAULT '[]',
  "anchor_state"       TEXT NOT NULL DEFAULT 'unchecked',
  "anchor_checked_ref" TEXT,
  "anchor_checked_at"  TIMESTAMPTZ(3),
  "tainted"            BOOLEAN NOT NULL DEFAULT false,
  "challenged"         BOOLEAN NOT NULL DEFAULT false,
  "unsupported"        BOOLEAN NOT NULL DEFAULT false,
  "pinned"             BOOLEAN NOT NULL DEFAULT false,
  "supersedes_id"      UUID,
  "superseded_by_id"   UUID,
  "valid_from"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_to"           TIMESTAMPTZ(3),
  "recorded_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retired_at"         TIMESTAMPTZ(3),
  "stats"              JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "wiki_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_entry_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_entry_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_entry_supersedes_fkey"
    FOREIGN KEY ("supersedes_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "wiki_entry_superseded_by_fkey"
    FOREIGN KEY ("superseded_by_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "wiki_entry_kind_chk" CHECK ("kind" IN
    ('principle', 'convention', 'decision', 'pitfall', 'recipe', 'concept', 'assumption')),
  CONSTRAINT "wiki_entry_status_chk" CHECK ("status" IN
    ('proposed', 'active', 'superseded', 'retired', 'rejected')),
  CONSTRAINT "wiki_entry_trust_chk" CHECK ("trust" IN ('owner', 'confirmed', 'proposed', 'external')),
  CONSTRAINT "wiki_entry_anchor_state_chk" CHECK ("anchor_state" IN
    ('unchecked', 'verified', 'changed', 'missing')),
  CONSTRAINT "wiki_entry_current_revision_chk" CHECK ("current_revision" >= 1),
  CONSTRAINT "wiki_entry_title_chk" CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  CONSTRAINT "wiki_entry_summary_chk" CHECK (btrim("summary") <> '' AND char_length("summary") <= 280),
  CONSTRAINT "wiki_entry_topics_chk" CHECK (cardinality("topics") <= 3),
  CONSTRAINT "wiki_entry_aliases_chk" CHECK (cardinality("aliases") <= 8),
  CONSTRAINT "wiki_entry_fields_chk" CHECK (jsonb_typeof("fields") = 'object'),
  CONSTRAINT "wiki_entry_anchors_chk" CHECK ("wiki_anchors_valid"("anchors")),
  CONSTRAINT "wiki_entry_stats_chk" CHECK (jsonb_typeof("stats") = 'object'),
  -- Nothing becomes owner or confirmed knowledge without being accepted, and nothing accepted is
  -- still waiting.
  CONSTRAINT "wiki_entry_trust_status_chk"
    CHECK (("status" IN ('proposed', 'rejected')) = ("trust" = 'proposed')),
  CONSTRAINT "wiki_entry_superseded_chk"
    CHECK (("status" = 'superseded') = ("superseded_by_id" IS NOT NULL)),
  CONSTRAINT "wiki_entry_retired_at_chk"
    CHECK (("status" IN ('superseded', 'retired', 'rejected')) = ("retired_at" IS NOT NULL)),
  CONSTRAINT "wiki_entry_not_self_chk"
    CHECK ("supersedes_id" IS DISTINCT FROM "id" AND "superseded_by_id" IS DISTINCT FROM "id"),
  CONSTRAINT "wiki_entry_valid_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
-- A space's entries by status and kind: the home page, the review counts, the push candidates.
CREATE INDEX IF NOT EXISTS "wiki_entry_space_status_kind_idx" ON "wiki_entry" ("space_id", "status", "kind");
-- The two self-references are looked up when an entry is deleted; without these, deleting a space
-- would scan the table once per entry.
CREATE INDEX IF NOT EXISTS "wiki_entry_supersedes_idx"
  ON "wiki_entry" ("supersedes_id") WHERE "supersedes_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wiki_entry_superseded_by_idx"
  ON "wiki_entry" ("superseded_by_id") WHERE "superseded_by_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wiki_entry_search_trgm" ON "wiki_entry" USING gin (
  ("wiki_entry_search_text"("title", "summary", "aliases", "fields")) gin_trgm_ops
);

CREATE TABLE IF NOT EXISTS "wiki_entry_revision" (
  "id"                  UUID NOT NULL,
  "entry_id"            UUID NOT NULL,
  "owner_id"            UUID NOT NULL,
  "revision"            INTEGER NOT NULL,
  "title"               TEXT NOT NULL,
  "summary"             TEXT NOT NULL,
  "fields"              JSONB NOT NULL,
  "topics"              TEXT[] NOT NULL DEFAULT '{}',
  "aliases"             TEXT[] NOT NULL DEFAULT '{}',
  "anchors"             JSONB NOT NULL DEFAULT '[]',
  "content_sha256"      CHAR(64) NOT NULL,
  "author_kind"         TEXT NOT NULL,
  "author_user_id"      UUID,
  "author_session_id"   UUID,
  "author_tool_call_id" UUID,
  "changeset_op_id"     UUID,
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_entry_revision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_entry_revision_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_entry_revision_entry_revision_key" UNIQUE ("entry_id", "revision"),
  CONSTRAINT "wiki_entry_revision_entry_fkey"
    FOREIGN KEY ("entry_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_entry_revision_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "wiki_entry_revision_title_chk" CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  CONSTRAINT "wiki_entry_revision_summary_chk"
    CHECK (btrim("summary") <> '' AND char_length("summary") <= 280),
  CONSTRAINT "wiki_entry_revision_topics_chk" CHECK (cardinality("topics") <= 3),
  CONSTRAINT "wiki_entry_revision_aliases_chk" CHECK (cardinality("aliases") <= 8),
  CONSTRAINT "wiki_entry_revision_fields_chk" CHECK (jsonb_typeof("fields") = 'object'),
  CONSTRAINT "wiki_entry_revision_anchors_chk" CHECK ("wiki_anchors_valid"("anchors")),
  CONSTRAINT "wiki_entry_revision_content_sha256_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "wiki_entry_revision_author_kind_chk" CHECK ("author_kind" IN
    ('owner', 'agent', 'maintenance', 'system')),
  CONSTRAINT "wiki_entry_revision_owner_author_chk"
    CHECK ("author_kind" <> 'owner' OR "author_user_id" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "wiki_source" (
  "id"             UUID NOT NULL,
  "revision_id"    UUID NOT NULL,
  "owner_id"       UUID NOT NULL,
  "kind"           TEXT NOT NULL,
  "ref"            TEXT NOT NULL,
  "locator"        JSONB NOT NULL DEFAULT '{}',
  "quote"          TEXT,
  "quote_sha256"   CHAR(64),
  "quote_verified" BOOLEAN NOT NULL DEFAULT false,
  "state"          TEXT NOT NULL DEFAULT 'live',
  "tainted"        BOOLEAN NOT NULL DEFAULT false,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_source_revision_fkey"
    FOREIGN KEY ("revision_id", "owner_id") REFERENCES "wiki_entry_revision" ("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_source_kind_chk" CHECK ("kind" IN
    ('turn', 'event', 'tool_call', 'task', 'task_comment', 'approval', 'evidence', 'owner_decision',
     'merge_receipt', 'criterion', 'commit', 'note', 'url')),
  CONSTRAINT "wiki_source_state_chk" CHECK ("state" IN ('live', 'trashed', 'deleted')),
  CONSTRAINT "wiki_source_ref_chk" CHECK (btrim("ref") <> ''),
  CONSTRAINT "wiki_source_locator_chk" CHECK (jsonb_typeof("locator") = 'object'),
  CONSTRAINT "wiki_source_quote_chk" CHECK ("quote" IS NULL OR char_length("quote") <= 300),
  CONSTRAINT "wiki_source_quote_sha256_chk"
    CHECK ("quote_sha256" IS NULL OR "quote_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "wiki_source_quote_pair_chk" CHECK (("quote" IS NULL) = ("quote_sha256" IS NULL)),
  -- Delete means forget: the record is gone, and so are the words taken from it.
  CONSTRAINT "wiki_source_deleted_chk" CHECK ("state" <> 'deleted' OR "quote" IS NULL),
  CONSTRAINT "wiki_source_url_tainted_chk" CHECK ("kind" <> 'url' OR "tainted")
);
CREATE INDEX IF NOT EXISTS "wiki_source_revision_id_idx" ON "wiki_source" ("revision_id");
-- A record being deleted or trashed finds the sources that cite it.
CREATE INDEX IF NOT EXISTS "wiki_source_ref_idx" ON "wiki_source" ("owner_id", "kind", "ref");

CREATE TABLE IF NOT EXISTS "wiki_changeset" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "space_id"        UUID NOT NULL,
  "origin"          TEXT NOT NULL,
  "session_id"      UUID,
  "tool_call_id"    UUID,
  "rationale"       TEXT,
  "idempotency_key" TEXT,
  "request_sha256"  CHAR(64),
  "status"          TEXT NOT NULL,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"      TIMESTAMPTZ(3),
  "expires_at"      TIMESTAMPTZ(3),
  CONSTRAINT "wiki_changeset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_changeset_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "wiki_changeset_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_changeset_origin_chk" CHECK ("origin" IN
    ('owner', 'agent', 'maintenance', 'import', 'watch')),
  CONSTRAINT "wiki_changeset_status_chk" CHECK ("status" IN ('pending', 'settled')),
  CONSTRAINT "wiki_changeset_settled_chk" CHECK (("status" = 'settled') = ("decided_at" IS NOT NULL)),
  CONSTRAINT "wiki_changeset_pending_expires_chk" CHECK ("status" <> 'pending' OR "expires_at" IS NOT NULL),
  -- The digest is what tells a replay (same request) from a key reused for another request.
  CONSTRAINT "wiki_changeset_idempotency_chk"
    CHECK (("idempotency_key" IS NULL) = ("request_sha256" IS NULL)
       AND ("request_sha256" IS NULL OR "request_sha256" ~ '^[0-9a-f]{64}$'))
);
-- NULLs are distinct: a write with no key never collides with another.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_changeset_owner_idempotency_key"
  ON "wiki_changeset" ("owner_id", "idempotency_key");
-- Review, and the per-space pending count the sidebar shows.
CREATE INDEX IF NOT EXISTS "wiki_changeset_space_status_idx" ON "wiki_changeset" ("space_id", "status");
-- The per-session quota.
CREATE INDEX IF NOT EXISTS "wiki_changeset_session_idx"
  ON "wiki_changeset" ("session_id") WHERE "session_id" IS NOT NULL;
-- The expiry sweep.
CREATE INDEX IF NOT EXISTS "wiki_changeset_pending_expiry_idx"
  ON "wiki_changeset" ("expires_at") WHERE "status" = 'pending';

CREATE TABLE IF NOT EXISTS "wiki_changeset_op" (
  "id"              UUID NOT NULL,
  "changeset_id"    UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "seq"             INTEGER NOT NULL,
  "op"              TEXT NOT NULL,
  "entry_id"        UUID,
  "base_revision"   INTEGER,
  "payload"         JSONB NOT NULL,
  "similar"         JSONB NOT NULL DEFAULT '[]',
  "tainted"         BOOLEAN NOT NULL DEFAULT false,
  "decision"        TEXT NOT NULL DEFAULT 'pending',
  "decision_reason" TEXT,
  "decision_note"   TEXT,
  "result_entry_id" UUID,
  "result_revision" INTEGER,
  "decided_at"      TIMESTAMPTZ(3),
  CONSTRAINT "wiki_changeset_op_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_changeset_op_changeset_seq_key" UNIQUE ("changeset_id", "seq"),
  CONSTRAINT "wiki_changeset_op_changeset_fkey"
    FOREIGN KEY ("changeset_id", "owner_id") REFERENCES "wiki_changeset" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_changeset_op_entry_fkey"
    FOREIGN KEY ("entry_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_changeset_op_result_entry_fkey"
    FOREIGN KEY ("result_entry_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_changeset_op_seq_chk" CHECK ("seq" >= 0),
  CONSTRAINT "wiki_changeset_op_op_chk" CHECK ("op" IN
    ('add', 'reinforce', 'amend', 'supersede', 'retire', 'challenge')),
  CONSTRAINT "wiki_changeset_op_decision_chk" CHECK ("decision" IN
    ('pending', 'accepted', 'edited', 'rejected', 'auto_applied', 'conflict', 'expired', 'withdrawn')),
  CONSTRAINT "wiki_changeset_op_decision_reason_chk" CHECK ("decision_reason" IS NULL OR "decision_reason" IN
    ('not_true', 'not_useful', 'duplicate', 'too_specific')),
  CONSTRAINT "wiki_changeset_op_rejected_chk" CHECK (("decision" = 'rejected') = ("decision_reason" IS NOT NULL)),
  CONSTRAINT "wiki_changeset_op_decided_chk" CHECK (("decision" = 'pending') = ("decided_at" IS NULL)),
  -- An add starts a lineage, so it has no entry to name; every other op is about one.
  CONSTRAINT "wiki_changeset_op_target_chk" CHECK (("op" = 'add') = ("entry_id" IS NULL)),
  -- Compare-and-set is not optional where it applies, and means nothing where it does not.
  CONSTRAINT "wiki_changeset_op_base_revision_chk"
    CHECK (("op" IN ('amend', 'supersede', 'retire')) = ("base_revision" IS NOT NULL)
       AND ("base_revision" IS NULL OR "base_revision" >= 1)),
  CONSTRAINT "wiki_changeset_op_result_revision_chk" CHECK ("result_revision" IS NULL OR "result_revision" >= 1),
  CONSTRAINT "wiki_changeset_op_payload_chk" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "wiki_changeset_op_similar_chk" CHECK (jsonb_typeof("similar") = 'array')
);
CREATE INDEX IF NOT EXISTS "wiki_changeset_op_entry_idx"
  ON "wiki_changeset_op" ("entry_id") WHERE "entry_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wiki_changeset_op_result_entry_idx"
  ON "wiki_changeset_op" ("result_entry_id") WHERE "result_entry_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "wiki_exposure" (
  "id"                 UUID NOT NULL,
  "owner_id"           UUID NOT NULL,
  "entry_id"           UUID NOT NULL,
  "revision"           INTEGER NOT NULL,
  "session_id"         UUID,
  "channel"            TEXT NOT NULL,
  "at"                 TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retraction_sent_at" TIMESTAMPTZ(3),
  CONSTRAINT "wiki_exposure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_exposure_entry_fkey"
    FOREIGN KEY ("entry_id", "owner_id") REFERENCES "wiki_entry" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_exposure_channel_chk" CHECK ("channel" IN ('push', 'search', 'get')),
  CONSTRAINT "wiki_exposure_revision_chk" CHECK ("revision" >= 1),
  -- A push is always to a session; a search or get from a runner with no session names none.
  CONSTRAINT "wiki_exposure_push_session_chk" CHECK ("channel" <> 'push' OR "session_id" IS NOT NULL)
);
-- Who was given an entry recently (retractions, "Where it's used"), and the cascade from it.
CREATE INDEX IF NOT EXISTS "wiki_exposure_entry_at_idx" ON "wiki_exposure" ("entry_id", "at");
-- What one session was given (the task start card's "Wiki context · N entries").
CREATE INDEX IF NOT EXISTS "wiki_exposure_session_idx"
  ON "wiki_exposure" ("session_id") WHERE "session_id" IS NOT NULL;
