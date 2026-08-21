-- Project · Agent · Workspace identity (contract §11.2). ONE migration for units 02A–02E; this
-- file is where each of them lands its slice, and it is not deployed to production until 02V.
--
-- WHY ONE FILE. Every step of §11.2 is a statement about the same set of rows: the `agent` table
-- exists so `project_member.agent_id` can be re-pointed at it, and the re-point is only executable
-- because the mirror set was backfilled first (§3.2 T5). Splitting them across releases would put
-- a database in production whose `project_member` rows point at a table that means one thing on
-- Monday and another on Wednesday — and the ADD CONSTRAINT that proves the mapping is total would
-- be running against a snapshot nobody could reproduce.
--
-- WHAT IS IN IT TODAY (unit 02A, §11.2 steps 1/3/9 as they apply to `agent` alone):
--   * the `agent` table                                   — §3.1
--   * its indexes, including the partial unique of A2     — §3.1 A2, §11.2 step 9
--   * the mirror backfill out of `workspace`              — §11.2 step 3, §3.2 T5
--
-- WHAT IS NOT, and must be appended HERE rather than in a second identity migration:
--   * 02B  `project_workspace`, and the re-point of `project_member.agent_id` (§11.2 steps 4/5)
--   * 02C  `task.assignee_agent_id` / `workspace_id` / `required_capabilities` /
--          `execution_contract`, and the `task_v1_has_no_provider_pin` CHECK (steps 2/6/8)
--   * 02D  `session.agent_id` and the rest of the execution snapshot (step 2)
--   * 02E  `runner.capabilities` / `capabilities_reported_at` (step 2)
--
-- The number is 0129 and not the 0128 the contract text names: `0128_task_supersession_merge_receipt`
-- took that slot first. §11.2 says exactly what to do about that — "编号被占用时只改名字不改规则".

-- ---------------------------------------------------------------------------------------------
-- 1. The `agent` table (§3.1).
-- ---------------------------------------------------------------------------------------------
--
-- WHO does the work. The defining property is a negative one (A1): no `runner_id`,
-- `target_runner_id`, `target_labels`, `work_dir`, `enable_worktree` or `env` column exists here,
-- and none may be added. Those are all answers to WHERE, and the whole point of this table is that
-- choosing who does a task stops being a way to choose which machine runs it.
--
-- `role` is a label for humans (A3). The role that decides anything is `project_member.role`,
-- which is scoped to one project and enforced by an index.
CREATE TABLE "agent" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "role" TEXT,
    "system_prompt" TEXT,
    "append_system_prompt" TEXT,
    "default_provider" TEXT,
    "default_model" TEXT,
    "default_effort" TEXT,
    "provider_fallbacks" JSONB NOT NULL DEFAULT '[]',
    "disallowed_tools" JSONB NOT NULL DEFAULT '[]',
    -- NOT NULL, which `prisma migrate diff` will not ask for: Prisma emits scalar lists as
    -- nullable even though the client types this `String[]` and never returns null for it.
    -- A raw-SQL writer — and this repo has several — could then store NULL, and every reader
    -- would get a value its own type says is impossible. `runner.capabilities`,
    -- `session.required_capabilities` and `task.required_capabilities` (0122) are all NOT NULL
    -- for the same reason; an empty set and "unknown" must not be the same value here.
    "required_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "can_create_tasks" BOOLEAN NOT NULL DEFAULT false,
    "can_delegate" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "legacy_workspace_id" UUID,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------------
-- 2. Indexes (§11.2 step 9).
-- ---------------------------------------------------------------------------------------------

-- A2: one live name per owner, and a PARTIAL unique index rather than a plain one — a soft-deleted
-- Agent must not hold its name for ever. `schema.prisma` cannot express a partial index, which is
-- why this is written by hand here (0108, 0110 and 0111 all do the same for theirs), and it has to
-- be the database's job rather than a service check: two concurrent creates both read "that name
-- is free" and only an index can make exactly one of them land.
CREATE UNIQUE INDEX "agent_owner_id_name_active_key"
  ON "agent" ("owner_id", "name") WHERE "deleted_at" IS NULL;

-- The mirror's idempotency key (§3.1 A4, §11.2 step 3): at most one Agent per legacy workspace, so
-- re-running the backfill cannot produce a second copy of the same identity.
CREATE UNIQUE INDEX "agent_legacy_workspace_id_key" ON "agent" ("legacy_workspace_id");

-- Every listing and every authorization check filters by owner first (§3.1).
CREATE INDEX "agent_owner_id_idx" ON "agent" ("owner_id");

ALTER TABLE "agent" ADD CONSTRAINT "agent_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3. The mirror backfill (§11.2 step 3, §3.2 T5).
-- ---------------------------------------------------------------------------------------------
--
-- One Agent per legacy Agent, where "legacy Agent" means a `workspace` row — that is what the word
-- has meant on the wire since the beginning (MCP `agent_list`, `orbit agent`, `project_member`).
--
-- THE SET IS A UNION, not "the live workspaces" (T5/M2). `project_member.agent_id` can name a
-- SOFT-DELETED workspace, because a soft delete is not a delete and RESTRICT never fired. Leave
-- those out and 02B's re-point has nothing to map them onto: its ADD CONSTRAINT fails on the first
-- such membership, on the production snapshot only, after the DROP has already run. The mirrors of
-- deleted sources carry the source's `deleted_at`, so they exist for the foreign key and appear in
-- no selector.
--
-- WHAT IS COPIED is the frozen list in §11.2 step 3 — `system_prompt`, `append_system_prompt`,
-- `default_model` (from `workspace.model`), `default_effort` (from `workspace.effort`) and
-- `disallowed_tools` — plus the same-named `description`, `enabled` and `created_at`, which are
-- facts about this identity and nothing else. `enabled` in particular: a legacy agent somebody
-- turned OFF must not come back on by being migrated.
--
-- WHAT IS DELIBERATELY NOT COPIED:
--   * `default_provider` stays NULL. A workspace never named a provider — the default is DERIVED
--     from what it last ran — so writing one here would be inventing a decision (§3.1, §11.2).
--   * `provider_fallbacks` stays empty, and is NOT copied from `workspace.provider_fallbacks`.
--     §11.2 step 3 enumerates what is copied and this is not on the list, and §7.4 makes empty the
--     safe value: it means "do not downgrade". A chain of alternates hanging off an Agent whose
--     base provider is NULL is a downgrade path the user never configured on an Agent.
--   * `required_capabilities` stays empty and both permission bits stay false (§8): a migration
--     that granted anything would be granting it on somebody's behalf.
--   * `role` stays NULL. There is nothing on a workspace to derive it from, and a guess here is a
--     label people would read as authoritative.
--
-- DUPLICATE NAMES. Two workspaces of one owner may share a name; A2's index does not allow two
-- live Agents to. The loop appends ' (2)', ' (3)', … taking the first suffix actually free, so a
-- source literally named "build (2)" beside two named "build" still lands — the alternative,
-- computing the suffix with row_number(), collides with exactly that input and fails the whole
-- migration. Sources are walked oldest-first so the assignment is the same on every run, and
-- soft-deleted mirrors keep their source's name verbatim: they are outside the partial index, and
-- renaming a deleted row would be renaming history for a conflict that does not exist.
--
-- IDEMPOTENT on `legacy_workspace_id` (§11.2 step 3): the NOT EXISTS skips sources already
-- mirrored — so a re-run neither duplicates an identity nor burns a fresh ' (2)' on it — and the
-- ON CONFLICT is the same rule stated where the race would land.
DO $$
DECLARE
  src       RECORD;
  candidate TEXT;
  suffix    INT;
BEGIN
  FOR src IN
    SELECT w."id", w."owner_id", w."name", w."description", w."system_prompt",
           w."append_system_prompt", w."model", w."effort", w."disallowed_tools",
           w."enabled", w."created_at", w."deleted_at"
      FROM "workspace" w
     WHERE (w."deleted_at" IS NULL
            OR EXISTS (SELECT 1 FROM "project_member" m WHERE m."agent_id" = w."id"))
       AND NOT EXISTS (SELECT 1 FROM "agent" a WHERE a."legacy_workspace_id" = w."id")
     ORDER BY w."created_at", w."id"
  LOOP
    candidate := src."name";
    IF src."deleted_at" IS NULL THEN
      suffix := 1;
      WHILE EXISTS (
        SELECT 1 FROM "agent" a
         WHERE a."owner_id" = src."owner_id"
           AND a."name" = candidate
           AND a."deleted_at" IS NULL
      ) LOOP
        suffix := suffix + 1;
        candidate := src."name" || ' (' || suffix || ')';
      END LOOP;
    END IF;

    INSERT INTO "agent" (
      "id", "owner_id", "name", "description", "role", "system_prompt", "append_system_prompt",
      "default_provider", "default_model", "default_effort", "provider_fallbacks",
      "disallowed_tools", "required_capabilities", "can_create_tasks", "can_delegate", "enabled",
      "created_at", "deleted_at", "legacy_workspace_id"
    ) VALUES (
      gen_random_uuid(), src."owner_id", candidate, src."description", NULL, src."system_prompt",
      src."append_system_prompt", NULL, src."model", src."effort", '[]'::jsonb,
      COALESCE(src."disallowed_tools", '[]'::jsonb), '{}'::TEXT[], false, false, src."enabled",
      src."created_at", src."deleted_at", src."id"
    )
    ON CONFLICT ("legacy_workspace_id") DO NOTHING;
  END LOOP;
END $$;
