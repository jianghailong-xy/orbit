-- The worktree status bar showed a clickable "Merge to main" button even for branches already
-- landed in main, because the button only ever knew about merges performed through Orbit's own
-- button (mergeStatus). A branch merged out-of-band (a command-line `push origin HEAD:main`, or
-- an earlier session whose merge record was cleared on resume) left mergeStatus NULL, so the bar
-- kept offering a redundant Merge. `branch_merged` is the runner's `git merge-base --is-ancestor
-- <branch> <default target>` result, refreshed alongside worktreeDirty on every worktree report
-- (heartbeat mid-turn, turn-complete, on-demand diff): true → the branch is already in main, so
-- the bar shows a quiet "✓ In main" chip instead of a Merge button. NULL for existing rows and
-- older runners that don't report it → the bar keeps its current behavior.
ALTER TABLE "session" ADD COLUMN "branch_merged" BOOLEAN;
