-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- share_link: a public, read-only link is its own row — one root (a session, a task or a project)
-- plus the layers its owner ticked. docs/share-links-design.md §4 is the contract this implements.
--
-- WHY A TABLE
-- -----------
-- `session.share_token` (0052) could say one thing: "this session has a link". Everything the
-- sharing work needs next has nowhere to live there — a task or a project as the root, which layers
-- a visitor may see, an expiry, how often the link was opened, and any record at all of a link
-- once it was turned off. So the link becomes a row, and the session column stops being written.
--
-- WHAT A ROW IS
-- -------------
--   token           The capability in `/s/<token>`: 192 random bits in base64url, the shape
--                   `session.share_token` always had. UNIQUE across every row, live or ended, so a
--                   token that was turned off can never open anything again.
--   session_id /    The root. Exactly one is set (`share_link_one_root_chk`); each is its own
--   task_id /       foreign key, ON DELETE CASCADE — purging a session or deleting a task or a
--   project_id      project deletes its links with it (tasks and projects are hard-deleted).
--   include         The ticked layers, a JSON object with the keys `taskPages`, `commentsAndFiles`,
--                   `conversations` and `toolOutput`. A key that is absent reads as its default
--                   (contract §1), so the object only ever records choices.
--   expires_at      NULL = never. Expiry is lazy: the public door compares it on every read.
--   revoked_at /    Set together (`share_link_revoked_chk`) when the link ends — `TURNED_OFF` by
--   revoked_reason  its owner, or `EXPIRED`. An ended row is kept so the owner's list can show it;
--                   it never comes back. Turning sharing on again inserts a new row with a new token.
--   view_count /    How often the ROOT page was opened, and when last. Paging, attachments and
--   last_viewed_at  nested pages do not count.
--
-- At most one link per root is not ended: a partial unique index per root column, over
-- `revoked_at IS NULL`. An expired link that nobody has settled yet still holds that slot, which is
-- why whoever opens a new link for the same root marks the old one EXPIRED first.
--
-- `owner_id` is the tenancy column every owner read filters by. The roots each carry their own
-- owner; the service refuses a root that is not the caller's before it writes. (`session` has no
-- `(id, owner_id)` key for a composite foreign key to name, so the three roots are referenced alike.)
--
-- THE BACKFILL
-- ------------
-- Every session with a `share_token` today (25 on this deployment, 2026-09-25) gets one row that
-- carries that exact token string — so every `/s/<token>` already handed out keeps opening — with
-- `include = {"toolOutput": true}`, which is what the page has always shown, and `created_at` taken
-- from `shared_at`. A shared session that is in the trash gets an un-ended row like any other: the
-- trash pauses a link rather than ending it (contract §3), which is what the old column did too.
-- `shared_at` is a TIMESTAMP(3) holding UTC, Prisma's convention for this table; `AT TIME ZONE
-- 'UTC'` reads it as that instant whatever the migrating connection's TimeZone is. A token with no
-- `shared_at` (none here, but the old code tolerated the pair drifting) is dated now.
--
-- `session.share_token` and `session.shared_at` are left exactly as they are, and nothing writes or
-- reads them from this release on; dropping them is a separate, later change. Their unique index
-- stays with them.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No function, trigger or type is created, replaced or dropped. `session`, `task`, `project` and
-- `user` are named only as the tables the four foreign keys reference and, for `session`, the table
-- the backfill reads: none of them is altered, and no row of any of them is written or deleted.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0306: the highest number on every branch of origin and in every local worktree was 0305 when this
-- was written (2026-09-25 09:13 UTC). Every statement can run twice: IF NOT EXISTS, constraints
-- inside a `duplicate_object` guard, and the backfill skips a token that already has its row and a
-- session that already has a link that has not ended.

CREATE TABLE IF NOT EXISTS "share_link" (
  "id"             UUID NOT NULL,
  "owner_id"       UUID NOT NULL,
  "token"          TEXT NOT NULL,
  "session_id"     UUID,
  "task_id"        UUID,
  "project_id"     UUID,
  "include"        JSONB NOT NULL DEFAULT '{}',
  "expires_at"     TIMESTAMPTZ(3),
  "revoked_at"     TIMESTAMPTZ(3),
  "revoked_reason" TEXT,
  "view_count"     INTEGER NOT NULL DEFAULT 0,
  "last_viewed_at" TIMESTAMPTZ(3),
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "share_link_pkey" PRIMARY KEY ("id")
);

-- Exactly one root.
DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_one_root_chk"
    CHECK (num_nonnulls("session_id", "task_id", "project_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An ended link says why, and only an ended link does. Spelled so that no operand can be NULL: a
-- CHECK passes when its expression is NULL, so `revoked_reason IN (...)` alone would let a NULL
-- reason through beside a set `revoked_at`.
DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_revoked_chk"
    CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL)
       AND ("revoked_reason" IS NULL OR "revoked_reason" IN ('TURNED_OFF', 'EXPIRED')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_include_chk" CHECK (jsonb_typeof("include") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_view_count_chk" CHECK ("view_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The public door's only read: token → link, live or ended.
CREATE UNIQUE INDEX IF NOT EXISTS "share_link_token_key" ON "share_link" ("token");

-- One link per root that has not ended.
CREATE UNIQUE INDEX IF NOT EXISTS "share_link_session_active_key"
  ON "share_link" ("session_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "share_link_task_active_key"
  ON "share_link" ("task_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "share_link_project_active_key"
  ON "share_link" ("project_id") WHERE "revoked_at" IS NULL;

-- The owner's list (Settings → Shared links).
CREATE INDEX IF NOT EXISTS "share_link_owner_id_idx" ON "share_link" ("owner_id");

-- Every token already handed out, carried over unchanged.
INSERT INTO "share_link" ("id", "owner_id", "token", "session_id", "include", "created_at", "updated_at")
SELECT gen_random_uuid(), s."owner_id", s."share_token", s."id", '{"toolOutput": true}'::jsonb,
       COALESCE(s."shared_at" AT TIME ZONE 'UTC', CURRENT_TIMESTAMP),
       COALESCE(s."shared_at" AT TIME ZONE 'UTC', CURRENT_TIMESTAMP)
  FROM "session" s
 WHERE s."share_token" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "share_link" l WHERE l."token" = s."share_token")
   AND NOT EXISTS (SELECT 1 FROM "share_link" l WHERE l."session_id" = s."id" AND l."revoked_at" IS NULL);
