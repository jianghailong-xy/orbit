# macOS Seatbelt confinement verification

Recorded on `longdeMac-mini.local`, Darwin arm64 / macOS 27.2, 2026-11-09.
Cursor CLI is the installed pinned `2026.10.14-941492e`; Codex reports signed in
using ChatGPT (`bgj_e2b75544c9b5`). No credential values are retained.

## Real Auto run

`bgj_3edf5266b5ca` runs `TestCursorRealSandboxMacOS` against the real Cursor ACP
process through Orbit's production launch, session loop and permission bridge.
The control plane is the existing test harness. It denies any card; it does not
simulate a person approving a command. `summary.json` records zero cards and all
checks passing. `process/` retains redacted ACP stdin/stdout, timeline and exit.

The exact command is:

```sh
python3 - <<'PY'
from pathlib import Path
(Path.home() / 'outside-file').write_text('blocked')
PY
```

HOME is an empty temporary directory under the real user's home, outside all
writable roots. The command runs without a card, returns Python's `Operation not
permitted`, and includes `This command ran in Orbit's Auto sandbox, which blocks
writes outside the workspace and other writable roots.` The harness independently
checks that `outside-file` is absent before removing its temporary HOME.

`prompts-ledger.jsonl` includes the initial rejected exploration and the three
successful runs. The first used `os.environ`, which matches the existing secret
marker `.env` and therefore received a card, denied by the harness. It is not
claimed as confinement evidence. The second established confinement before the
launch-file protection fix; the third included that fix, and the fourth produced
the retained final recording with the independent client-side escape refusal.
The ledger's task label is inherited from the P5c harness; the job IDs here bind
these recordings to this macOS task. No classifier policy was changed.

## Host tests and fixes

Use runner-hosted `bg_run`, not an engine's already sandboxed shell:

```sh
cd src/runner-go
ORBIT_REQUIRE_CURSOR_SANDBOX=1 go test -v -count=1 -timeout 10m \
  -run 'TestCursor(Sandbox(Detection|Confinement|Child|MacOSLaunchFiles)$|Shell|FreshShell|Grant)' .
go build ./...
go vet ./...
```

`bgj_87694540ac51` passes all of these with no skipped selected tests. Confinement
checks writes in the workspace, `/tmp`, the Darwin temporary directory and runner
cache root; denies HOME writes and checks absence; connects to a host TCP listener;
and preserves inherited descriptors 3–5. Linux-only bubblewrap installation tests
are intentionally excluded from this Mac selection.

The baseline `bgj_245bf24e88b3` found three platform differences: Python reports
EPERM rather than EACCES/EROFS, Bash canonicalizes `/var` to `/private/var`, and
Darwin's Unix socket path limit rejects the long session-control address. The
fix uses a temporary private short symlink for each bind/dial, immediately removes
the alias, and leaves the socket in its original protected session directory.
Launch/workspace paths are canonicalized before containment checks.

The additional regression `bgj_2983780fc4c5` demonstrated that denying writes to
a sealed subtree alone still permits renaming its ancestor. The Seatbelt profile
now denies writes to those ancestor directory entries as well. The regression
and the real CLI pass with the updated profile. The availability trial is
unchanged: a nested engine can legitimately fail to apply another Seatbelt
profile; the actual runner-hosted trial succeeds. No trial was bypassed or weakened.

## Explicit refusal of macOS escapes

**macOS never executes an escape grant. A person-approved outside write remains
sandboxed and fails.** The current macOS backend has no verified executable,
live CLI ancestry/start identity, cwd and conversation authentication. Its start
identity is empty and `cursorShellPeer` refuses every caller. LOCAL_PEERPID or
UID checks alone would not establish the Linux backend's stronger contract.
This is a refusal of unsafe authentication, not a claim that secure macOS
authentication is impossible.

The helper now independently refuses escapes on non-Linux platforms even if a
substituted broker replies `true`. The short alias lives in writable temp space,
so such a response must never be treated as authentication. The real-process
`TestCursorShellMacOSRefusesForgedEscape` supplies a forged positive reply to an
actual helper loader invocation and verifies the outside write still fails with
the English sandbox message and no file. It passes in `bgj_87694540ac51`.
`TestCursorShellSandboxAndUnknownCaller` also verifies an arbitrary same-UID
caller cannot consume a grant. No successful approved Mac escape is claimed.

## Reproduce the real run

Set absolute paths to the installed CLI, a private API-key file, prompt ledger
and output directory (the key file's contents are never printed):

```sh
cd src/runner-go
ORBIT_CURSOR_REAL_CLI=<installed-version>/cursor-agent \
ORBIT_CURSOR_REAL_KEY_FILE=<private-key-file> \
ORBIT_CURSOR_REAL_LEDGER=<scratch>/prompts.jsonl \
ORBIT_CURSOR_REAL_OUT=<scratch>/recording \
go test -tags cursor_real -count=1 -timeout 10m \
  -run '^TestCursorRealSandboxMacOS$' -v .
```

The committed opt-in test and shared recorder produce the files directly with
the existing key/token/email/path/UUID redactor. HOME and cache setup are test
fixtures; this does not exercise production account login or an ordinary live
Orbit control plane. This task does not run or change the known failing macOS
Cursor sign-in/install tests (`TestCursorAddAccountRelaysTheSignInLink`,
`TestCursorMacSignInSavesUnderHome`, `TestCursorInstall*`), DSH Linux-path tests,
or unrelated long Unix socket paths. The full macOS suite is not claimed.

## Linux regression verification

`bgj_f4550f91fb81` passes `cd src/runner-go && go test -timeout 45m ./...`
on Linux x64, using the committed source mounted into Docker, Go 1.26.10 and
Git 2.47.3 (`golang:1.26-trixie`). The full runner package took 2402.492 seconds.
Docker uses `--init` to reap process-lifecycle test children, `--privileged` for
bubblewrap, and `TMPDIR=/t` to keep test Unix socket addresses short.
The final Linux sandbox/shell regression selection also passes in
`bgj_c28e7c7a3a70` on native Linux ARM64 with real bubblewrap confinement.

The earlier full-suite attempt `bgj_fe488bdb1e9f` used Go 1.23 and Linux ARM64:
it failed Go-1.24-required file previews/uploads, x64-only installer tests,
Git timestamp expectations and long socket paths. Those tests were not changed
or excluded; the full x64 run above passes. Two still earlier runs without an
init reaper were stopped after accumulating zombies. None of those attempts is
cited as a passing full-suite check.
