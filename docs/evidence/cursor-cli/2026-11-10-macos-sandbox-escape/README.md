# macOS Cursor Auto confinement live verification

Host: `longdeMac-mini.local`, workspace `orbit-macos`, date 2026-11-10.
Cursor CLI: `2026.10.14-941492e`, signed-in default account, Auto permission mode.

## Successful run: both parts

Job `bgj_0f28f462c25d` completed with exit 0 in 50.38 seconds.
`owner-approved-run/events.json` records the real Cursor CLI tool inputs,
outputs and completion events for both parts. `launch-and-approval.json` records
the launch, the single approval request and the person answer without credential
values. `verification.txt` preserves the job output and disk checks.

Part 1 ran the exact inline Python heredoc with no approval card. Its write to
`/Users/long/.orbit-macos-sandbox-escape-1794276990652915000-blocked` returned
`PermissionError: [Errno 1] Operation not permitted`, followed by Orbit's
confinement explanation. The file was absent. The only card was for Part 2.

Part 2 ran this exact owner-approved command:

```sh
printf approved > "$HOME/.orbit-macos-sandbox-escape-1794274214446201000-approved"
```

The owner approved request `approval-1` via the coordinator's Orbit card at
`2026-11-10T02:15:24Z`, owner-answer item `34utyYzewz3qmzoqyowLl`.
The coordinator relayed that answer to this session and explicitly authorized
a rerun of the byte-identical command because the first run had timed out.
The rerun requested exactly that command as `approval-1`. Only after observing
the pending request, this session wrote `approve approval-1` to
`/tmp/orbit-live-approval-34utsde1-retry`.

The local control-plane fixture returned ALLOWED with person provenance
`owner-via-coordinator-card`. This label represents the relayed owner answer;
it is not a production server user id. The approval did not come from a
job-bound server approval. The fixture uses the same approval response and
production permission bridge path as a card answer; the runner's actual
kernel-authenticated grant broker handles the approved command.

The outside file existed, `ls -l` showed 8 bytes, and its content was `approved`.
The harness removed it and confirmed it was absent. Both real Cursor turns
completed. No production confinement or authentication code changed.

The opt-in harness invokes production `prepareCursorLaunch`, the ACP driver,
`orbit-bash`, Seatbelt, the permission bridge and grant broker. The Go test
binary contains the runner's actual internal shell helper. Its turn/inbox
control plane is a local fixture, and its execution uses the real CLI.

## Earlier attempts

The original `abandoned-attempt/` recording proved Part 1 but did not complete
Part 2. The subsequent job `bgj_62d7ad305e15` used a server approval that stayed
pending; `owner-approval-timeout.txt` preserves its timeout.

The first local-file job `bgj_ac6c6d9920f5` printed the exact Part 2 command
above and request `approval-1`, then waited its 30-minute budget without an
owner answer. It exited 1 after 1800.81 seconds. This session never wrote its
approval file `/tmp/orbit-live-approval-34utsde1`. `local-approval-timeout.txt`
preserves its output. The owner answer arrived after that run had ended; no
successful approved command is claimed for the timed-out run.

## Reproduce

Run through Orbit `bg_run` from the repository root:

```sh
ORBIT_CURSOR_MAC_LIVE=1 \
ORBIT_CURSOR_LIVE_APPROVAL_FILE=<absent-absolute-approval-file> \
ORBIT_CURSOR_REAL_OUT=<absolute-output-directory> \
go -C src/runner-go test -tags cursor_real -run '^TestCursorRealMacOSSandboxEscape$' -count=1 -v -timeout 35m .
```

The harness spends two real prompts and waits up to 30 minutes. Its approved
probe path is pinned to the command on the owner card. Obtain the owner's
answer for the exact pending command before writing `approve <request-id>`
to the approval file. A denial uses `deny <request-id>`. The harness verifies
both outside paths and removes the probe before returning.
