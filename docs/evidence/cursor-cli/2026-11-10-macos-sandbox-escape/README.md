# macOS Cursor Auto sandbox and approved escape live verification

Host: `longdeMac-mini.local`, workspace `orbit-macos`, local date 2026-11-10.
Production source baseline: `b37a1f2d5e68c9fe9690d23834a3d32d2214d1e1`.
Cursor CLI: `2026.10.14-941492e`, signed-in default account, Auto permission mode.

The opt-in `TestCursorRealMacOSSandboxEscape` uses `runCursorSession` to invoke
production `prepareCursorLaunch`, the ACP driver, `orbit-bash`, Seatbelt, the
permission bridge and the kernel-authenticated grant broker. The Go test binary
contains the current runner's actual internal shell helper. The production runner
was also built as `/Users/long/.orbit/caches/orbit-macos-live-runner`.
The turn/inbox control plane is a local fixture; Case B approval requests are
forwarded to the real Orbit server for this task session. No approval identity
is invented by the fixture. The test passes the server's actual decision back
to the production permission bridge.

`abandoned-attempt/events.json` is the runner's real CLI session transcript, including exact tool
inputs, outputs and completion events. `abandoned-attempt/launch-and-approval.json` records the
CLI launch and server approval response without serializing credential-bearing
environment variables. `abandoned-attempt/verification.txt` records the disk checks and test result.

## Reproduce

Run through Orbit `bg_run`; the card names that job so it stays answerable
when the calling conversation turn ends. From the repository root:

```sh
cd src/runner-go
ORBIT_CURSOR_MAC_LIVE=1 \
ORBIT_CURSOR_LIVE_SESSION=<session-id> \
ORBIT_CURSOR_LIVE_JOB="$ORBIT_BG_JOB_ID" \
ORBIT_CURSOR_REAL_OUT=<absolute-output-directory> \
go test -tags cursor_real -run '^TestCursorRealMacOSSandboxEscape$' -count=1 -v -timeout 20m .
```

This spends two real Cursor prompts. Approve only the card for the exact
`printf approved > "$HOME/.orbit-macos-sandbox-escape-…-approved"` command.
The probe checks both files with `ls -l`, checks their presence and contents,
and removes its outside files before returning.

## Result

Case A is confirmed by `abandoned-attempt/events.json`: the real CLI issued the
exact Python heredoc, it returned `PermissionError: [Errno 1] Operation not
permitted` with Orbit's sandbox explanation, and `verification.txt` shows `ls`
found no blocked file. Both approval cards in that attempt were for Case B,
not Case A. Case B was abandoned at conversation-turn settlement, before the
harness carried its background-job identity. No approved write occurred.

The replacement run `bgj_62d7ad305e15` carried `backgroundJobId` on the real
approval, keeping it answerable between conversation turns. It ended after
901.34 seconds with no owner decision received:

```text
REAL_OWNER_CARD 01a1c289-f6ed-74e8-851a-9254a7e5da1a
real card answer: ... context deadline exceeded
the session did not finish on its own: context deadline exceeded
--- FAIL: TestCursorRealMacOSSandboxEscape (901.34s)
```

`owner-approval-timeout.txt` preserves that job's output. That timeout prevented
the helper from returning its final event snapshot; no completed transcript for
that attempt is claimed. The completed earlier attempt above supplies Case A.
No successful approved escape or complete acceptance is claimed. This task
requires another live run with a person available to approve Case B. The missing
approval is not evidence that the broker's approved execution path failed.

Checks already completed on the Mac:

- Current production runner build: `bgj_944e98fcedcf` (the later live-test
  preflight in this same job failed because TestMain cleared the session id).
- Darwin build and vet: `bgj_610d62d90cb2`, exit 0.
- Native kernel caller authentication and sandbox regressions:
  `bgj_d4ad3164a748`, exit 0.

Earlier harness-only problems (missing temporary cache root, unmarked HTTP
transport, and approval lifetime) were corrected in the opt-in test. Production
sandbox or authentication code has not changed in this task.

## Local approval file attempt

Job `bgj_ac6c6d9920f5` ran the real Cursor CLI with the revised harness and
its 30-minute wait budget. The harness printed the pending approved command:

```sh
printf approved > "$HOME/.orbit-macos-sandbox-escape-1794274214446201000-approved"
```

Request: `approval-1`. Approval file: `/tmp/orbit-live-approval-34utsde1`.
The session ended its turn to let the coordinator obtain the owner's card answer.
No owner answer arrived, and the session never wrote the approval file. The job
ended with exit 1 after 1800.81 seconds (context deadline exceeded). No successful
approved command or Part 2 completion is claimed. The helper stops on timeout
before exporting its final event snapshot. The earlier Part 1 recording remains
the evidence for the refused inline heredoc.

For the revised harness, set `ORBIT_CURSOR_LIVE_APPROVAL_FILE` to an absent
absolute path instead of setting the old server session/job variables, and use
`-timeout 35m`. Only after the coordinator relays the owner's card approval,
write `approve <request-id>` to that file. The fixture returns that answer with
person provenance through the production permission bridge; the grant broker
still handles the approved command. A denial uses `deny <request-id>`.
