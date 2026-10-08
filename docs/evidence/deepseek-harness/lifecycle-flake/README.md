# TestDshLifecycleCrashRestartRecovery under load (2026-10-07)

Task 34bR1qjfX1PYfQ4SPNcsg. Base: main f5074d76e (the session branch was fast-forwarded to de0838eb7 before finishing;
nothing under `src/runner-go` changed in between).

## Symptom

HPC merge checks went red on both subtests, while every run on an idle host passed:

```
--- FAIL: TestDshLifecycleCrashRestartRecovery/runtime-id-never-reported (20.05s)
    dsh_lifecycle_test.go:1275: turn t1 never settled: {ID:t1 Kind:message Content:m1 [effect-hang] ... Status:IN_FLIGHT Deliveries:2 expired:false Completions:[]}
--- FAIL: TestDshLifecycleCrashRestartRecovery/runner-killed-mid-tool (20.06s)
    dsh_lifecycle_test.go:1275: turn t2 never settled: {ID:t2 Kind:message Content:m2 [effect-hang] ... Status:IN_FLIGHT Deliveries:2 expired:false Completions:[]}
```

The first is from promotion candidate mjjwgUCBrn735uFjrf7Bq (check 2) of project 34ZurCP3bv9yLXGVyUGnx. The second is from a
landing on project/34b7qmu7w992fd5pVBHYW (~07:06 +08:00), which the coordinator reported during this task. Two P7 Go
reds on 2026-10-06 (about 236–240 s) printed no test name, so their logs cannot settle which case failed. The races
below fail exactly that way under load. Line numbers in this document are those of the base file unless marked otherwise.

## Reproduction before the fix

Binaries were built once from `src/runner-go` at the base, with every `ORBIT_*` variable unset:
`go test -c -o base.test .` and `go test -race -c -o base-race.test .`. Each condition pins the test binary and N busy
loops to the same CPUs. The runner and engine helper processes the test spawns inherit the affinity.

```
unset $(env | grep -o '^ORBIT_[A-Z0-9_]*'); cd src/runner-go
for i in 1 2 3 4; do taskset -c 0,1 sh -c 'while :; do :; done' & done      # 4 busy loops on CPUs 0-1
GOMAXPROCS=2 taskset -c 0,1 /path/to/base.test -test.run '^TestDshLifecycleCrashRestartRecovery$' -test.count=100 -test.v
kill %1 %2 %3 %4
```

Failures were counted from the `--- FAIL` lines of the `-test.v` output. The host was HPC (24 CPUs) shared with other
sessions, at load average 23–70. Up to six conditions ran at once, each on its own CPUs.

| Condition (base f5074d76e) | Runs | Failed runs | Failure lines |
|---|---|---|---|
| no added load, `-count=20` | 20 | 0 | — |
| 2 CPUs + 4 busy loops, `GOMAXPROCS=2`, `-count=100` | 100 | **22** | 1275 "never settled" ×25, 1268 "ledger must hold … open tool" ×3 (runner-killed-mid-tool 14, runtime-id-never-reported 14) |
| 1 CPU + 2 busy loops, `GOMAXPROCS=1`, `-count=100` | 100 | **26** | 1275 ×35, 1268 ×1 (runner-killed-mid-tool 18, runtime-id-never-reported 18) |
| `-race`, unpinned, `-count=100` | 100 | **4** | 1268 ×4 |
| whole `^TestDshLifecycle` family, 2 CPUs + 4 busy loops, `-count=15` (180 top-level tests) | 180 | **9** | CrashRestartRecovery 1275 ×3 / 1268 ×1; LateEvents/lost-completion-is-reported-again 1404 "t1 never settled" ×3; ShutdownAndResume 1441 "t3 never settled" ×1; CredentialReload 1478 "t2 never settled" ×1 |
| whole family with `-race`, 2 CPUs + 4 busy loops, `-count=15` | 180 | **9** | LateEvents/lost-completion-is-reported-again 1404 ×3; ShutdownAndResume 1441 ×2; CredentialReload 1478 ×1; LeaseLoss 1332 "open …/child.pid" ×3 |
| `^TestDshLifecycleLeaseLoss$`, 2 CPUs + 4 busy loops, `-count=200` | 200 | **10** | 1332 "open …/child.pid" ×9, 1342 "tool child (0) survived the lease" ×1 |

A failed run costs about 20 s, which is `waitSettled`'s deadline. That is why the 2-CPU round took 531 s against 45 s after the fix.

## Root cause

All of these are races in the test harness, not in the runner. The runner's recovery path did what it should in every
failing run (see "The recovery path" below). There are three separate races.

### 1. The redelivery went to the dead runner's held long-poll (line 1275, both subtests)

The test's fake control plane (`lcControlPlane`) holds each `/inbox` poll for up to 150 ms. A held poll wakes on
`cp.changed`, on a 20 ms tick, or when its request context ends, and `next()` hands a turn to the first poll that asks.
The runner always has one poll outstanding (`dsh_acp.go` poll goroutine). So when `crash()` SIGKILLs the runner, the
fake server is usually still holding that runner's last poll. Go's `net/http` cancels the handler's context only after
the connection's background read has seen the EOF, and under CPU starvation that lags. `recoverAndContinue` starts the
new runner and immediately calls `redeliver`. Its `notify()` wakes the held handler directly through the channel, the
handler calls `next()`, and the turn is written to a socket nobody reads. The fake has no lease expiry, so the turn is
never offered again: `Deliveries:2 expired:false`, still `IN_FLIGHT`, no completion, and a timeout after 20 s.

Instrumented run (a copy of the test that tags each server connection and logs every hand-out, 2 CPUs + 4 busy loops,
`-count=30`): 7 runs failed. All 9 lost redeliveries went to a connection opened before the kill, at a point where the
server still saw that request as live (`ctxErr=<nil>`). That was 0.8–27.6 ms after the SIGKILL. The new runner's
first poll arrived only afterwards. One of them:

```
 82.8ms conn c19 open                     (the first runner's inbox poll)
 83.2ms deliver t1 to c19
 93.6ms kill runner
 95.5ms runner reaped
105.9ms orphaned engine gone
106.0ms start new runner
106.0ms redeliver t1
106.0ms deliver t1 to c19 ctxErr=<nil>    <- the dead runner's held poll takes it
106.3ms conn c19 closed
145.0ms conn c20 open                     (the new runner's first poll: nothing left for it)
turn t1 never settled: {... Status:IN_FLIGHT Deliveries:2 expired:false Completions:[]}
engine methods: initialize session/new session/prompt initialize session/resume
```

Production cannot do this. The fake left out runner-api's lease-generation fence:

- `session.go` makes a fresh inbox lease generation for every engine process (`newLeaseGeneration`, l. 998) and
  activates it (`activateTurnLeases`, l. 1025) before `runSessionProcess` (l. 1128).
- `activate-leases` (`runner-api.controller.ts` l. 2819) makes that generation current. It also expires the leases
  of `IN_FLIGHT` message/shell turns held by any other generation, which is the redelivery the test stands in for.
- `dequeueTurn` (l. 3233) answers a poll whose generation is no longer current with
  `409 inbox lease generation is no longer current` (l. 3290). Anything handed to a dead request is re-leased after
  `INBOX_LEASE_MS` (5 min).

The fake gave every runner the same `lc-generation` and had neither the fence nor the expiry. The same hole explains
the other "never settled" reds seen on HPC. In `lost-completion-is-reported-again` (1404) the redelivery, and in
`ShutdownAndResume` (1441) and `CredentialReload` (1478) the next queued turn, was taken by the previous session
loop's held poll. That loop had stopped in-process, so its client closed the connection, but the server had not
noticed yet.

### 2. The kill could precede the runner's ledger record of the open tool (line 1268)

`crash()` killed the runner as soon as the synthetic engine noted `effect-hang`. That note is written after the
engine sends `tool_call`. The runner records the open tool in its ledger only when its ACP reader processes that line,
and under load the kill can come first. The ledger then holds `{State:prompted OpenTools:[]}`.

This is not a product gap. `dsh_events.go` records the tool in the ledger (`onTool`, l. 162) before it emits
`tool_use` (l. 175), so every tool a transcript shows is one that recovery closes. A runner killed before then had shown
no tool.

### 3. LeaseLoss read the child's pid and the ledger too early

`TestDshLifecycleLeaseLoss` read `child.pid` as soon as the child had ticked. The synthetic engine writes the pid only
after `child.Start()` returns: 9× "no such file", plus 1× an empty file whose pid parsed as 0, and `kill(0, 0)` then
reads as "survived the lease". The engine also opens the tool (`tool_call`) after writing the pid. With the pid wait
alone, the lease could still be lost before the runner recorded the open tool. That is race 2 again, and it showed as
`lease loss must leave the prompted record …: {State:prompted OpenTools:[]}` 3 times in 200 runs.

## The recovery path (checked, unchanged)

- **A turn the ledger says was prompted.** `start` finds it with `ledger.get` (`dsh_acp.go` l. 772) and goes to
  `recoverTurn` (l. 739). That closes each recorded open tool with a failed `tool_result`, emits one `error` and one
  `turn_end` (`recovered`), records the settlement in the ledger, and completes the turn once as `INTERRUPTED`
  ("… not replayed …"). It sends no `session/prompt`.
- **Redelivery versus readiness.** The runner polls only after initialize, resume and configure. A turn queued before
  that waits in Orbit's queue. The new runner never saw the turn in the failing runs: it had been consumed before its
  first poll arrived (c20 above).
- **No runtime id from Orbit.** The id comes from the retained ledger (`runtimeID = ledger.RuntimeSessionID`, l. 570).
  The failing runs show `initialize, session/resume` on the second engine, so the right session was resumed.
- **A dropped settlement.** None was attempted, because the turn never reached the runner. When a completion is lost,
  the ledger's settled record is reported again on the next delivery (`LateEvents/lost-completion-is-reported-again`).

No runner code changed.

## Change (`src/runner-go/dsh_lifecycle_test.go` only)

- `lcControlPlane.activate()` makes a new lease generation current, as `activate-leases` does. `startIn` activates one
  per in-process session loop. `startRunnerProcess` activates one for the runner helper process, which reads it from
  `DSH_LC_GENERATION`. `next(generation)` refuses any other generation with 409, as `dequeueTurn` does. A held poll
  from a stopped or killed loop can no longer take a turn meant for its successor.
- `crash()` waits for the engine's side-effect note **and** the runner's ledger record of the open tool before the
  SIGKILL. That record is what the next runner recovers from.
- `TestDshLifecycleLeaseLoss` waits for the ticks, a parsed child pid **and** the ledger's open tool before the lease
  is lost.

No timeout or hold time changed: `lcWaitFor`/`waitSettled` still wait 20 s and the fake still holds a poll 150 ms. No
assertion was weakened. A recovered turn still needs exactly one `INTERRUPTED` completion containing "not replayed",
one `tool_result`, one `turn_end` and no `user` event. The engine prompts must still be exactly
`[m1 [effect-hang], after-restart]` (or `[m1, m2 [effect-hang], after-restart]`), the side effects exactly `[m1]`
(`[m2]`), one `session/new` plus one `session/resume`, and `checkClean` must find no double or out-of-lease settlement.

The same instrumented copy, run on the fixed test, shows the fence turning the dead poll away. The dead runner's
held poll still wakes on the redelivery while the server sees it as live, but it now gets the 409:

```
 54.9ms kill runner
 55.5ms runner reaped
 55.6ms activate lc-generation-2
 55.6ms redeliver t1
 55.6ms refuse 409 to c4 gen=lc-generation-1 ctxErr=<nil>   <- the dead runner's held poll
 69.5ms conn c5 open
 69.7ms deliver t1 to c5 gen=lc-generation-2                 <- the new runner
--- PASS
```

## After the fix (same conditions)

These use the same busy-loop counts, CPU pins and `GOMAXPROCS` as the baseline, with binaries built from the fixed
test. They ran concurrently with each other on the same shared host, at load average 30–60.

| Condition (fixed test) | Runs | Failed runs | Before |
|---|---|---|---|
| 2 CPUs + 4 busy loops, `GOMAXPROCS=2`, `-count=100` | 100 | **0** (45 s) | 22 (531 s) |
| 1 CPU + 2 busy loops, `GOMAXPROCS=1`, `-count=100` | 100 | **0** (53 s) | 26 (732 s) |
| `-race`, unpinned, `-count=100` | 100 | **0** | 4 |
| whole `^TestDshLifecycle` family, 2 CPUs + 4 busy loops, `-count=40` (480 top-level tests) | 480 | **0** | 9 of 180 |
| whole family with `-race`, 2 CPUs + 4 busy loops, `-count=15` | 180 | **0** | 9 of 180 |
| `^TestDshLifecycleLeaseLoss$`, 2 CPUs + 4 busy loops, `-count=200` | 200 | **0** | 10 |

Two intermediate builds led to the final LeaseLoss wait:

- Fence and `crash()` wait only. The crash test passed 100/100 under both pinned conditions and under `-race`, but
  one whole-family run of 15 still failed LeaseLoss on `child.pid`.
- Plus the pid wait. The family went 0/480 and 0/180 under `-race`, but LeaseLoss alone went 3/200 on
  `OpenTools:[]`, the second half of race 3.

## Acceptance

The task's command, run on the final tree (de0838eb7 plus this change) on 2026-10-06 at 23:21Z, after the stress runs
had finished, with other sessions keeping the host at load average about 30–40:

```
unset $(env | grep -o '^ORBIT_[A-Z0-9_]*'); cd src/runner-go && go test -count=30 -run '^TestDshLifecycleCrashRestartRecovery$' . && go test -count=1 -race -run '^TestDshLifecycle' . && go test -count=1 ./...
ok  	orbit	4.143s
ok  	orbit	6.251s
ok  	orbit	400.938s
?   	orbit/cmd/release-manifest	[no test files]
```

Exit code 0.
