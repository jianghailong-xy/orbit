# The session-release protocol, old and new runner on one server

Plan step 6.2 (`docs/session-three-state-plan.md` §9). One command:

    bash scripts/acceptance/session-release/run.sh
    LM_PROJECT=orbit-link-relwalk LM_HTTP_PORT=53086 LM_LINK_PORT=53443 LM_METRICS_PORT=53464 \
      LM_NATS_PORT=53422 LM_NATS_MONITOR_PORT=53822 LM_PEBBLE_PORT=53500 \
      bash scripts/acceptance/landing-measured/stack.sh down        # afterwards

- **Stack:** the landing-measured kit's (`scripts/acceptance/landing-measured/stack.sh`) under the Compose project
  `orbit-link-relwalk`, loopback ports 53086/53443/53464/53422/53822, state in `/var/tmp/orbit-link-relwalk`. The
  apiserver image is built from this checkout.
- **Runners:** two, from `stack.sh` with `LM_RUNNER=old` and `LM_RUNNER=new`. `old` is `go build` of `src/runner-go`
  at `SR_OLD_REF`. By default that is where this branch leaves the project branch: the runner before step 6.2, which
  speaks the old protocol. `new` is `go build` of this checkout. Each has its own workspace and repository. The only
  engine either one has is the kit's `fake-claude`.
- **The switch:** `ORBIT_SESSION_RELEASE_V1` is written into the stack's env file, and the apiserver is recreated.
- **Not real:** the agent. `fake-claude` takes `E2E-FAIL[-WHILE <flag>]: <text>` (a failed turn),
  `E2E-SWALLOW-WHILE <flag>` (a delivery nobody answers) and `hold-commit-message` (a scratch file under
  `$LM_DIR/ops-out`). While that file exists, the commit message the runner asks for before its release is held, which
  is the window in which the walk kills the new runner.

Cases. Pass ON has the switch on and runs the old runner, then the new one. Pass OFF has the switch off and runs the
new runner again.

| # | Case | What is compared |
|---|---|---|
| 1 | A failed turn (`E2E-FAIL`) | session: status, released (`finished_at` set), `end_reason`, `last_turn_outcome`, error; each work turn: kind, status, outcome, error |
| 2 | A turn answered, then the owner's End | the same |
| 3 | A message to each of those sessions (resume) | the same, after the resumed turn is answered |
| 4 | A retryable failure (`API Error: 529`), whose armed retry fires | the release, then the session after the retry |
| 4k | New runner, switch on: the same failure, the runner killed (SIGKILL) between its turn report and its release | the held row, then the reaper's cancel-grace release, then the retry |
| 5 | A task's run whose delivery is swallowed (read three times, never answered) | the session, its turns, the task's status and comments |

Records go to `$LM_DIR/records/<run>/session-release/`: `transcript.md`, `queries.txt` (every read-only query and its
output, also printed at the end), `checks.json`, and each pass's runner log. Exit 0 only if every check passed.
