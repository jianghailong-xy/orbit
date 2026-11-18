# Condition triggers: design (v1)

**Status:** **decided** (owner, 2026-11-17), nothing built. Board: `docs/mocks/condition-triggers/`.

Work that starts when something outside Orbit becomes true: "when a third OSD is in, set the pool to 3 copies",
"when Ceph is above 90%, look at what can be cleared".

Owner decisions of 2026-11-17, all kept:

- one concept, a **condition**, attached in two places: a Task's `startWhen` and a schedule's `WHEN` rule (§3);
- a fired condition **proposes first**: nothing acts on an outside system unattended in v1 (§7);
- a **polling probe** on the runner first; an inbound event door later (§10);
- P1: a probe is the exact command the owner approved on the card (§4.1);
- P2: conditions live on the Scheduled page, in a group of their own (§9);
- P3: a one-shot condition that has not held for 30 days asks the owner once (§6.2);
- P4: three failed checks in a row are "can't read", and notify once (§5.3).

Owner decision of 2026-11-17, after the design was written:

- a `WHEN` condition may **fire again every N while it still holds** (`repeatSeconds`, §3, §5.1): a guard whose fix
  failed leaves the service unhealthy, the condition never re-arms, and without a repeat nothing would fire again.
  Optional, `WHEN` rules only, at least 15 minutes; each repeat is a run like any other, counted in the weekly budget.
- a condition on an **Orbit Cloud workspace keeps it awake** while the condition is active (§4.2): its schedule is
  `ACTIVE`, or its task is OPEN and waiting. The managed runner is not put to sleep, and one asleep is woken, so its
  probe keeps running. Pausing, ending or deleting the schedule, and the task starting or being cancelled, release it to
  sleep by the ordinary idle rule. Both create cards say so (§6.1, §6.2). The owner chose this over a probe that wakes a
  sleeping runner on a slower cadence.

## 1. Why

A conversation on the HPC workspace, 2026-11-17. The owner asked for the `kubernetes` pool to keep 3 copies. The
cluster had 2 OSDs, the agent asked, and the owner chose "Hold until 3rd OSD". The agent then wrote a private memory
note, because Orbit had nowhere else to put it. Nothing evaluates that note, the owner cannot see it in Orbit, and it
comes back only if a later session of that workspace happens to recall it. The same conversation reported the mon's
root disk at 5% available, in passing; nothing watches that either.

Two shapes came out of one conversation:

| Shape | Example | Fires | Produces |
| --- | --- | --- | --- |
| Deferred action | when 3 or more OSDs are in, set size 3 | once | a deliverable: evidence, a verdict |
| Standing guard | when raw use is above 90%, look and propose | at every crossing | a report, only when there is news |

What exists, and why none of it carries either shape:

| | Why it does not fit |
| --- | --- |
| `Task.runAt`, task dependencies | a time, or other Orbit tasks |
| Watch ([watch-contract.md](./watch-contract.md)) | reads Orbit's own records; its contract keeps connectors and shell out of the server |
| `bg_run` with a polling script | belongs to one session, ends with it or with a runner restart, and is not an object anybody can list |
| A schedule ([scheduled-tasks-design.md](./scheduled-tasks-design.md)) | daily at most, a model session at every slot, and its §10 leaves "a cheap pre-check before starting a model" out: "it belongs on the runner" |

This design is that pre-check, made the trigger.

## 2. What does not change

- Watch still reads only Orbit's records. Its predicate grammar gains no leaf, and the server still runs no command.
- A condition is not a dependency state. `dependencyState` stays `NONE | READY | BLOCKED | BLOCKED_FAILED`; a
  condition answers "when does this start", as `runAt` does, and is evaluated beside it.
- Schedules keep their three access levels, `CHECK_ONLY`, `OPEN_PR` and `LAND`, and a `WHEN` schedule takes any of them
  as a timed one does. `LAND` lands code on main; none of them is a level that may act on an outside system by itself.
- The agent-first rule of the schedule design holds: nothing here is a form. A person says the condition; an agent
  writes the probe; the card reads it back.

## 3. Model

```text
Condition
  id, ownerId, workspaceId                       the workspace whose runner runs the probe
  probe         { command, timeoutSeconds }      §4.1; timeoutSeconds 20 by default, 60 at most
  compare       { op: GT | GTE | LT | LTE | EQ | EXIT_ZERO, value? }
  holdSeconds                                    the comparison must stay true this long; 0 by default
  rearm?        { op, value }                    WHEN rules only: ready again once this holds
  intervalSeconds                                300 by default, 60 at least
  repeatSeconds?                                 WHEN rules only: fire again every this long while it still holds
                                                 (§5.1); 900 at least, and at least intervalSeconds; none by default
  text                                           the condition in words, written by the agent: "3 or more OSDs are in"
  unit?                                          how a reading is shown: "%", "in", "GiB"
  state         WAITING | HOLDING | FIRED | UNKNOWN | ENDED          §5
  lastSampleAt?, lastValue?, lastOutcome?        the newest sample, as the list shows it
  trueSince?, unknownSince?, failedChecks
  repeatFrom?                                    what the next repeat is counted from: the last FIRED, or the sample
                                                 the comparison held again on after a break
  approvedCommandHash, approvedAt                what the owner pressed Create or Allow on
  taskId? | scheduleId?                          exactly one

ConditionSample                                  kept 30 days, and the latest 1000 per condition
  conditionId, at, outcome (VALUE | EXIT | TIMEOUT | ERROR), value?, exitCode?, stderrTail?

ConditionEvent                                   what the history shows
  conditionId, at, kind (FIRED | READY_AGAIN | CANT_READ | READ_AGAIN | ASKED_STILL_WAITING), value?, runId?,
  repeat                                         a FIRED that is a repeat: the history says "Fired again"
```

Attach points:

- `Task.startWhenConditionId?`: a peer of `runAt`. A task has at most one of the two.
- `Schedule.rule = { kind: 'WHEN', conditionId }`: a peer of `ONCE`, `DAILY` and `WEEKLY` in
  `schedule-time.ts`. A `WHEN` schedule has no `nextDueAt`; its runs carry `trigger: CONDITION` and the firing
  sample's time as `plannedAt`.

Limits: 20 conditions that are not ENDED per account; one condition per task or schedule.

## 4. The probe

### 4.1 What it is (P1: A)

One shell command, run by the runner in the workspace's directory, with the workspace's environment and no model.
It answers with a number on the last line of stdout, or, for `EXIT_ZERO`, with its exit code.

- The agent writes it and runs it once in the conversation. That reading is the card's **Today** line, and the
  baseline: a condition that already holds when it is created fires at once, and the card says so.
- The card shows the command verbatim. The owner's **Create** approves that exact text; its hash is stored. A
  changed command is a change to what was approved: it waits for **Allow**, like any change that grows a
  schedule's envelope.
- The command is declared read-only. Nothing enforces that beyond the card: it runs with the rights the workspace
  already has, which is why the owner reads it. The runner does bound it: the timeout, 64 KiB of output, one
  running probe per condition, and no stdin.
- No secret is written into a command. A probe that needs one reads it from the workspace's environment.

### 4.2 Who runs it, and who decides

The runner runs; the server decides. This is the split the Watch contract uses for a quiet background job.

- `HeartbeatResponse` carries the conditions of this runner's workspaces: id, command, hash, timeout, interval
  (`conditionProbes`, sent to a runner that declares `condition-probe/v1`). It is the pattern `AgentDirs` and
  `AgentDirProbes` already follow.
- The runner refuses a probe whose command does not match the hash it was given, runs each on its interval, and
  reports samples in the next `HeartbeatRequest` (`conditionSamples`).
- The server stores the samples and moves the state (§5). The runner never decides that a condition fired, so a
  runner that died is seen as silence, not as "below the line".
- On an Orbit Cloud workspace (a managed runner), an **active condition keeps the workspace awake** (owner,
  2026-11-17). Active means not ENDED, with its owner object live: a `WHEN` schedule that is `ACTIVE`, or a `startWhen`
  task that is OPEN and has not started. Such a condition is demand for the runner
  ([managed-runner-design.md](./managed-runner-design.md), "Provisioning retry wake and sleep" 5 to 8): the manager
  does not start a drain while one exists and calls off one under way, the instance's acceptance of a drain is refused,
  and a runner asleep when the condition is created, or when its schedule is resumed, is woken (the demand hook, and
  the sweep that finds sleeping runners with work). Pausing, ending or deleting the schedule, a `HELD` schedule, the task
  starting or being cancelled, and the condition ending each remove the demand; the runner then sleeps by the ordinary
  idle rule. A self-managed runner, or the managed-runner switch off, is untouched: nothing here reads or writes a
  managed runner. The runner's probe loop is unchanged.
- `RUNNER_ASLEEP` is only the reason a silent condition shows while its woken runner is still coming up (waiting for
  capacity, starting); it is shown on the row and not notified. A runner that cannot come back by itself (FAILED,
  fenced, deleted, its account disabled) takes the ordinary can't-read path of §5.3, `RUNNER_OFFLINE`.

## 5. Evaluation

### 5.1 States

```text
WAITING ──compare true──▶ HOLDING ──true for holdSeconds──▶ FIRED
   ▲                         │                                 │
   └──────compare false──────┘          WHEN: rearm holds ─────┘  (READY_AGAIN)
                                        startWhen: ENDED

any ──3 failed checks, or no sample for 3 intervals──▶ UNKNOWN ──a sample arrives──▶ back, by that sample
```

- A condition fires on the **crossing**, once. Staying above the line fires nothing more.
- **Unless it repeats** (owner, 2026-11-17). A `WHEN` condition with `repeatSeconds` fires again when that long has
  passed since its last `FIRED` event, while it is FIRED, its comparison has held in every sample since, and it has not
  re-armed. Each repeat writes a `FIRED` event marked `repeat` and starts the work as any firing does (§5.2): one run
  with `trigger: CONDITION`, under the schedule's overlap rule, weekly budget (over budget is MISSED `OVER_BUDGET`) and
  start checks. A sample whose comparison is false while the re-arm has not held yet stops the repeats; when the
  comparison holds again, the clock restarts from that sample. A failed check neither completes a repeat nor breaks
  one; UNKNOWN never repeats, and the sample that leaves it restarts the clock. A repeat leaves `firedAt` at the
  crossing. With no `repeatSeconds`, nothing changes. A `startWhen` condition never repeats, and one created with
  `repeatSeconds` is refused.
- With no `rearm`, a `WHEN` condition is ready again as soon as the comparison is false. The agent writes a `rearm`
  whenever the reading can hover at the line ("above 90%, ready again below 85%").
- `holdSeconds` is measured between samples: the comparison held in every sample across that span.

### 5.2 Firing

One transaction: write the `FIRED` event, set the state, and start the work.

- **Schedule:** insert a run (`trigger: CONDITION`). From there everything is the schedule's own: overlap,
  the weekly budget, start checks, the report, findings, who hears. A crossing over budget is a run recorded
  MISSED (`OVER_BUDGET`), and the condition still waits for `rearm` before it can fire again.
- **Task:** make the task due, as an arrived `runAt` does. `SCHEDULED_DUE_SQL` in `tasks.service.ts` gains the
  disjunct "its condition is FIRED"; the retained-not-consumed rule holds, so an unassigned or held task stays
  due and starts when it can. The start clears the condition (ENDED), as a start clears `runAt`. `task_start`
  ignores the condition and ends it.

### 5.3 Can't read (P4: A)

A sample is a failure when the command timed out, exited non-zero (except under `EXIT_ZERO`), or printed no number.
Three in a row, or no sample for three intervals, is UNKNOWN.

- UNKNOWN never fires and never counts as false: `trueSince` is cleared, so a hold starts over.
- Entering UNKNOWN notifies once and puts a card in **Waiting on you**, with the last reading, its age, and why
  (`TIMEOUT`, `ERROR`, `RUNNER_OFFLINE`). A sample that reads again closes the card by itself.
- The apiserver being down is nobody's failure: on recovery the newest sample decides, and nothing replays.

## 6. The two attach points

### 6.1 A schedule's WHEN rule

The create card is the schedule's own, with one different line: **When** reads the condition ("Raw used above 90%
for 10 min"), the re-arm line and how it is checked, then the command. **Costs** still counts runs a week; probes
are not counted, because they start no model. The envelope gains the command's hash, so changing the command grows
it.

With a repeat, **When** carries one more line in words: "And again every 2 hours while it stays that way." The
inspector's *Condition* block carries the same sentence. A repeat is not part of the envelope: the weekly budget
already bounds the runs it can start, so changing it, shorter or longer, applies at once and is recorded as a revision.

On an Orbit Cloud workspace, **When** carries one more line under the check line: "Keeps this cloud workspace awake
while it waits." (§4.2). The condition's read says so as `keepsWorkspaceAwake`.

A run started by a condition gets the firing in its run block: the reading, since when, and the recent samples. A
repeat's block also says that it is a repeat, when the condition first fired, and how many runs it has started since.
The run's report key is its own choice, as today (`above-90@2026-11-21`).

### 6.2 A task's startWhen (P3: A)

`task_create` accepts `startWhen` in place of `runAt`. The confirmation card gains **Starts when**, **Today** and
**If never**. On an Orbit Cloud workspace, **Starts when** carries one more line under the check line: "Keeps this
cloud workspace awake while it waits." (§4.2). The task is OPEN while it waits and reads "Waiting for: 3 or more OSDs
are in" wherever a task shows why it has not started.

The task's run begins by checking the condition again itself: the reading may have gone back since it fired. If it
no longer holds, the run says so and ends, and the owner decides whether to wait again.

A condition that has not fired for 30 days asks the owner once ("Still waiting for a third OSD. Keep waiting?"):
**Keep waiting** asks again in 30 days, **Stop** ends the condition and leaves the task OPEN.

## 7. Acting: propose first

Nothing new is built for this, by decision.

- A `WHEN` schedule is `CHECK_ONLY`, `OPEN_PR` or `LAND`, as a timed schedule is; `LAND` lands code on main and acts on
  no outside system. A run that wants to change the outside system runs the command,
  and that command is an approval card: the run is AWAITING_APPROVAL and the card is in **Waiting on you**
  (schedule design §6.4). Unanswered for 2 hours, the run ends and nothing was done. "Always allow" on such a card
  is how an owner later lets a guard act by itself, one command pattern at a time.
- A `startWhen` task runs in its workspace's permission mode like any task. The agent files it so that the changing
  step waits for the owner: `OWNER_CONFIRMED` with reason `IRREVERSIBLE` or `DEPLOY` when the step is one.

## 8. Agents

- `schedule_create`: `rule: { kind: "WHEN", condition }`; `task_create`: `startWhen: condition`. The condition is
  `{ text, command, compare, holdSeconds?, rearm?, intervalSeconds?, unit?, repeatSeconds? }`, and `baseline` is
  required: the agent ran the command and passes what it read. `repeatSeconds` is accepted on a `WHEN` rule only.
- Tool descriptions gain the fifth row of the schedule design's "which timer" table: "when something outside Orbit
  becomes true" is a condition, not a `bg_run` poll and not a daily check.
- When a person answers a question with "wait until X", the agent proposes the card instead of writing a note.
- `condition_get` reads a condition's state, newest samples and events. There is no `condition_create`: a
  condition exists only on a task or a schedule.

## 9. Surfaces (P2: A)

Board: `docs/mocks/condition-triggers/01-board.png`, iOS as the reference.

- **Scheduled page:** a group "Waiting for a condition" above Today, for `WHEN` schedules and `startWhen` tasks.
  Where a timed row shows its time, these show the newest reading and its age. A gauge replaces the circle.
  UNKNOWN rows are in **Needs you**.
- **Inspector:** a *Condition* block (reading, firing line, re-arm line), *How it checks* (interval, runner,
  command, when it was approved, and, when the condition's read says `keepsWorkspaceAwake`, "Keeps this cloud workspace
  awake while it waits."), and FIRED / READY_AGAIN lines in the history.
- **Tasks:** the waiting line on the task; nothing else.
- **Sessions:** the two create cards; on a run's session, the header names the firing instead of a planned time.
- **Waiting on you:** can't-read cards, the 30-day question, and a run's proposal.

## 10. Out of scope for v1

- Acting unattended inside a pre-approved envelope (decision 2). The path to it is §7's "Always allow".
- An inbound event door (Alertmanager, Ceph health, a webhook). It would feed the same `Condition` as another
  source of samples.
- Conditions over more than one probe, and probes on a runner other than the workspace's.
- A built-in catalogue of probes.
- Conditions owned by a project.

## 11. Delivery

| Phase | Scope |
| --- | --- |
| C1 server | migration and model; sample intake on the heartbeat; the state machine of §5 with pg specs for crossing, hold, re-arm, can't-read and silence |
| C2 runner | `condition-probe/v1`: the probe loop, hash check, timeout and output bounds, samples on the heartbeat |
| C3 schedule | the `WHEN` rule, `trigger: CONDITION`, the firing in the run block, the command in the envelope, the create card's lines |
| C4 task | `startWhen` beside `runAt` in the due scan, the card's lines, the waiting line, the 30-day question |
| C5 agents | `schedule_create` / `task_create` inputs, `condition_get`, descriptions, the agent contract |
| C6 clients | the group, the readings, the inspector block and the cards on iOS, then web, macOS, Android |
| C7 proof | on the HPC workspace: the Ceph capacity guard and the third-OSD task, each fired once against a real probe |

C1 to C3 make the 90% example work; C4 makes the third-OSD example work.
