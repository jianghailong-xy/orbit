-- 1270 — the Agent's Workflows switch (docs/subagent-workflow-design.md §6, §9 D2; board docs/mocks/subagent-workflow
-- part 5): whether its sessions may start a workflow. On by default, as SubAgents is, so every Agent there is keeps
-- what it has today. Additive: one column with a constant default, no row is rewritten and nothing else is touched.
ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "workflows_enabled" BOOLEAN NOT NULL DEFAULT true;
