-- "Allow + remember same kind" on an approval: stores the claude permission rule
-- ({ toolName, ruleContent? }) the runner adds to the session (addRules / allow /
-- session) so future matching calls are auto-allowed without re-prompting. Nullable
-- (a plain one-off allow leaves it null).
ALTER TABLE "approval" ADD COLUMN "remember_rule" JSONB;
