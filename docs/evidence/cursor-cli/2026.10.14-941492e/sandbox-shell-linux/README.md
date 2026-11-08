# Linux shell invocation probe

Pinned real Cursor CLI `2026.10.14-941492e`, Linux HPC, 2026-11-08 Asia/Shanghai.
The CLI used the runner's configured API-key file without exposing its contents.
Only temporary test sessions/workspaces were used. No macOS connection was attempted.

- `00-*.json` through `09-*.json`: complete wrapper argument vectors (including script argv[0]), cwd, entry environment, wall-clock nanoseconds and wrapper PID/parent PID. Credential-named environment values are masked before writing. Machine paths and UUIDs use the existing real-test redactor. Command fd 5 is recorded as text and base64, including its NUL terminator. `fd5_target` is a kernel socket inode, not an approval token.
- `process/{stdin,stdout,timeline}.jsonl`: raw ACP messages in each direction, with the existing secret/path redaction. UUID placeholders in these files share the shell recording's mapping. `timeline` times are milliseconds from recorder startup, **not** wall-clock nanoseconds: do not compare them directly to `at_ns`.
- `summary.json`: the runner harness's cards, auto-allow events, process samples and turn completions. It uses its own UUID placeholder mapping; compare commands, not UUID labels, with the other files.
- `probe.go.txt`: exact temporary Go probe used for the socket recording. It reuses `cursor_permissions_real_test.go` and `cursor_acp_test.go`; not compiled or installed as product code.
- `prompts-ledger.jsonl`: twelve charged prompts, including two exploratory runs. The retained `process/` and numbered shell files are from the final four-prompt socket run. Exploratory runs established argv/env and then that fd 5 is a socket; they are not evidence for reading its payload.
- `check.py`: offline assertions covering the recorded matrix, duplicate equality, payloads, permission replies, and card routing.

## Reproduction

Temporarily copy `probe.go.txt` to `src/runner-go/cursor_sandbox_probe_test.go`.
In `runRealCursorRecorder`, immediately before `cmd := exec.Command(exe, os.Args[1:]...)`,
insert `sandboxProbeInstrument(dir)`. Do not change the redactor or product wrapper.
Run from `src/runner-go`, using absolute paths:

```sh
ORBIT_CURSOR_REAL_CLI=<orbit-home>/cursor/versions/2026.10.14-941492e/cursor-agent \
ORBIT_CURSOR_REAL_KEY_FILE=<private-key-file> \
ORBIT_CURSOR_REAL_LEDGER=<private-scratch>/prompts.jsonl \
ORBIT_CURSOR_REAL_OUT=<private-scratch>/out \
go test -tags cursor_real -count=1 -run '^TestCursorSandboxProbe$' -v .
```

The temporary wrapper invokes Python before its original contents, records `/proc/<wrapper-pid>/environ`,
and uses `recv(MSG_PEEK)` on a duplicate of fd 5. Peeking leaves the command for Bash to read.
The original wrapper still restores HOME, strips credentials and execs Bash. The snapshot has no fd 5.
Remove the temporary Go file and recorder call afterwards. Keep the source output private until redacted.

The shell records are sorted by `at_ns` and split into numbered JSON files without dropping fields.
Run `python3 docs/evidence/cursor-cli/2026.10.14-941492e/sandbox-shell-linux/check.py` from the repository root.

## What this establishes

The first prompt produced `ls` without a permission request, `touch auto-allowed.txt` with a permission
request answered by `cursorAutoAllows` without a card, and the Python command through the runner's
card path. Exactly one card was created. Its response was **ALLOWED supplied by the controlled harness**,
not a human click on a production Orbit approval card. Both permission paths sent `allow-once`.
This limitation is retained explicitly; the recording does not establish a human UI interaction.

The prompts requested `block_until_ms: 0` for the background and concurrent calls. ACP's `rawInput`
retains only `command`, so the exact numeric tool parameter is not independently exposed in this recording.
The background `sleep` calls report completion before their sleeps can finish and with empty stdout;
foreground `printf foreground` reports its output. The two identical wrappers start less than three
seconds apart, with identical argv, cwd, command payload and environment, and distinct PIDs/socket inodes.

No shell-visible toolCallId or approval flag was observed. This is an observation about these runs,
not a proof that no internal CLI state contains a call identifier. The broker mechanism in §8.5 is a
proposed design, not a tested implementation. It uses exact-match, count-limited grants keyed by
conversation, cwd and the complete command bytes, created only for a person/card-path ALLOWED response
before allow-once is sent. A trusted wrapper atomically consumes one matching grant and decides how
to execute; no second approval card is required. Identical commands may consume the same key's
approvals in either order, but unsandboxed executions must not exceed approvals. See §8.5 for caller
validation, fd-5 replay, expiry, lost replies and the default sandboxed behavior. A hash alone, without
exact-key verification and an atomic count, is insufficient.
