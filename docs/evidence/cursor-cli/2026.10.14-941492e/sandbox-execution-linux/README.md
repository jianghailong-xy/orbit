# Linux sandbox execution and fresh-shell escalation

Real Cursor CLI `2026.10.14-941492e`, Linux HPC, bubblewrap, 2026-11-08.
Run by `TestCursorRealSandbox4`, using the production launch, wrapper, grant broker,
permission bridge, and CLI, with a controlled approval server and protocol recorder.

The four turns in `process/` show:

1. A Python heredoc attempts `$HOME/outside-file`: read-only-filesystem failure,
   exit 1, Orbit's English sandbox explanation, and no file.
2. A shell command defines a `printf` function that would create
   `$HOME/planted-executed`. The definition runs sandboxed and persists in Cursor's state.
3. `printf approved > "$HOME/approved-file"` is answered through the card path
   with person-decision provenance. The grant is consumed; fresh Bash creates the
   file containing `approved`. The planted function does not execute.
4. `type printf` runs sandboxed and still prints the planted function: the approved
   path relayed the snapshot without evaluating or destroying it.

`summary.json` records disk assertions, all four completions, card inputs, and
the runner's tool outputs. `process/{stdin,stdout,timeline}.jsonl` preserve both
ACP directions and their ordering; `stderr.txt` and `exit.json` record the CLI's
own diagnostics and termination. Paths, UUIDs, and credentials use the existing
real-test redactor. `prompts-ledger.jsonl` includes exploratory startup failures
and successful four-turn runs; those startup failures are not successful
command-execution evidence. The final recording is the last run only.

## Reproduce

From `src/runner-go`, supply absolute paths:

```sh
ORBIT_CURSOR_REAL_CLI=<pinned-cli>/cursor-agent \
ORBIT_CURSOR_REAL_KEY_FILE=<private-key-file> \
ORBIT_CURSOR_REAL_LEDGER=<private-scratch>/prompts.jsonl \
ORBIT_CURSOR_REAL_OUT=<private-scratch>/out \
go test -tags cursor_real -timeout 12m -count=1 -run '^TestCursorRealSandbox4$' -v .
```

The test caps spending using the existing real-CLI prompt ledger. It creates and
removes a temporary HOME under the real HOME, outside the sandbox's writable roots.
It requires the sandbox to be detected and usable for the assertions to pass.

From the repository root, reproduce the unsafe historical loader behavior without
calling an LLM or changing product code:

```sh
python3 docs/evidence/cursor-cli/2026.10.14-941492e/sandbox-execution-linux/snapshot-state-replay.py
```

The script uses task 1's exact recorded state dumper and loader. Its temporary
write is deliberate and is removed when the script exits. The fixed regression
is `TestCursorFreshShell`; it asserts no snapshot function/startup injection runs,
the approved outside write succeeds, exit 7 is preserved, and fd-4 status carries
the original snapshot as inert bytes. `TestCursorShellSandboxAndUnknownCaller`
covers actual bwrap execution, exact fd-5 replay, malformed payload rejection,
and rejection of an unrelated same-UID broker client. The grant tests cover exact
keys, concurrent consumption, deduplication, expiration, revocation, and provenance.

## Boundaries of this evidence

- The controlled server simulates the human response; **no production human UI
  click is claimed**. The approved card supplies `decidedById`; the other two cards
  do not. This exercises the provenance boundary, not the deployed UI.
- The first two requests use controlled non-person `ALLOWED` responses; this task
  does not claim that Auto's classifier now allows Python heredocs without a card.
- The runner binds grants to the known checkout cwd. A wrapper starting elsewhere
  cannot escape. Snapshot cwd tracking is not implemented.
- Linux process authentication is implemented. macOS currently refuses escape
  grants and requires the separate macOS follow-up; no macOS success is claimed.
- The API's new optional `decidedById` field must be deployed with this runner to
  enable real human-approved escapes. An older server fails closed.
