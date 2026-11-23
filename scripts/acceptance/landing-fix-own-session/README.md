# Revision 42 part one, end to end on an isolated stack

Contract: `docs/project-integration-line-contract.md` §12.1–§12.8 (W4–W8). One command:

    bash scripts/acceptance/landing-fix-own-session/run.sh

- **Stack, runner, engine:** part two's kit (`scripts/acceptance/landing-measured/`: `stack.sh`, `bootstrap.mjs`,
  `lib.mjs`, `fake-claude`) under its own Compose project `orbit-link-lfx42`, state in `/mnt/tmp/tmp/lfx42`, loopback
  ports 48086/48443/48464/48422/48822. Images and the runner are built from this checkout; the image build runs under the
  host's heavy lock (`LFX_HEAVY_LOCK`, default `/mnt/tmp/34bc-hpc-heavy.lock`) when that file exists.
- **Not real:** the model. `fake-claude` speaks Claude Code's stream-json without one. A task run follows its
  description: `E2E-DO: commit` with `E2E-SHARED: <file>` also writes a file another task writes too;
  `E2E-BARRIER <name> 2` holds the turn until both tasks of a pair have started, so they share a base;
  `E2E-ONFIX: resolve|decline` says what the session does with a landing-fix turn later. On that turn
  (`landing-fix:v1:<jobId>`, "Orbit could not land your work …"), `resolve` merges the branches the turn names, keeps
  both sides, commits and ends the turn; `decline` ends the turn without a commit, saying `DECLINE_WORDS`.
- **One project** (`cases.mjs`): a PROJECT_BRANCH line with a merge check, Automatic, the coordinator's landing check
  (`LINE_RED.md` must not be on the line), five tasks:
  1. **F1, F2** write `SHARED-1.md`; the second to land conflicts. Checks: the item went to that task's own session
     (`work_session_id`, `work_session_offered_at`), the session got exactly the `landing-fix:v1:<jobId>` turn, the next
     generation LANDED with `retry_requested_by_session_id` = that session and `retry_reason` "Fixed by the task's own
     session", the item is RESOLVED / HANDLED by it, and the coordinator session has no `conversation_turn` between the
     conflict and that landing.
  2. **H1, H2** write `SHARED-2.md`; the one that conflicts declines. Checks: the item is handed back `NO_NEW_COMMIT`,
     OPEN, the coordinator's, with `payload.workSession.lastMessage` equal to the session's words; the coordinator gets
     a turn quoting them; nothing lands again.
  3. **R** lands after the rig pushes `LINE_RED.md` to main. Checks: `CHECK_FAILED` with `baseline_red`, the landing
     check red on the combined tree and on the baseline, the item `BASELINE_RED` and the coordinator's from the start,
     never offered to R's session, which gets no turn after its landing and stays ended `task_done`.
- **Records:** `$LM_DIR/records/<run>/lfx-cases/` (`transcript.md`, `checks.json`, `queries.txt` with read-only queries
  of `project_integration_job`, `project_open_item`, `conversation_turn` and `session`, the fake engine's log, the
  origin's graph). `run.sh` prints `queries.txt` at the end.
