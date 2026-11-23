# Revision 42 part one, end to end on an isolated stack

Contract: `docs/project-integration-line-contract.md` §12.1–§12.8 (W4–W8, R3). One command:

    bash scripts/acceptance/landing-fix-own-session/run.sh

- **Stack and runner:** part two's kit (`scripts/acceptance/landing-measured/`: `stack.sh`, `bootstrap.mjs`, `lib.mjs`)
  under its own Compose project `orbit-link-lfx42`, state in `/mnt/tmp/tmp/lfx42`, loopback ports
  48086/48443/48464/48422/48822. Images and the runner are built from this checkout; the image build runs under the
  host's heavy lock (`LFX_HEAVY_LOCK`, default `/mnt/tmp/34bc-hpc-heavy.lock`) when that file exists.
- **Engine: the real Claude Code CLI.** `run.sh` copies the host's `claude` out of `/root` (the runner's namespace
  hides it) and `stack.sh` puts it on the runner's PATH (`LM_CLAUDE_BIN`). Its user settings allow `Bash` and
  `mcp__orbit`. Every session of the project runs on one Orbit provider (preset `deepseek`, own base URL) whose
  base URL is `scripted-model.py` on 127.0.0.1:48912. cases.mjs creates it through `POST /providers/mine` and pins it on
  every task. A person-started conversation in the workspace opens first, so the coordinator takes it too.
- **Not real:** the model. `scripted-model.py` answers Anthropic's `/v1/messages` (SSE) from the conversation the CLI
  sends. `E2E-DO: commit` gets one call of the CLI's own Bash tool, which commits the work file. With
  `E2E-SHARED: <file>`, that call also writes a file another task writes too. With `E2E-BARRIER <name> 2`, it waits
  until both tasks of a pair have started. `E2E-MCP` calls an orbit tool, loading it with ToolSearch first. A
  landing-fix turn (`landing-fix:v1:<jobId>`, "Orbit could not land your work …") is answered from the *earlier*
  messages: the task's first turn said `E2E-ONFIX: resolve|decline`, and only the CLI's `--resume` brings that turn
  back. On `resolve`, one Bash call merges the branches the turn names, keeps both sides and commits. On `decline`,
  the model ends the turn without a commit, saying `DECLINE_WORDS`. The Auto-mode classifier is answered
  `<block>no</block>`. `LFX_ENGINE=stand-in` runs part two's `fake-claude` instead, with no CLI and no provider.
- **One project** (`cases.mjs`): a PROJECT_BRANCH line with a merge check, Automatic, the coordinator's landing check
  (`LINE_RED.md` must not be on the line), five tasks:
  1. **F1, F2** write `SHARED-1.md` from one tip. The first landing is held in its landing check while the owner raises
     the runner's `minFreeDiskMb` above the free disk, so the runner's own sweep reclaims the other task's idle
     checkout; then the floor is lifted. That task conflicts. Its session, ended `task_done`, is revived on the same
     runner, gets its checkout back from its local branch, resolves, commits and ends its turn. Checks: the item went
     to that session (`work_session_*`), the session got exactly the `landing-fix:v1:<jobId>` turn, and the model saw the
     resumed history. The next generation LANDED with `retry_requested_by_session_id` = that session and `retry_reason`
     "Fixed by the task's own session", on a merge of the failed source. The item is RESOLVED / HANDLED by it, and the
     coordinator session has no `conversation_turn` between the conflict and that landing.
  2. **H1, H2** write `SHARED-2.md`; the one that conflicts declines. Checks: the item is handed back `NO_NEW_COMMIT`,
     OPEN, the coordinator's, with `payload.workSession.lastMessage` equal to the session's words. The coordinator gets
     a turn quoting them, and nothing lands again.
  3. **R** lands after the rig pushes `LINE_RED.md` to main. Checks: `CHECK_FAILED` with `baseline_red`, the landing
     check red on the combined tree and on the baseline, and the item `BASELINE_RED` and the coordinator's from the
     start, never offered to R's session. That session gets no turn after its landing and stays ended `task_done`.
- **A second project** (case 4, task 352ZEtmx7cOXY91yIodUk), started while main still carries `LINE_RED.md`, on a line
  nobody has pushed: its task **Z** lands first, so the job's T0 is main's own tip and nothing is absorbed. Checks: the
  line is absent from origin before and after, `target_sha_before` = `upstream_sha` = main with no `main_sync_sha`,
  `CHECK_FAILED` with `baseline_red` (the landing check red on the combined tree and on main's own tree), the item
  `BASELINE_RED` and the coordinator's, never offered, and Z's session gets no turn after its landing.
- **Records:** `$LM_DIR/records/<run>/lfx-cases/` (`transcript.md`, `checks.json`, `queries.txt` with read-only queries
  of `project_integration_job`, `project_open_item`, `conversation_turn`, `session` and `runner`, the model's log, the
  origin's graph). `run.sh` prints `queries.txt` at the end. The runner's log is `$LM_DIR/logs/runner.log`.
