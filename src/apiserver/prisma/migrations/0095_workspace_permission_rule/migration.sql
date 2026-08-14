-- What a workspace always allows, so an approval a human already granted survives the session
-- it was granted in.
--
-- "Allow, and remember" already existed, but the memory lived in claude's own engine as a
-- session-scoped rule (updatedPermissions / destination: session): it died with the process, it
-- was invisible to Orbit, and it could not be revoked. Since Orbit's whole shape is many parallel
-- short sessions over the same checkout, that made the cost of teaching trust scale with the
-- number of sessions — the same `npm test` re-asked in every one of them.
--
-- These rows are the durable half. Orbit stores and scopes them; the runtime still matches them
-- (they are passed to claude as --allowedTools), so no shell-string matcher is introduced here.
--
-- rule_content is NOT NULL with an empty-string default rather than nullable: "" means "every
-- call to this tool", and postgres would treat NULLs as distinct in the unique index below,
-- letting the same tool-wide rule pile up a row per click.
--
-- Deliberately not backfilled from approval.remember_rule. Those clicks meant "for the rest of
-- this session" when they were made, and turning past decisions into standing workspace-wide
-- grants behind the user's back is exactly the widening of trust this table has to be trusted not
-- to do.
CREATE TABLE "workspace_permission_rule" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "rule_content" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "approval_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_permission_rule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_permission_rule_workspace_id_tool_name_rule_conte_key"
    ON "workspace_permission_rule"("workspace_id", "tool_name", "rule_content");

CREATE INDEX "workspace_permission_rule_workspace_id_idx"
    ON "workspace_permission_rule"("workspace_id");

ALTER TABLE "workspace_permission_rule"
    ADD CONSTRAINT "workspace_permission_rule_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
