# macOS shell invocation recording

Cursor CLI `2026.10.14-941492e`, longdeMac-mini.local, macOS 27.2 / Darwin arm64,
2026-11-09. The task adds evidence only; no sandbox implementation is changed.

## Files and provenance

- `00-*.json` through `09-*.json`: final four-prompt native-entry run, job
  `bgj_70d53512bcde`. Complete wrapper argv, cwd and entry environment, wall-clock
  nanoseconds, PID/PPID, and fd-5 command text/base64 including terminating NUL.
  The chronological B/A order is intentional. The two identical entries differ by
  44,000 ns; this is wrapper-entry spacing, not a scheduler/exec latency claim.
- `process/`: real ACP stdin, stdout, stderr, timeline and exit recording. Relative
  timeline milliseconds cannot be subtracted from wrapper wall-clock nanoseconds.
- `summary.json`: runner cards, Auto permission decisions, turn completions and
  explicit missing-cache fallback notice. Its UUID placeholder mapping is separate
  from the mapping shared by numbered entries and primary protocol files.
- Explicit-person recording: **pending**, not yet present. A separate real CLI invocation is paused at the harness's card callback.
  The callback creates a production Orbit `CursorShellRecording` approval, naming
  the exact harmless Python command. It waits for the actual decision and forwards
  its status and decider provenance through the runner's controlled card response.
  The custom tool name avoids the workspace's existing Bash standing rule. No person decision is claimed until that card is answered and recorded.
- `standing-grant/`: the earlier relay under `Bash`, answered by the workspace's
  existing standing rule. The summary records ALLOWED/standingGrant and no decider.
  Its `person-approved` check intentionally fails; this attempt was not a person
  click and was retained to explain why a distinct recording card was needed.
- `detection.json`: runner-hosted `detectCursorSandbox` result, exact trial profile,
  argv, cwd, output/errors, macOS version, and empty process-start identity, job
  `bgj_a33174f170bf`. The production code's `--` separator succeeds; a diagnostic
  retry without it also succeeds. No product changes are made by that retry.
- `engine-sandbox-trial.json`: the same argv executed by Codex's already sandboxed
  exec tool, exit 71 / `sandbox_apply: Operation not permitted`. This is explicitly
  a different execution context from the host result, not evidence that the host
  lacks Seatbelt. The task's earlier coordinator comment reported a failure; this
  recording narrows where that failure can be reproduced now.
- `probe.go.txt`, `harness.patch`: exact temporary probe and harness adaptation.
  The native C entry shim writes `environ` as NUL-separated bytes to a private
  temporary file before any interpreter starts. A Python child reads/masks that
  file, deletes it, and records argv and socket `recv(MSG_PEEK)`. The C shim waits
  for it, then execs `/bin/sh` with the untouched original wrapper. This inserts
  recording processes and changes the intermediate script pathname; it does not
  consume fd 5 or alter the original wrapper's argument list/environment inputs.
  Snapshot/command Bash execution is still the real wrapper's `exec /bin/bash`.
- `abandoned-person-card/`: the first explicit-person attempt received ABANDONED
  after its opening turn ended. TestMain had cleared its background reader ID;
  the retained probe now captures that ID before TestMain. Only the snapshot ran.
- `exploratory-sysctl/`: initial argv/fd-5 recording with empty environment entries;
  excluded from the matrix because it cannot establish the entry environment.
- `prompts-ledger.jsonl`: charged exploratory and final prompts. The first four
  prompts used a sysctl-based probe whose environment list was empty; they are
  excluded from the final matrix. The next four produced the numbered entries.
  Later prompts include the production approval experiments. No credential values
  are in the ledger. The existing harness's ledger task label is legacy P5c, not
  this task's identity; job provenance above identifies this task's recordings.
- `check.py`: independent, offline assertions over these committed recordings.

Credential-named environment values are replaced by `<REDACTED>` before writing
JSON. The existing harness redactor replaces API keys, tokens, emails, temporary
paths and UUIDs with placeholders. Paths in the host/nested diagnostic are retained
verbatim. Full argv and all environment keys/values are retained subject to those
redactions; placeholders are not the original bytes. Shell payload base64 encodes
these fixed, non-secret command strings without redaction.

## Reproduce

Use a private scratch directory and the runner-hosted job service, outside an
existing engine sandbox. An installed, signed-in Codex and pinned Cursor CLI are
prerequisites; the real Cursor harness uses the configured API key file, without
printing it. Temporarily apply `harness.patch` and copy `probe.go.txt` to
`src/runner-go/cursor_sandbox_probe_test.go`. From `src/runner-go`:

```sh
ORBIT_CURSOR_REAL_CLI=<pinned-cli>/cursor-agent \
ORBIT_CURSOR_REAL_KEY_FILE=<private-api-key-file> \
ORBIT_CURSOR_REAL_LEDGER=<private-scratch>/prompts.jsonl \
ORBIT_CURSOR_REAL_OUT=<private-scratch>/out \
go test -tags cursor_real -count=1 -timeout 10m -run '^TestCursorSandboxProbe$' -v .
```

For the person-card run, also set `ORBIT_MAC_RECORD_SESSION` to the live recording
session and select `^TestCursorMacPersonCard$`. It uses the normal named MCP caller
transport with the runner config and actual production approval API. It never
answers the card itself. A person must allow the harmless print command. Retain
`decidedById` in the received decision; a standing grant is not a substitute for
this matrix row. A background job ID, supplied by Orbit itself, binds the card's
reader to the recording job.

Run `^TestCursorMacSandboxDetectionProbe$` separately with `ORBIT_CURSOR_REAL_OUT`
set to an existing directory. The detection probe uses the actual host cache root;
its controlled CLI fixture uses a temporary ORBIT_HOME with no cache root, records
that resolution failure, and therefore records the old unsandboxed wrapper.
Restore the tracked harness and remove the temporary Go test afterwards. Retain
only the redacted output. Run `python3 <this-directory>/check.py` to verify it.

## Interpretation limits

As in Linux, numeric `block_until_ms: 0` is present in the prompts but absent from
ACP rawInput. Early completion/empty stdout and overlapping wrapper entries support
background/concurrent execution; exact model tool arguments are not independently
observable here. Unix sockets on macOS do not expose the Linux `/proc` socket inode
recorded by the Linux probe. Distinct PIDs are recorded instead.

This verifies shell-input compatibility, not a macOS sandbox or broker. The counted
exact-command grant design remains applicable. Linux `/proc` and peer identity
checks cannot carry over unchanged: macOS's existing non-Linux helper returns no
process-start identity and refuses escapes. A trusted macOS identity implementation
and Seatbelt write-confinement/end-to-end escalation verification remain separate
work, as described in contract §8.5.2.
