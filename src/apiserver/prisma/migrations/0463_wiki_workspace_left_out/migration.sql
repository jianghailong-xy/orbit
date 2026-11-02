-- 0463 — a workspace the owner left out of its wiki (contract `space.binding`, docs/mocks/wiki/38-workspaces).
--
--   wiki_space_workspace.left_out_at  TIMESTAMPTZ(3). When the owner turned the workspace off in Wiki settings. Its
--                                     sessions then feed no maintenance run and are refused the wiki tools, and it
--                                     does not rejoin by itself. NULL: the workspace is in the space. Written by the
--                                     owner's two doors (`WikiService.leaveWorkspaceOut` sets it,
--                                     `WikiService.bindWorkspace` clears it) and by nothing else.
--
-- One nullable column with no default, so the ADD is catalog-only: no table is rewritten and no row is read, written
-- or backfilled. Every binding that exists stays in its space. A workspace on a space's repository with no row at all
-- is in that space from the moment the code that reads it so is running, which is why nothing here inserts rows:
-- membership is read from `workspace.repo_url`, through the one normalizer repository identity has
-- (`wiki/wiki-workspaces.ts`), rather than copied into this table. No index (the readers go by owner, by workspace
-- or by space, which have theirs), trigger, function or constraint is created, replaced or dropped.
--
-- 0463: the next number free on main and in every session worktree (2026-11-02).

ALTER TABLE "wiki_space_workspace" ADD COLUMN "left_out_at" TIMESTAMPTZ(3);
