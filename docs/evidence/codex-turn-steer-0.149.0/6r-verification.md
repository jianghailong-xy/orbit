# [6R] Codex steer independent verification

Verdict: **PASS**

Verified on 2026-08-22 (Europe/Berlin) from a new Codex session and a new worktree. The page/API
smokes, end-of-turn races, refusal paths, and a deliberately crashed/restarted disposable Runner
all met the no-loss/no-duplicate contract.

## Isolation and source audit

- Replacement task: `34BEfL5U6hHQ9Y008GiuL`
- New Codex session: `2Yt6gCEm62TJMhZ5KjlroI`
- New worktree: `/root/.orbit/worktrees/5433f966-7619-4184-9740-215cc7734e9a`
- Branch: `orbit/6r-codex-session-smoke-08e1dd`
- Latest-main baseline: `9b814afd0cda48d434c6ee4bb99df26865923c83`
- The prohibited old session `1GbK8MVDGD11HKyr1VRhMP` was only read. It remains `FAILED`,
  `numTurns=2`; its task `34ApwaUcw2xRtSWSPWTZk` remains `FAILED`.

The old evidence worktree was inspected before migration:

```text
worktree: /root/.orbit/worktrees/29a7b354-fb9c-4327-9ded-f3285fb15651
branch:   orbit/6-7-codex-tool-smoke-799f14
HEAD:     dc9ab8731c01ce480a29d742c389a5d3e419ac22

 M src/runner-go/codex_appserver.go
 M src/runner-go/codex_steer.go
 M src/runner-go/codex_steer_test.go
?? docs/evidence/codex-turn-steer-0.149.0/api-smoke.mjs
?? docs/evidence/codex-turn-steer-0.149.0/page-smoke.mjs

tracked dirty diff: 3 files, +35/-4
```

The old smoke scripts only printed partial summaries; they did not assert the Codex item count or
perform `thread/read`, so they were not copied wholesale. The tracked dirty change identified a
real distinction between `item/started` + `item/completed` for one item and two different item
IDs. That idea was independently reimplemented with a stronger regression test.

The reviewed implementation chain was selectively replayed onto the latest main, in order:

```text
d1ce6d15 docs(codex): freeze what turn/steer actually does before building on it
7975a642 feat(codex): write a mid-turn message into the turn codex is already running
1bbd0439 Merge codex steer delivery with its control-plane gate
d8a3f24f feat(codex): answer for a mid-turn message the engine could not take
4ec8dc66 test(codex): pin what a steer looks like on every door, in codex's event order
f14e1001 fix runner steer requeue retry race
ff11a46b fix(codex): distinguish item lifecycle from duplicate steer
```

There were no content conflicts. This is a selective integration, not a copy of the old branch or
dirty worktree.

## Environment

```text
host Node:       v22.22.2 (npm 10.9.7)
test Node:       v26.7.0 (node:26-bookworm; repository requires Node >=26)
Go:              go1.24.4 linux/amd64
Codex CLI:       0.149.0
Chromium:        151.0.7922.169, Debian 13
Docker:          29.5.2
Swift:           6.1.3, x86_64-unknown-linux-gnu
main baseline:   9b814afd0cda48d434c6ee4bb99df26865923c83
```

## Real page and API smokes

The current source was built as a disposable `dev` Runner and registered as
`codex-steer-6r-home` (`34BF8asmUn8pU0ifbNPDH`) with workspace
`34BF8rRXZjp6hA72HLpr8`. Its heartbeat declared `session-codex-steer-v1`. The existing `wikova`
Runner and the task's own Runner were not restarted.

### API duplicate-idempotency smoke

Command:

```bash
ORBIT_SMOKE_OWNER_PUBLIC_ID=2p7QMFOwEGtL5oaTxZHihm \
ORBIT_SMOKE_WORKSPACE=34BF8rRXZjp6hA72HLpr8 \
node docs/evidence/codex-turn-steer-0.149.0/api-smoke.mjs
```

Key result:

```text
sessionId=34BFPKmK5pPYwdlPOwiuT
initialOrbitTurnId=34BFPKrsbJkLYOfHVBZ3C
steerOrbitTurnId=34BFPcTGratucYffQklTW
clientTurnId=033ff15c-3811-442b-a022-6747ec290bd8
firstKind=steer; duplicateKind=steer; duplicateSameOrbitTurn=true
runtimeThreadId=01a02698-13cb-7640-b077-1f68d51f071a
codexTurnId=01a02698-1587-7bf1-bd19-d4654949238a
steerItemId=item-3
userMessageItemsInTurn=2
delivery=written,written,acknowledged
numTurns=1; status=AWAITING_INPUT
finalAnswer=API_STEER_APPLIED_3154ad84
```

The two `written` entries are one visible `user` bubble plus its `user_delivery` state, not two
messages. The script asserts one bubble, one durable Orbit steer row, one Codex steer item, two
total `userMessage` items in the same Codex turn, and the exact final answer.

### Real browser smoke

Chromium drove the rendered textarea and clicked the actual `Send` button; CDP only observed the
network response and rendered result.

```text
sessionId=34BFQN291pGDs8o9oRgPV
initialOrbitTurnId=34BFQN8HZQVqhuBorRtRW
steerOrbitTurnId=34BFQitVNBM3OofJ7dyvp
networkStatus=201; networkKind=steer; clicked=true
runtimeThreadId=01a02698-b44e-7922-a553-550f89898972
codexTurnId=01a02698-b681-74b1-a999-fcb6935f5864
steerItemId=item-3
userMessageItemsInTurn=2
delivery=written,written,acknowledged
numTurns=1; status=AWAITING_INPUT
finalAnswer=PAGE_STEER_APPLIED_348a60ff
finalAnswerPresent=true; composerValue=""
```

## Turn-end and refusal races

`probe.mjs --live` drove a real Codex 0.149.0 app-server thread
`01a026ab-0088-7520-8d59-26fff80bdfc7`:

```text
delay=0ms     ACCEPTED, echoed=true,  turnStatus=completed
delay=1200ms  ACCEPTED, echoed=true,  turnStatus=completed
delay=2500ms  ACCEPTED, echoed=true,  turnStatus=completed
delay=4000ms  REJECTED no active turn to steer, echoed=false, turnStatus=completed
```

Thus both sides of the end race are observed: an accepted steer is echoed exactly once into the
active turn; once completion wins, Codex rejects before reading and emits no item. Interrupt won
another race: the post-interrupt steer was rejected with `no active turn to steer`, and only the
opening message was echoed.

The same live probe confirmed exact refusal shapes for no active turn, missing
`expectedTurnId`, invalid thread ID, and unknown method. The direct app-server duplicate probe
echoed the same `clientUserMessageId=A2` twice, independently confirming that Codex itself is not
idempotent and the Orbit API's durable duplicate collapse is required.

## Disposable Runner crash and restart

The test paused only the Codex child for smoke session `34BFf3nRgMFWFa2hnzhJT`, posted steer
`34BFgCc32O1d4JmZt9Ci0`, and polled its internal row
`01a026a2-35ea-7fa2-9c95-cef14cd44920`. On the first poll it was `IN_FLIGHT`; the disposable
Runner's isolated process session (`SID 829632`) was then killed. No main/current-task process was
in that SID.

After restarting the same disposable Runner, activation logged:

```text
answering for a steer stranded by a previous process on
01a026a1-85f9-7d12-800a-5d6185b65aab: 01a026a2-35ea-7fa2-9c95-cef14cd44920
```

Strict verification result:

```text
delivery=failed,failed
userBubbles=1
failureReports=1
acknowledged=0
queuedCopies=0
codexCopies=0
reason=the runner stopped while this message was on its way into the running turn,
       so whether the engine read it is unknown; send it again if it was not acted on
```

After the restart, the original long turn naturally finished and the session reached
`AWAITING_INPUT`, `numTurns=1`. A separate pause-without-crash sample reached `E-TIMEOUT` and also
settled once without requeueing an ambiguous outcome. All nine disposable-workspace smoke
sessions were `AWAITING_INPUT` before the Runner was gracefully drained with `SIGTERM`. No session
complete/end/cancel operation was used. The stopped Runner/workspace rows and its `/tmp` evidence
directory were retained for audit.

## Automated tests

```text
cd src/runner-go && go test -count=1 -timeout 900s ./...
  PASS: ok orbit 122.583s

cd src/runner-go && go test -count=1 -race -timeout 300s \
  -run '<Codex steer/recovery/refusal/turn-ending matrix>' -v .
  PASS: ok orbit 58.193s

ORBIT_TEST_PG_URL=<isolated-db> node --test build/runner-api/steer-dequeue.pg.spec.js
  PASS: 16/16, 0 skipped, real PostgreSQL

npm test -w @orbit/apiserver  (Node 26 container)
  PASS: 2363 total, 2112 pass, 0 fail, 251 expected external-DB skips

npm test -w @orbit/shared -w @orbit/web  (Node 26 container)
  PASS: shared 13 files / 147 tests; web 60 files / 850 tests

swift test  (swift:6.1 container, src/macos/OrbitKit)
  PASS: 639 tests, 5 skipped, 0 failures
```

The PostgreSQL database and role `orbit_6r_steer_5433f966` were created only for the predicate
test and dropped immediately afterwards.

## Reverse fault injection

Two guards were deliberately broken, and each focused test failed for the intended reason before
the source was restored:

1. Treating the same item's `item/started` and `item/completed` notifications as two echoes made
   `TestCodexSteerLifecyclePairIsOneEchoButTwoItemIDsAreDuplicates` fail. Restoring the item-ID
   comparison passed the test.
2. Marking the default `E-UNKNOWN` refusal as `requeue:true` made
   `TestASteerWithAnUnknownOutcomeIsReportedRatherThanRefiled` fail: it observed a succeeded
   `steer_requeue`, no failure reason, and no user bubble. Restoring fail-closed classification
   passed the test.

These mutations prove that the tests detect both duplicate item accounting and unsafe replay of
an ambiguous delivery; they are not green merely because the happy path ran.

## Final assessment

PASS. Page and API both write into the current Codex turn; API retries are idempotent before they
reach non-idempotent Codex; completion races either deliver once or reject before reading; and a
Runner death after lease reports one actionable failure without silently losing, acknowledging,
or replaying the message. No product blocker remains for the release task.
