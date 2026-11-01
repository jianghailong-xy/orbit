# Long-running loops on a real stack: two hours, two runner kills, a 7200-second sleep

Task E (`34pUg8bFJa05bqidVAn8u`) of project `34pUaJboWdDFzjftkEso8`, criterion `1bazyCR6I5wOnbxERJ8lQC` (a durable
loop), with the real-stack parts of `AZPGg68ZXsS4KAHBgkg7U` (stall), `Uzbq1wSQeoEDqcytKIGC3` (scheduling truth) and
`10W5Z7lLqXuvonoSJ8z7WG` (the signal). Contract: [`docs/long-running-loop-contract.md`](../../long-running-loop-contract.md).

- **When:** 2026-10-31, 21:07:29Z to 23:23:32Z, on HPC (runner `workstation-gpu`). All times below are UTC.
- **Code:** product source `1031a2052` (the project line's tip). Drill scripts `scripts/long-running-loops/` and the
  `fake-model.py` triggers in `724afa777`; `verdicts.py` and this directory in the commit after it.
- **bg_run jobs (this task's session):** the run `bgj_765e838922a9` (`run-drill.sh start && run-drill.sh wait`, exit 0);
  the fresh stack and its setup `bgj_a92a6610e830`; the build `bgj_559f7b9a1c58`; the smoke pass that checked the drill
  `bgj_12e84eefbbf8`; milestone watchers `bgj_e4b8abf121ab` and `bgj_5ff265c236b7`.
- **Verdict:** 18 of 18 checks pass ([`verdicts.json`](verdicts.json), `python3 scripts/long-running-loops/verdicts.py`
  over the dump). Two product problems found, one of them small; see [Findings](#findings-for-the-coordinator).

## The stack

Everything that decides a tick is the product, unmodified: PostgreSQL 16 in a container with every migration to 0460,
one apiserver process of this checkout (pid 3020495, with its `ScheduledWakeupWorker`, reaper and `AutoRetry`), six
runners of this checkout (`orbit run`, version `lrl-drill-1031a2052b63`), and Claude Code 2.1.316 as the engine, spawned
by the runner with Orbit's own argv, settings, hooks and MCP server. The agent's tool calls (`schedule_wakeup`,
`bg_run`, `session_get`) go through Claude Code to `orbit mcp` to the runner to the control plane, as in production.

- **Not real:** the model. `scripts/managed-runner/lab/fake-model.py` answers from a script written in the message
  (`FAKE-RECUR`, `FAKE-STALL`, `FAKE-STOP`, `FAKE-GET`, `FAKE-SLOW`); it is not a model. Claude Code defers MCP tools,
  so the stand-in loads each tool with `ToolSearch` (`select:<tool>`) before calling it, as a model has to.
- **Approvals:** each engine's user settings (`HOME/.claude/settings.json`) allow `mcp__orbit__schedule_wakeup` and
  `mcp__orbit__session_get`, as a person who had allowed them would; `bg_run` is allowed by the runner's own bg-guard
  hook. No approval card was involved.
- **Isolation:** loopback only (ports 15733, 13910, 13912), its own database, the runners' `config.json` naming the
  isolated server. Nothing talked to orbitd.io. Runner units take `KillMode=mixed` from the host's
  `orbit-runner-root.service`, so a SIGKILL to a runner's main pid ends what it left in its cgroup, as a real runner
  death does. No `Restart=`: a killed runner stays down until the drill starts it again.
- **Six runners:** `a` holds loop A, `b` loop B, `c` the observer session C and is never killed, and `f1`–`f3` only
  heartbeat. One runner's death is then 1 of 6 runners heard (17%), under the reaper's mass-disconnection share (a
  fifth), as on a production control plane. With two or three runners, one death reads as a mass disconnection and the
  reaper holds the session about ten minutes longer.
- **Push record:** the apiserver runs with `NODE_OPTIONS=--require …/loopback-only.cjs --require
  …/scripts/long-running-loops/push-recorder.cjs`. The preload wraps `PushService.prototype.notifyLoopMissed` when
  `dist/push/push.service.js` loads and appends every call (arguments, receiver, settlement) to `push-calls.jsonl`
  before calling the original. The stack configures neither APNs nor FCM, so the original returns at its first line
  (`if (!this.enabled) return`); the record shows that the worker's injected PushService was called, and with what.

## Timeline

| time | what happened |
| --- | --- |
| 21:07:07.1 | the apiserver (pid 3020495) loads `push.service.js`; the recorder wraps it (`push-calls.jsonl` line 1) |
| 21:07:29.5 | session A on runner a. Its opening turn calls `schedule_wakeup({recurring: true, everySeconds: 300, delaySeconds: 150, until: 01:07:30Z, prompt, reason})` (loop `01a193c9-fa78-…`) and `bg_run({command: 'sleep 7200', kind: 'job', wakeOnStall: {afterSeconds: 1800}})` (job `bgj_9ad4f310ca2d`) |
| 21:07:59.5 | session C on runner c: the same sleep job, `bgj_4c86a2f98e3b` |
| 21:09:29.5 | session B on runner b: a loop every 60 s whose tick turns hold their answer 30 s |
| 21:10:00.0 | loop A, tick 1; a tick every 300 s from here |
| 21:17:38.9 | **runner b SIGKILL**, 5.4 s into tick 8's turn (turn 9 `IN_FLIGHT` since 21:17:33.4) |
| 21:19:07.7 | the reaper fails B (`runner offline`); auto-retry armed |
| 21:33:30.1 | push: loop B, 16 ticks, `RUNNER_OFFLINE` |
| 21:37:30.2 | stall wake of `bgj_9ad4f310ca2d` (A), 1800 s in |
| 21:37:39.6 | C's agent calls `session_get` on B (`session-get-B1.txt`) |
| 21:37:59.9 | stall wake of `bgj_4c86a2f98e3b` (C), 1800 s in |
| 21:49:07 | auto-retry disarmed: `runner never came back` (30 min after the reap) |
| 21:49:31 – 21:52:31 | ticks 40–43 cannot revive B: `the runner is offline` |
| 21:52:32.1 | runner b started again: down 2093 s |
| 21:53:32.9 | tick 44 revives B by itself; its turn goes to a new engine |
| 21:55:32.3 | `session_get` on B (`session-get-B2.txt`) |
| 21:58:32.3 | `stop: true` twice on B |
| 22:12:30.3 | **runner a SIGKILL**, session A idle, halfway between ticks 13 and 14 |
| 22:25:02.4 | push: loop A, 3 ticks, `RUNNER_OFFLINE` |
| 22:33:30.9 | C's agent calls `session_get` on A, 21 min into the outage (`session-get-A1.txt`) |
| 22:37:30.8 | runner a started again: down 1500 s |
| 22:37:31.4 | the turn queued in the outage (ticks 14–18) goes to a new engine |
| 22:40:03.2 | tick 19, the first slot after the restart, on time |
| 22:42:30.8 | `session_get` on A (`session-get-A2.txt`) |
| 23:07:30.2 | `stop: true` twice on A |
| 23:07:59.9 | `bgj_4c86a2f98e3b` exits 0 after 7200 s |
| 23:23:32.4 | end of the 16 minutes watched after the stop |

## 1. A loop the server holds: two hours, its runner killed once while idle

Loop A was created at 21:07:30.04 and stopped at 23:07:30.36, two hours, with 24 due times (21:10:00 to 23:05:00) and
the 25th cancelled by the stop. Every slot outside the outage became a turn of its own, handed to the engine
(`conversation_turn.delivered_at`) 0.2–4.9 s after it was due. The five slots of the outage were filed onto one
queued turn and handed over 0.6 s after the runner was back. The first slot after the restart fired 3.2 s after it was
due. [`ticks-a.md`](ticks-a.md) has every row; joined from `session_scheduled_wakeup` and `conversation_turn`:

| tick | due_at | state | turn | delivered_at | delivered − due | runner a |
| ---: | --- | --- | ---: | --- | ---: | --- |
| 1 | 21:10:00.038 | DELIVERED | 2 | 21:10:02.841 | 2.8 s | up |
| 2 | 21:15:00.038 | DELIVERED | 3 | 21:15:03.164 | 3.1 s | up |
| 3 | 21:20:00.038 | DELIVERED | 4 | 21:20:03.586 | 3.5 s | up |
| 4 | 21:25:00.038 | DELIVERED | 5 | 21:25:03.950 | 3.9 s | up |
| 5 | 21:30:00.038 | DELIVERED | 6 | 21:30:04.937 | 4.9 s | up |
| 6 | 21:35:00.038 | DELIVERED | 7 | 21:35:00.234 | 0.2 s | up |
| 7 | 21:40:00.038 | DELIVERED | 9 | 21:40:00.479 | 0.4 s | up |
| 8 | 21:45:00.038 | DELIVERED | 10 | 21:45:01.049 | 1.0 s | up |
| 9 | 21:50:00.038 | DELIVERED | 11 | 21:50:01.713 | 1.7 s | up |
| 10 | 21:55:00.038 | DELIVERED | 12 | 21:55:04.595 | 4.6 s | up |
| 11 | 22:00:00.038 | DELIVERED | 13 | 22:00:00.658 | 0.6 s | up |
| 12 | 22:05:00.038 | DELIVERED | 14 | 22:05:01.328 | 1.3 s | up |
| 13 | 22:10:00.038 | DELIVERED | 15 | 22:10:01.540 | 1.5 s | up |
| 14 | 22:15:00.038 | DELIVERED | 16 | 22:37:31.440 | 1351.4 s | **down** |
| 15 | 22:20:00.038 | DELIVERED | 16 | 22:37:31.440 | 1051.4 s | **down** |
| 16 | 22:25:00.038 | DELIVERED | 16 | 22:37:31.440 | 751.4 s | **down** |
| 17 | 22:30:00.038 | DELIVERED | 16 | 22:37:31.440 | 451.4 s | **down** |
| 18 | 22:35:00.038 | DELIVERED | 16 | 22:37:31.440 | 151.4 s | **down** |
| 19 | 22:40:00.038 | DELIVERED | 17 | 22:40:03.213 | 3.2 s | up again |
| 20 | 22:45:00.038 | DELIVERED | 18 | 22:45:03.413 | 3.4 s | up |
| 21 | 22:50:00.038 | DELIVERED | 19 | 22:50:03.585 | 3.5 s | up |
| 22 | 22:55:00.038 | DELIVERED | 20 | 22:55:03.842 | 3.8 s | up |
| 23 | 23:00:00.038 | DELIVERED | 21 | 23:00:04.026 | 4.0 s | up |
| 24 | 23:05:00.038 | DELIVERED | 22 | 23:05:04.831 | 4.8 s | up |
| 25 | 23:10:00.038 | CANCELLED | — | — | — | (stopped) |

So the two hours made 20 tick turns: 19 slots on time, and one turn for the five slots of the outage. With the opening
turn, the stall wake (turn 8) and the stop turn, session A has 23 turns ([`raw/turns-a.json`](raw/turns-a.json)).
Between ticks the session was idle (`AWAITING_INPUT`); the kill checked it first: `AWAITING_INPUT`, no open turn. The
kill recycled the engine: Claude Code pid 3034348 (started 21:07:28) died with the runner; the queued turn went to pid
4045054, started 22:37:30 by the new runner, which resumed the conversation (its first request carried 40 messages).
Runner a's last heartbeat before the kill was 22:12:10.3 and its next 22:37:33.6
([`raw/sample-transitions.jsonl`](raw/sample-transitions.jsonl)).

## 2. While runner a was down: session_get, the push, and the turn after

**session_get**, called by session C's agent through the real `mcp__orbit__session_get` at 22:33:30.9, 21.0 minutes
into the outage ([`session-get-A1.txt`](session-get-A1.txt) is the tool's result as the engine got it):

```json
"status": "PENDING",
"wakeups": { "next": { "dueAt": "2026-10-31T22:35:00.038Z", "kind": "LOOP_TICK", "reason": "LRL drill loop A" },
  "lastFiredAt": "2026-10-31T22:10:01.541Z",
  "loop": { "state": "ACTIVE", "everySeconds": 300, "until": "2026-11-01T01:07:30.000Z",
    "nextDueAt": "2026-10-31T22:35:00.038Z", "lastFiredAt": "2026-10-31T22:10:01.541Z",
    "ticksFired": 14, "ticksMissed": 3, "endedReason": null, "endedAt": null } }
```

In 21 minutes four slots came due (22:15, 22:20, 22:25, 22:30). The first filed the turn that waits for the runner
(fired, as contract §3 counts it), the other three were folded into it (missed): 14 fired = ticks 1–14, 3 missed.
`lastFiredAt` is tick 13's delivery, the last run before the kill, and the next tick is 22:35. After the restart
([`session-get-A2.txt`](session-get-A2.txt), 22:42:30.8): `AWAITING_INPUT`, `lastFiredAt` 22:40:03.214 (tick 19),
15 fired, 4 missed.

**The push** ([`push-calls.jsonl`](push-calls.jsonl), call 2): at 22:25:02.363, `notifyLoopMissed({sessionId: A,
missed: {loopId: loop A, ticks: 3, alertedAt: 22:25:02.337}, reason: 'RUNNER_OFFLINE'})`, on an instance of
PushService (`enabled: false`). That is 15 min 0.8 s after the last run (22:10:01.541), at the third slot without a run
(ticks 14–16), 12.5 minutes into the outage, with the runner silent. It was the only call for loop A, and its
`alerted_at` was cleared at tick 19 (22:40), the first due tick after the run.

**The turn after**, as Claude Code sent it to the model ([`wake-blocks.md`](wake-blocks.md), request 51):

```text
<scheduled-wakeup>
  A tick of the loop you started with schedule_wakeup is due; the control plane opened this turn for it:
    2026-10-31T22:30:02.702Z scheduled 297 seconds out, due 2026-10-31T22:35:00.038Z
    loop: tick 18, every 300 seconds until 2026-11-01T01:07:30.000Z; 4 ticks missed since the last run
    reason: LRL drill loop A
    what you left for this turn:
      LRL-TICK-A: a tick of the drill loop A; answer in one line.
  The control plane recorded this for you; the user did not say it. The loop goes on by itself, so do not schedule its next tick; to stop it, call mcp__orbit__schedule_wakeup with stop: true.
</scheduled-wakeup>

<background-jobs>
  Ended while you were away:
    bgj_9ad4f310ca2d｜job｜sleep 7200｜no end reported｜the runner process hosting it is gone (a restart, a self-update or a crash), so it is taken as stopped, with no exit code｜output /mnt/data/tmp/lrle/r/a/oh/runs/01a193c9-f813-708a-8cfc-ce2f4f165e80/bgj_9ad4f310ca2d.output
  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.
  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.
</background-jobs>
```

Ticks 14–18 are one entry ("tick 18"); the four before it (14–17) are missed since the last run (tick 13).

## 3. Killed in a tick's turn, back only after the auto-retry gave up (loop B)

Loop B ticks every 60 s, and each tick's answer is held open 30 s, so the kill lands in a turn. Runner b got SIGKILL
at 21:17:38.9, 5.4 s into tick 8's turn (turn 9, `IN_FLIGHT`, delivered 21:17:33.381). The fake model's held answer
lost its connection at 21:17:48 ([`raw/fake-model.jsonl`](raw/fake-model.jsonl), `disconnected`). Runner b's cgroup
(the runner, `claude`, `orbit mcp`) was empty 0.5 s later. Then ([`ticks-b.md`](ticks-b.md),
[`raw/apiserver-log.txt`](raw/apiserver-log.txt), [`raw/sample-transitions.jsonl`](raw/sample-transitions.jsonl)):

| ticks | due | what each found and did |
| --- | --- | --- |
| 1–8 | 21:10:29.9 – 21:17:29.9 | a turn of its own each, handed over 2.9–3.5 s after due (tick 8's turn is the one killed) |
| 9 | 21:18:29.9 | the session still `RUNNING` on a dead runner: filed as a queued turn (turn 10), which the reap at 21:19:07.7 settled without delivering it ([finding 1](#findings-for-the-coordinator)) |
| 10–39 | 21:19:29.9 – 21:48:29.9 | `FAILED` with the auto-retry armed: `DROPPED`, missed, the next tick written (the recovery is the retry's) |
| 40–43 | 21:49:29.9 – 21:52:29.9 | `FAILED`, retry disarmed at 21:49:07: revive with `sessions.resume`, refused (`the runner is offline; it must be online to resume this session`), missed; the revive streak stays 0 |
| 44 | 21:53:29.9 | runner b back since 21:52:32.1: the tick revives B (`bg-wake:wakeup:01a193f3-3417-…`), handed to a new engine (pid 3561722) 3.0 s after due; B `RUNNING`; revive streak 1 |
| 45–49 | 21:54:29.9 – 21:58:29.9 | a turn of its own each, 0.8–3.4 s after due; the streak back to 0 at tick 45 |
| 50 | 21:59:29.9 | `CANCELLED` by the stop at 21:58:32 |

- The reap came 88.7 s after the kill, with no mass-disconnection hold (1 of 6 runners silent).
- **Push** (call 1): 21:33:30.069, `{loopId: loop B, ticks: 16, alertedAt: 21:33:29.985, reason: 'RUNNER_OFFLINE'}`:
  15 min 56.6 s after the last run (tick 8, 21:17:33.381), ticks 9–24 without a run. Only call for loop B; its
  `alerted_at` was cleared at tick 45, the first due tick after the revive.
- **session_get** at 21:37:39.6 ([`session-get-B1.txt`](session-get-B1.txt)): `FAILED`, `lastFiredAt` 21:17:33.381,
  9 fired, 19 missed, next 21:38:29.919. After the revive ([`session-get-B2.txt`](session-get-B2.txt), 21:55:32.3):
  `RUNNING`, `lastFiredAt` 21:55:33.227, 12 fired, 34 missed.
- The auto-retry disarmed at 21:49:07 (`auto-retry of … disarmed: runner never came back`, 30 min after `finishedAt`
  21:19:07.67). Four ticks then found B `FAILED` with nothing armed, more than the three a revive streak could have
  spent, and each was refused and counted missed without spending any. Runner b came back after 2093 s, past the 30
  minutes, and nobody touched session B: the next tick brought it back, and the ticks after it ran on time. The revive
  turn's block: `loop: tick 44, every 60 seconds until 2026-10-31T23:09:29.000Z; 34 ticks missed since the last run`.

## 4. stop: true, twice; then sixteen minutes without a turn

At 23:07:30.156 session A was asked to stop. Its engine called `mcp__orbit__schedule_wakeup({stop: true})` twice in a
row; both answered without error:

1. `Stopped: no one-shot wakeup was pending; the loop has ended, and no further tick of it is scheduled.`
2. `Nothing to stop: no wakeup was pending and no loop was running.`

Loop A is `ENDED`, `REQUESTED`, at 23:07:30.36, its waiting tick 25 `CANCELLED`. In the 960 s watched after the stop
turn (to 23:23:32), session A got no turn and had no waiting wakeup (`raw/timeline.jsonl`, step `a.quiet`:
`turnsAfterStop: []`, `pendingWakeups: []`). Loop B was stopped the same way at 21:58:32, with the same two receipts.

## 5. sleep 7200 with wakeOnStall 1800

- **Session A's job** `bgj_9ad4f310ca2d` started 21:07:30.17. One stall wake, at 21:37:30.185: `elapsed_ms` and
  `idle_ms` 1 800 000 ([`raw/wakes-a.json`](raw/wakes-a.json)), turn 8 (`bg-wake:bgj_9ad4f310ca2d:stall:1`)
  delivered 21:37:30.286. The block, as the model got it ([`wake-blocks.md`](wake-blocks.md), request 26):
  `bgj_9ad4f310ca2d｜job｜sleep 7200｜…｜gone quiet｜still running｜running for 30m 0s when this was sent｜no output at
  all｜it has written nothing in the 30m 0s since it started … One silence wakes you once`. Runner a reported the job
  every minute until 22:12:29.6 (`idleMs` 3 899 452, [`raw/job-reports.tsv`](raw/job-reports.tsv)), 35 minutes of
  silence after the wake with no second one. Then the job died with its runner: the unit's cgroup held `sleep 7200`
  (pid 3034451) at the kill and was empty 0.5 s later. The new runner discarded its record (`pid 3034451 is not this
  runner's child (no child processes) — not adopted, no end report`, [`raw/runner-a.txt`](raw/runner-a.txt)), and the
  new engine was told the job had ended (section 2).
- **Session C's job** `bgj_4c86a2f98e3b`, on the runner nobody killed, ran its whole two hours: started
  21:07:59.940, one stall wake at 21:37:59.950 (`elapsed_ms` 1 800 000), 122 reports, the last `running` one at
  23:07:59.623 with `idleMs` 7 199 683, then `completed (exit code 0)` at 23:07:59.944. Exactly one wake in 7200 s
  ([`raw/wakes-c.json`](raw/wakes-c.json) has one row; [`raw/turns-c.json`](raw/turns-c.json)).

## 6. The push record

[`push-calls.jsonl`](push-calls.jsonl) is the recorder's file, whole:

| line | at | what |
| --- | --- | --- |
| 1 | 21:07:07.097 | `wrapped`: pid 3020495 (the apiserver) loaded `…/src/apiserver/dist/push/push.service.js` |
| 2 | 21:33:30.069 | call 1: session B, loop B, `ticks: 16`, `RUNNER_OFFLINE`; receiver `PushService`, `enabled: false` |
| 3 | 22:25:02.363 | call 2: session A, loop A, `ticks: 3`, `RUNNER_OFFLINE`; receiver `PushService`, `enabled: false` |

One call per outage, none after the runs came back, and none other. Each count is the number of due times without a
run up to that tick, and each reason is the runner being offline, which both were. The worker's own log lines
(`has not run for 16 ticks … its owner is told`, `… 3 ticks …`) are in [`raw/apiserver-log.txt`](raw/apiserver-log.txt)
at the same instants, but are not the evidence of a call.

## Findings for the coordinator

1. **A tick filed onto a turn that never ran is counted as fired.** Between a runner's death mid-turn and the
   reap (about 90 s), the session still reads `RUNNING`, so a tick due then is filed as a queued turn. The reap settles
   that turn without delivering it (`conversation_turn` 10 of B: `ANSWERED` at 21:19:07.704, `delivered_at` null), but
   the tick row stays `DELIVERED`. So `ticks_fired` counts it (loop B ends with 15 fired, 34 missed; 14 ticks ran and
   35 did not), session_get shows 9 fired while 8 ran, and the next block says `34 ticks missed since the last run`
   where ticks 9–43, 35 of them, never ran. The dead-man's own count is right (16 at tick 24, from the delivered tick
   8). Repeat: a loop every 60 s with ticks that last 30 s, SIGKILL the runner during a tick's turn, and read the tick
   due before the reap ([`ticks-b.md`](ticks-b.md) tick 9). The smoke pass showed it too.
2. **(Small, needs a client check.)** After runner a's restart, `GET /api/sessions/:id/background` still lists
   `bgj_9ad4f310ca2d` as `running` ([`raw/background-a.json`](raw/background-a.json)), although the job died with its
   runner and both the runner and the new engine say so. `session.running_bg_jobs` is empty. This is the
   transcript-derived list the clients merge with a live overlay; whether a client then draws the dead job as running
   was not checked.

## Limits

- The engine talks to a stand-in, not a model: what the agent "decides" is scripted in the message.
- The tools were approved by allow rules in the engine's settings, not by a person on an approval card.
- The 10 s sampler failed from 21:07:49 to 21:24 (a parsing bug in the drill, fixed mid-run). The samples are
  secondary: ticks, turns, wakes and the pushes come from the database, the logs and the recorder. The reap time is in
  the apiserver's log and in `session.finished_at`.
- With `everySeconds` 300 the silence limit (15 minutes) is exactly three intervals, so whether the push comes at the
  third or the fourth missed slot depends on a second of timing; here it came at the third (900.8 s).
- One apiserver process, heartbeats over HTTPS (no link gateway), all on one host.
- The engine was recycled by the kills; recycling by its four-hour warm TTL was not waited for.

## Run it again

```bash
bash scripts/long-running-loops/stack.sh build            # overlay, apiserver build, runner-go build, claude copy
bash scripts/long-running-loops/stack.sh start            # PostgreSQL, migrations, apiserver (+ preloads), fake model
python3 scripts/long-running-loops/drill.py setup         # owner, fake-model key, six runners, three workspaces
scripts/long-running-loops/run-drill.sh start             # the timeline and the sampler, as transient units
scripts/long-running-loops/run-drill.sh wait OUT          # waits (2 h 16 min), then dumps the evidence into OUT
python3 scripts/long-running-loops/verdicts.py OUT        # the checks, verdicts.json, summary.md
bash scripts/long-running-loops/stack.sh down             # stop everything; data stays in LRL_DIR
```

`LRL_PROFILE=smoke` runs the same steps in about 13 minutes with short intervals, to check the drill itself.

## Files

- [`verdicts.json`](verdicts.json), [`summary.md`](summary.md): the checks and the tables `verdicts.py` derives.
- [`ticks-a.md`](ticks-a.md), [`ticks-b.md`](ticks-b.md): every tick with its turn; `raw/ticks-*.json` the rows.
- [`push-calls.jsonl`](push-calls.jsonl): the recorder's file. [`session-get-*.txt`](session-get-A1.txt): what
  `mcp__orbit__session_get` returned to C's agent; `raw/compact-*.json` the owner's read of the same function at the
  same moments.
- [`wake-blocks.md`](wake-blocks.md): every `<scheduled-wakeup>` and `<background-job-…>` block as Claude Code sent it.
- `raw/`: turns, stall wakes, job reports, loops, runners, the drill's timeline (`timeline.jsonl`, with the kill
  steps' process lists), the samples (`samples.jsonl.gz`, and their changes in `sample-transitions.jsonl`), the
  fake model's log, the apiserver's log and runners a, b and c's logs, the build (`build.json`) and the drill's public
  state (ids, parameters, every step's result).
