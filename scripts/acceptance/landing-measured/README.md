# Revision 42 part two, end to end on an isolated stack

Contract: `docs/project-integration-line-contract.md` §12.15 (P-M1, P-M2, P-C1, P-C2, P-R1). One command:

    bash scripts/acceptance/landing-measured/run.sh      # build/converge the stack, runner, project A, project B
    bash scripts/acceptance/landing-measured/stack.sh down

- **Stack** (`stack.sh`): `scripts/runner-link/staging-up.sh` under the Compose project `orbit-link-lm42` (postgres,
  apiserver, web, gateway, link gateway, NATS; images built from this checkout; loopback ports 46086/46443/46464/46422/
  46822), state in `/var/tmp/orbit-link-lm42`. A real runner needs the link gateway: a plain apiserver answers its
  heartbeat 426. The runner is `go build` of `src/runner-go`, registered with `orbit register --no-service` and run under
  `env -i` in a private mount namespace that hides `/root`; its PATH holds no engine but `fake-claude`.
- **Not real:** the agent. `fake-claude` speaks Claude Code's stream-json without a model. A task run follows its
  description: `E2E-DO: commit` commits a work file; `E2E-RUN <key>: <command>` runs the command, writes its output to
  `$LM_DIR/ops-out/<key>.out` and commits nothing (the turn fails if the worktree moved); `E2E-DETACH <key>: <ref>` runs
  `git checkout --detach <ref>` and commits nothing, as a verification run told to check out its project's line does
  (the turn fails if HEAD did not move or the worktree is not clean). A coordinator turn
  `E2E-MCP <id> <tool> <json>` calls the tool through the session's own `orbit mcp`, so every coordinator write goes
  through the real MCP door.
- **Project A** (`a-ops.mjs`): seven operations tasks in three layers in a repository workspace, a start request with no
  line. One of them, D1, checks out a commit pushed to origin as the project line (`git checkout --detach`) and commits
  nothing, so its run reports the diff from its base to that commit as `changed_files` while its own branch stays at its
  base (2026-11-20's regression). Checks: done, zero `project_integration_job` rows, no `project_codebase` row, every
  dependent started on its prerequisites' DONE.
- **Project B** (`b-mixed.mjs`): a PROJECT_BRANCH line with a merge check, Automatic. The coordinator sets the landing
  check (`project_update`) and exempts M2 (`task_update`) without a card. Checks: LAND_TASK only for M1, M2, M4; M2's
  LANDING_CHECK skipped `TASK_EXEMPT` while its TASK_ACCEPTANCE ran; M1/M4 ran the landing check; two
  `project_setting_change` rows; main moved only by a LAND_PROMOTION after a CHECK_PROMOTION whose MERGE_CHECK passed.
- **Records:** `$LM_DIR/records/<run>/<scenario>/` (`transcript.md`, `checks.json`, `queries.txt`, API reads, the fake
  engine's log); `run.sh` prints every `queries.txt` at the end. All queries run read-only
  (`default_transaction_read_only=on`).
