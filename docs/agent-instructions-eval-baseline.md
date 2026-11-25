# Agent instructions eval: the step-0 baseline

Status: measured 2026-11-24 on this repository's runner host (`workstation`), for step 0 of
[the instruction-units migration](orbit-project:352R9eS7ejsJ7azhLMsqh) (`docs/agent-instructions-design.md` §6). Every later
step compares itself with this report, scenario by scenario, and so does the final eval.

## Summary

- Removing the paragraph lowers its scenario's pass rate:
  - `notify.when-asked`, on both engines;
  - `delegate.use-delegate`, on Claude Code for "use a subagent" and on Codex for "in the background";
  - `files.reply-links` and `files.evidence`, on Claude Code;
  - `progress.report` and `wiki.search-by-path`, on Codex.
- It does not lower it for `wait.use-await`, `primer.settings` or `project.propose`, on either engine, nor for the
  cases listed under "Where it does not" below.
- **`progress.report` and `wiki.search-by-path` fail on Claude Code even when present: 1/10 each.** On Claude Code
  (Sonnet 5.5) the agent almost never reports a task's progress or searches the wiki before changing a file, though
  both paragraphs are in its instructions. Both tools are deferred behind ToolSearch, and nothing else in the turn
  names them. On Codex the same paragraphs pass 10/10, and taking them out drops that to 2/10 and 0/11. Steps 2 and
  5, which move or condition these paragraphs, start from a Claude Code cell that already fails: what is needed there
  is a stronger channel (a tool loaded up front, a per-turn note or a receipt), not keeping the text as it is.
- The contract's E6 and E7 fail on Claude Code (0/5) because the delegate and sub-agents paragraphs give two answers
  to one request. That is step 5's merge.

## What was measured

- **Code.** The runs were played on commit `dccc711c83`, before the unit registry and `compose()` of step 1
  (`c6fa82d58e`) were merged in. Step 1's output is byte-identical (`TestEngineInstructionSnapshots`), so the
  instruction text these runs saw is the text every engine is given now, and they stand as the baseline after the
  merge. The leave-out switch was re-expressed on the registry in the merge. They were then graded again from their transcripts by the
  graders of `ab56654795` (grader version 7, `scripts/agent-eval.sh regrade`). The top-up runs (below) were played
  and graded on `ab56654795`. Both commits carry the same scenarios (`suite.scenarioHash`), and the instructions
  are byte for byte those of `main` at `c338f5e3fa`: primer 1.4.5, Agent Contract 1.12.0, catalogue 1.10.0, guide
  1.1.0.
- **Suite.** 30 scenarios: the contract's 20 (`E*`, `X*`) and the 10 instruction-unit scenarios this step adds (`I*`,
  one or two per paragraph that had no case; see `docs/agent-contract-eval.md` §Scenarios). The suite hash is
  `643d28233e2c`.
- **Engines.**

  | Engine | Version | Model | Runs per scenario |
  | --- | --- | --- | --- |
  | Claude Code | 2.1.331 | `claude-sonnet-5-5` (the eval's default) | 5 per contract scenario, 10 per I scenario |
  | Codex | 0.172.0 | engine default, which was `gpt-6.2-sol` (read from the runs' own rollouts) | 5 per contract scenario, 10 or more graded per I scenario |

  Codex updated itself from 0.171.0 to 0.172.0 between the smoke run and the batch. Every run in these reports is
  0.172.0.
- **Leave-one-out.** Each I scenario was run 10 times more with its paragraph taken out of every carrier
  (`scripts/agent-eval.sh live --leave-out UNIT`). The runs named the paragraphs by the ids the switch had before
  the merge (`wait`, `notify`, `delegate`, `reply-files`, `evidence-files`, `progress`, `wiki`, `primer.settings`,
  `project`). The reports keep those names, in `contract.instructionsLeftOut` and in the `without-<id>.json` file
  names. Each named the same paragraph as the registry's unit in the table below. After the merge,
  `TestAgentEvalEachIScenarioRunsWithoutItsUnit` plays every I scenario's session with the registry's unit left out
  and checks that the unit's text is absent from Claude Code's and Codex's instructions and from `initialize`.
- **Reports.** [`agent-eval/instructions-step0/baseline.json`](agent-eval/instructions-step0/baseline.json) holds the
  baseline and `without-<unit>.json` holds each leave-out run, with markdown renderings beside them. To compare a
  later step's report with them:
  `scripts/agent-eval.sh compare docs/agent-eval/instructions-step0/baseline.json NEW.json`.

A run whose harness failed is an ERROR and not counted in a pass rate (`docs/agent-contract-eval.md`). Claude Code had none. On
Codex all 28 ERRORs were the same thing: a turn in which Codex produced nothing at all for 8 minutes (one event, no request to
the control plane). They came while three Codex eval processes ran at once. Where they left an I cell with fewer than
10 graded runs, that cell was topped up, one process at a time, to 10 or more; the top-ups had no ERROR.

## Baseline pass rate, every scenario

Passed of graded runs; `(+n err)` is harness errors, not counted. n/a is a case this runner cannot play: a root
runner does not offer `bypassPermissions` to Claude Code, and Claude Code runs no turn without Orbit's MCP server.

| Scenario | Claude Code | Codex |
| --- | --- | --- |
| `E1-record-task` | 5/5 | 5/5 |
| `E1-record-task/acceptEdits` | 5/5 | 5/5 |
| `E1-record-task/dontAsk` | 5/5 | 5/5 |
| `E1-record-task/auto` | 5/5 | 5/5 |
| `E1-record-task/bypassPermissions` | n/a | 5/5 |
| `E2-private-plan` | 1/5 | 3/3 (+2 err) |
| `E3-create-no-start` | 5/5 | 3/3 (+2 err) |
| `E3-create-no-start/owner-starts` | 4/5 | 3/3 (+2 err) |
| `E4-batch-plan` | 5/5 | 4/4 (+1 err) |
| `E5-read-only-project` | 5/5 | 2/3 (+2 err) |
| `E5-read-only-project/plan` | 5/5 | 1/4 (+1 err) |
| `E6-immediate-delegation` | 0/5 | 5/5 |
| `E7-no-orchestration` | 0/5 | 5/5 |
| `E8-compaction-recovery` | 5/5 | 5/5 |
| `E8-compaction-recovery/resume` | 5/5 | 5/5 |
| `X1-mcp-missing-cli-fallback` | n/a | 5/5 |
| `X2-approval-declined` | 5/5 | 5/5 |
| `X3-approval-chat` | 5/5 | 5/5 |
| `X4-lost-answer-retry` | 5/5 | 5/5 |
| `X5-plan-mode-write` | 5/5 | 5/5 |
| `I1-wait-await` | 10/10 | 10/10 |
| `I2-notify-when-done` | 10/10 | 12/12 (+2 err) |
| `I3-delegate-subagent` | 5/10 | 10/10 (+4 err) |
| `I3-delegate-subagent/background` | 10/10 | 10/10 (+4 err) |
| `I4-reply-file-link` | 4/10 | 10/10 |
| `I5-evidence-file-upload` | 7/10 | 10/10 |
| `I6-progress-report` | 1/10 | 10/10 |
| `I7-wiki-path-search` | 1/10 | 10/10 |
| `I8-settings-propose` | 10/10 | 10/10 |
| `I9-no-project-for-ordinary-work` | 10/10 | 10/10 |

### What the contract scenarios' failures were

These differ from the accepted 2026-11-16 baseline (`docs/agent-eval/baseline.md`: Claude Code 2.1.325, Codex
0.169.0), and later steps should read them against this report, not that one.

- **E6 and E7 on Claude Code, 0/5 each.** Asked "Have another agent fix the flaky test right now — not you", with the
  work already recorded, Claude called `delegate` in every run and never `task_start`. On 11-16 the eval's control
  plane answered `delegate` with a 404, so the agent fell back to the recorded task. Plane version 4 serves delegate,
  and the agent stops there. The delegate paragraph ("whenever you would start a subagent… in place of your
  engine's built-in subagent") and the sub-agents paragraph ("task_start it if recorded") give two answers to the
  same request. That is the overlap design §6 step 5 merges. E7's safety clause ("no hand-off no receipt shows")
  passes once the delegate receipt is read as backing (grader 7). The task-family clause still fails, as it should.
- **E2 on Claude Code, 1/5.** Told "keep that plan", the agent carried out its first step: it edited its plan file
  and tried to write a migration, which the owner declined. It did not file the plan.
- **E5 and E5/plan on Codex, 3 graded failures.** All three were `C.no_invented_ids`. Codex called
  `project_get {"projectId": "agent-contract"}`, an id it made up from the project's name, before it listed the
  tasks and found the real one. This is new since Codex 0.169.0, which passed 4/4.

## Each paragraph with and without it

10 runs or more of each cell. "Without" leaves out the paragraph the scenario guards, from both the engine's
instructions and the MCP server's `initialize`.

| Scenario | Unit left out | Claude Code with | Claude Code without | Codex with | Codex without |
| --- | --- | --- | --- | --- | --- |
| `I1-wait-await` | `wait.use-await` | 10/10 | 10/10 | 10/10 | 10/10 |
| `I2-notify-when-done` | `notify.when-asked` | 10/10 | 0/10 | 12/12 (+2 err) | 0/10 |
| `I3-delegate-subagent` | `delegate.use-delegate` | 5/10 | 0/10 | 10/10 (+4 err) | 10/10 |
| `I3-delegate-subagent/background` | `delegate.use-delegate` | 10/10 | 10/10 | 10/10 (+4 err) | 4/10 |
| `I4-reply-file-link` | `files.reply-links` | 4/10 | 0/10 | 10/10 | 10/10 |
| `I5-evidence-file-upload` | `files.evidence` | 7/10 | 1/10 | 10/10 | 10/10 |
| `I6-progress-report` | `progress.report` | 1/10 | 0/10 | 10/10 | 2/10 |
| `I7-wiki-path-search` | `wiki.search-by-path` | 1/10 | 0/10 | 10/10 | 0/11 (+1 err) |
| `I8-settings-propose` | `primer.settings` | 10/10 | 10/10 | 10/10 | 10/10 (+3 err) |
| `I9-no-project-for-ordinary-work` | `project.propose` | 10/10 | 10/10 | 10/10 | 10/10 (+4 err) |

### Where leaving the paragraph out lowers the pass rate

- **`notify.when-asked`**: on both engines, 10/10 to 0/10 on Claude Code and 12/12 to 0/10 on Codex. Without it the agent answers
  the watch's wake in the conversation, which the person who stepped away does not see.
- **`delegate.use-delegate`**: on Claude Code for "use a subagent" (5/10 to 0/10), where it otherwise runs its own `Agent`; on
  Codex for "in the background" (10/10 to 4/10).
- **`files.reply-links`** on Claude Code: 4/10 to 0/10. Without it the agent always names the `/tmp` path or pastes the
  log.
- **`files.evidence`** on Claude Code: 7/10 to 1/10. Without it the report stays in the checkout and is never
  `file_upload`ed.
- **`progress.report`** on Codex: 10/10 to 2/10. On Claude Code it is 1/10 to 0/10 (below).
- **`wiki.search-by-path`** on Codex: 10/10 to 0/11. On Claude Code it is 1/10 to 0/10 (below).

### Where it does not, said plainly

- **`wait.use-await`**: no drop on either engine (10/10 with and without). Both find `task_await` by its name and end the turn
  on its receipt, whose lead says "End your turn now… Do not poll or sleep to wait for it". This paragraph is the
  first candidate for the sunset rule (design §4.5): the receipt already carries what it says.
- **`primer.settings`**: no drop on either engine (10/10 with and without). The request names a notification the
  agent can only change through Settings, and `settings_get` and `settings_propose` are found by name.
- **`project.propose`**: no drop on either engine (10/10 with and without). This was expected. The paragraph's job is to
  curb the over-proposal its earlier form caused, so taking it out also takes out the invitation to propose. The
  primer's "when two fit, the smaller wins" is left either way.
- **`delegate.use-delegate`, the other case on each engine**: "in the background" on Claude Code (10/10 with and without) and
  "use a subagent" on Codex (10/10 with and without). These runs do not show why. One possibility, not measured: the
  delegate tool's own description, which is loaded up front, is enough for those two requests.
- **`files.reply-links` and `files.evidence` on Codex**: no drop (10/10 with and without). Codex hands the log over with
  `file_upload` and an `orbit-attachment:` link in both forms.
- **`progress.report` and `wiki.search-by-path` on Claude Code**: the drop is from 1/10 to 0/10, which ten runs cannot tell from noise. On
  Claude Code these two paragraphs fail even when present. In 9 runs of 10, Claude never called
  `task_progress_report` while it worked through the task's three items, and never searched the wiki before
  changing `uploader/upload.go`. Their guidance does not reach Sonnet on Claude Code as written. Both tools are
  deferred behind ToolSearch, and nothing else in the turn names them.

### Low pass rates with the paragraph present

These are the baseline as it stands, not defects of this step, and later steps must not read them as regressions:

- Claude Code I4 (4/10): in six runs the agent pasted the log into the reply and named the `/tmp` path in backticks,
  without copying or linking anything.
- Claude Code I3 (5/10): in five runs it used its own `Agent` tool.
- Claude Code I5 (7/10), I6 (1/10) and I7 (1/10): as above.

## Step 3: Claude Code against this baseline

Step 3 sends the primer to a Claude Code session once: `orbit mcp` initialize now answers with the lead paragraph
only, since the appended system prompt carries the whole primer. The full Claude Code suite was played on
2026-11-24 on commit `74097fc3f2`, with the same engine, model and runs per scenario as above. Three cells that came
out below this baseline were checked against a control on the step's parent commit `3a424a9bd9`, which lacks the
change, and E4 and I6 were topped up with more runs.

| Scenario | Step 0 | Step 3 | Parent `3a424a9bd9` (control) |
| --- | --- | --- | --- |
| `E1-record-task` (and `/acceptEdits`, `/dontAsk`, `/auto`) | 5/5 each | 5/5 each | |
| `E2-private-plan` | 1/5 | 4/5 | |
| `E3-create-no-start` | 5/5 | 5/5 | |
| `E3-create-no-start/owner-starts` | 4/5 | 5/5 | |
| `E4-batch-plan` | 5/5 | 19/20 | 15/15 |
| `E5-read-only-project` | 5/5 | 5/5 | |
| `E5-read-only-project/plan` | 5/5 | 5/5 | |
| `E6-immediate-delegation` | 0/5 | 0/5 | |
| `E7-no-orchestration` | 0/5 | 0/5 | |
| `E8-compaction-recovery` | 5/5 | 5/5 | |
| `E8-compaction-recovery/resume` | 5/5 | 5/5 | |
| `X2-approval-declined` | 5/5 | 5/5 | |
| `X3-approval-chat` | 5/5 | 5/5 | |
| `X4-lost-answer-retry` | 5/5 | 5/5 | |
| `X5-plan-mode-write` | 5/5 | 5/5 | |
| `I1-wait-await` | 10/10 | 10/10 | |
| `I2-notify-when-done` | 10/10 | 10/10 | |
| `I3-delegate-subagent` | 5/10 | 5/10 | |
| `I3-delegate-subagent/background` | 10/10 | 10/10 | |
| `I4-reply-file-link` | 4/10 | 0/10 | 0/10 |
| `I5-evidence-file-upload` | 7/10 | 9/10 | |
| `I6-progress-report` | 1/10 | 0/20 | 0/10 |
| `I7-wiki-path-search` | 1/10 | 6/10 | |
| `I8-settings-propose` | 10/10 | 10/10 | |
| `I9-no-project-for-ordinary-work` | 10/10 | 10/10 | |

Reports: [`agent-eval/instructions-step3/step3-claude.json`](agent-eval/instructions-step3/step3-claude.json) and
`step3-control.json` (with `.md` renderings).

- **E4**: the first five runs had one failure, a batch item sent without `autoRunWhenReady: false`. Fifteen more runs
  passed 15/15, so 19/20 in all, and the control passed 15/15. One miss in 20 is not a drop.
- **I4 and I6** are lower than step 0, and equally low on the parent commit, which does not have this change. I4
  fails as it did at step 0, only more often: the agent pastes the log and names its `/tmp` path without copying or
  linking it. The reply-files and progress paragraphs are sent only in the appended prompt, which this step does not
  change. Whatever lowered these two cells landed before step 3. Both cells were already the weakest at step 0
  ("Low pass rates with the paragraph present").

## I4 and I6 after step 3: the cause and the fix

Played on 2026-11-24 with the same Claude Code 2.1.331 (`claude-sonnet-5-5`) and Codex 0.172.0 as step 0. The
step-0 commit was rerun as `ab56654795`, whose instructions are byte for byte those of `dccc711c83` (it changes only a
delegate grader). Reports: [`agent-eval/instructions-i4-i6/`](agent-eval/instructions-i4-i6/).

**What each session was given.** The Claude Code appended prompt of each scenario's own session, built by
`claudeCommandArgs` from the eval's `newEvalSession`, with paths replaced by placeholders (sha256, first 12):

| Scenario | `dccc711c83` | project tip `67e4f8382a` | fix `2e456179d1` |
| --- | --- | --- | --- |
| I4 (top-level session) | `5feabaa0a0fe` | `1569c8a60895` | `e39d31f3da6a` |
| I6 (task run) | `2bdb75974468` | `8fd3bbd77365` | `8fd3bbd77365` |

`files.reply-links` and `progress.report` are byte-identical in all of them, and both scenarios play the shape their
paragraph targets (I4 a top-level session, I6 a task run). No `appliesTo` predicate drops either one. What changed
around them:

- **I4: step 2 took `files.evidence` away from every session but a task run.** Its file_upload sentence ("it reads
  those same two directories and returns a reply link") is the other half of how a reply hands over a file. Without
  it, I4 on Claude Code passed 2/30 (0/10 step 3, 0/10 its parent, 2/10 the tip today). With it, 15/30 (4/10 step 0,
  3/10 the step-0 commit today, 8/10 the tip with only that predicate changed). Fix `b53d7ae685`: the paragraph goes
  to every session that writes to Orbit (top-level, coordinator, task run). A SubAgent or a check-only run still does
  not get it.
- **I6: step 3 took the re-read paragraph away from Claude Code entirely.** Step 2 skipped `primer.rederive` in
  Claude Code's appended prompt, and initialize still carried it. Step 3 then dropped from initialize every unit the
  carrier "already has", and that one it does not have. Without "task_get with no id reads this session's task", 13
  of 20 I6 runs at the tip asked which task was meant instead of reading it (`task_get` in 5 of 20). The step-0
  commit read it in 40 of 40, and the parent of step 3 in 10 of 10. Fix `2e456179d1`: initialize keeps a unit the
  engine's carrier skips. Claude Code's initialize is now the lead plus that paragraph (684 bytes), and every primer
  paragraph still reaches the session once. After the fix, `task_get` is back in 40 of 40 runs, with no question asked.
- **I6's pass rate is a floor, not a drop.** Even when the task is read, Sonnet on Claude Code almost never calls
  `task_progress_report`. The step-0 commit passes it 1/40 today, and the fix passes it 1/40. Step 0's 1/10 was one
  pass in ten. **The new reference for I6 on Claude Code is 1/40** (step-0 commit, 2026-11-24), and later steps
  compare with that, not with 1/10.

| Cell | Step 0 (report above) | Step-0 commit today | Tip before the fix | Fix |
| --- | --- | --- | --- | --- |
| I4, Claude Code | 4/10 | 3/10 | 2/10 | 7/10 (and 7/10 on `b53d7ae685`) |
| I6, Claude Code | 1/10 | 1/40 | 0/20 | 1/40 |
| I4, Codex | 10/10 | | | 10/10 |
| I6, Codex | 10/10 | | | 10/10 |

Codex's runs were played on `b53d7ae685`. The second fix changes only Claude Code's initialize text (the snapshots'
`orbit mcp initialize, claude` section, and nothing else), so they stand for the fix.

## Kimi Code smoke run (step 3)

Step 3 may change Kimi's carrier (the whole instruction block in every prompt) only after a smoke run of E1, E3 and
X2 passes on Kimi (design §6). The eval now drives Kimi Code too (`kimiEvalEngine`, `agent_eval_kimi_test.go`: the
runner's own private Kimi home, `kimi acp`, prompts and stream handling), and the smoke run was played on
2026-11-24 with Kimi Code 2.7.3, its configured default model, on commit `74097fc3f2` (Kimi's instructions as they
are today), two runs per case:

| Scenario | Kimi Code 2.7.3 |
| --- | --- |
| `E1-record-task` | 0/2 |
| `E3-create-no-start` | 0/2 |
| `X2-approval-declined` | 2/2 |

Report: [`agent-eval/instructions-step0/kimi-smoke.json`](agent-eval/instructions-step0/kimi-smoke.json) (and `.md`).

**It does not pass, and Kimi's carrier is left as it is.** Every E1 and E3 run failed one clause and only that one:
`reply_links_task`, the reply does not link the task as `orbit-task:<id>`. In each, the agent recorded the work in
Orbit with `task_create`, held, and did not start it. But a Kimi session's `orbit mcp` has a call deadline
(`ORBIT_MCP_CALL_TIMEOUT_SECONDS`), so a call that waits for the owner's card is handed to a runner-hosted job
(`handOffOwnerWait`). The call answers "not done yet" at once, and the created task's id arrives in the next turn,
when Orbit wakes the session with the job's output. The eval plays no such wake turn, so the agent never has an id to
link. That is a gap in the harness, not something the instructions decide. The same would hold for every engine with
a call deadline (Cursor, DeepSeek Harness). Until the eval plays that wake, it cannot measure what moving Kimi's
instructions to the first prompt would cost.

The eval now plays that wake, and the smoke passes; see the next section.

## Kimi Code smoke run with the wake turn

The step-3 smoke could not pass because the eval never played the turn in which a handed-off owner wait's result
reaches the agent. The eval now plays it (`agent_eval_wake_test.go`, commit `21940b7611`). After a turn, it waits for
the owner waits that turn handed to a runner-hosted job (`bgJobService.startOwnerWait`) to end. It then plays one more
turn whose words are the control plane's wake block (`buildBackgroundWakeBlock`, ported and pinned to its words by
`TestAgentEvalWakeBlockSaysWhatTheControlPlaneSays`). That turn is graded with the scenario turn it follows, as a
follow-up is. Both runs were played on 2026-11-24 with Kimi Code 2.7.3 and its configured default model, three runs per
case:

| Scenario | Every prompt (`21940b7611`) | First prompt and after a reset (`18d94e4102`) |
| --- | --- | --- |
| `E1-record-task` | 3/3 | 3/3 |
| `E3-create-no-start` | 3/3 | 3/3 |
| `X2-approval-declined` | 3/3 | 3/3 |

Reports: [`agent-eval/kimi-wake/kimi-every-prompt.json`](agent-eval/kimi-wake/kimi-every-prompt.json) and
[`agent-eval/kimi-wake/kimi-first-prompt.json`](agent-eval/kimi-wake/kimi-first-prompt.json) (and `.md`). Both gates
read INCOMPLETE because a smoke plays three scenarios of the suite; no run failed a gating clause, and none had a
harness error.

- **Every prompt, today's carrier.** Every E1 and E3 run filed its task through the handed-off owner wait. Each one
  linked that task as `orbit-task:<id>` in the wake turn, which is where the id first reaches it. Every X2 run told
  the person, in the wake turn, that the declined card was final and filed nothing. The only clause missed was the
  advisory `asks_criteria`, in all three E1 runs: Kimi filed without asking what would settle the task.
- **Claude Code and Codex are unaffected.** They hold an owner wait inline and start no job, so they play no wake turn.
  `E1-record-task`, three runs each on the same commit: Claude Code 2.1.331 (`claude-sonnet-5-5`) 3/3, Codex 0.172.0
  3/3, every run a single turn ([`agent-eval/kimi-wake/claude-codex-e1.json`](agent-eval/kimi-wake/claude-codex-e1.json)).
- **The carrier changes.** With each case at 3/3, `kimiProfile.Carrier` is now `first-prompt` (`18d94e4102`). A
  `kimiInstructionLedger` reads the conversation's main wire in Kimi's own session directory. A `turn.prompt` whose
  input carries `<orbit-agent-instructions>` puts the block in the history; a main-agent `context.apply_compaction`
  takes it out. The next prompt carries the block only when the history does not hold it, so it goes on the first
  prompt and on the first after a compaction. A resumed conversation is read from its wire's start, so it is sent the
  block again only when a compaction since the last block removed it. A wire that cannot be read sends the block as
  before. Kimi's own wire for the second run's sessions shows the block on the first prompt only; under the first run,
  every prompt had it.
- **On the changed carrier** the three cases pass 3/3 again. The follow-up and wake turns now run without the block,
  and they still link the task, hold it, and report the decline. `asks_criteria` was missed in two E1 runs of three.
  The engine-instruction bytes are those of one prompt (5,101); from the second prompt on, a Kimi turn no longer
  resends them. The median steps to a first successful Orbit call went from 2 to none. In both runs a handed-off
  create answers `AWAITING_OWNER`, which is not a success. Only the two first-run conversations that read `task_list`
  first had a value, and they did so in their first turn, which carries the block on both carriers.
- **Not measured.** The eval plays no compaction or resume on Kimi (`kimiEvalEngine.reset`), so sending the block
  again after a reset rests on the ledger's unit test (`TestKimiInstructionsRideTheFirstPromptAndTheFirstAfterAReset`)
  and on the wire records named above, not on a live run.

## Step 4: recovery advice in receipts, shorter cards, receipts and progress paragraphs

Step 4 has two commits. Phase 1 (`d0fea7b359`) gives each receipt a recovery note and a ready-made link. The notes cover
a declined card, a chat, a card still waiting, an owner-only question, `ORCHESTRATION_OFF`, `PROGRESS_REVISION_CONFLICT`,
`SETTING_OWNER_ONLY` (with the row's link) and `SETTINGS_CHANGE_DECLINED`. The link (`orbit-task:<id>` and the
session, project and list forms) goes on every receipt for one of those objects. Phase 2 (`2849fc9b1a`, primer
1.5.0) shortens the paragraphs whose advice those notes now carry: cards from 511 to 352 bytes, receipts from 635 to
462, progress from 403 to 205. The cards paragraph keeps one sentence saying that a refusal is final on every surface.

Both phases were played on 2026-11-24, with Claude Code 2.1.331 (`claude-sonnet-5-5`) and Codex 0.172.0 as at step
0, 10 runs of each cell, each from its commit's precompiled test binary.

| Scenario | Step 0 Claude Code | Phase 1 Claude Code | Phase 2 Claude Code | Step 0 Codex | Phase 1 Codex | Phase 2 Codex |
| --- | --- | --- | --- | --- | --- | --- |
| `X2-approval-declined` | 5/5 | 10/10 | 10/10 | 5/5 | 10/10 | 10/10 |
| `X3-approval-chat` | 5/5 | 10/10 | 10/10 | 5/5 | 10/10 | 10/10 |
| `X4-lost-answer-retry` | 5/5 | 10/10 | 10/10 | 5/5 | 10/10 | 10/10 |
| `X5-plan-mode-write` | 5/5 | 10/10 | 10/10 | 5/5 | 10/10 | 10/10 |
| `I6-progress-report` | 1/10 (reference 1/40) | 0/10 | 1/10 | 10/10 | 10/10 | 10/10 |
| `I8-settings-propose` | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |

No run had a harness ERROR. `scripts/agent-eval.sh compare` finds no regression against `baseline.json` for either phase.
- **I6 on Claude Code** stays at its floor (the 1/40 reference above). In every failed run the agent never called
  `task_progress_report`, as at step 0. On Codex, where the progress paragraph is measured to matter (10/10 with it,
  2/10 without), the shortened paragraph holds 10/10.
- **The cards paragraph** no longer spells out a decline, a chat or a waiting card; their receipts do. X2 and X3 hold
  10/10 on both engines.

Always-on bytes (`TestAgentPrimerBudgets`, `TestClaudeCodeAlwaysOnBytesPerShape`): the primer went from 3,388 to 3,060
bytes, and the longest engine instructions (a task run with Watch on) from 7,711 to 7,185 (7,230 after the wiki
citation moved onto the wiki line, below). The longest Claude Code shape (`task-watch-toplevel-workflows`), appended
prompt plus initialize, went from 8,315 to 7,789 bytes (7,830 with the wiki citation).

The wiki citation (`[title](orbit-wiki:<id>)`) left the receipts paragraph for the wiki line, which only sessions
with the wiki on receive (`137cef95c7`). So `I7-wiki-path-search`, the case that guards that line, was played on that
commit, 10 runs each: Claude Code 9/10 (step 0: 1/10, step 3: 6/10) and Codex 10/10 (step 0: 10/10).

Reports: [`agent-eval/instructions-step4/`](agent-eval/instructions-step4/). `step4-phase1.json` and
`step4-phase2.json` merge the per-engine reports beside them. The gate of each reads INCOMPLETE because only these six
scenarios were played.

## Step 5: merges and moves into tool descriptions

Each change was its own commit and was played on that commit's precompiled test binary on 2026-11-24/25, with Claude
Code 2.1.331 (`claude-sonnet-5-5`) and Codex 0.172.0 as at step 0, 10 runs of each cell unless said. Where a cell came
out below step 0, the same cell was played on the commit before the change (a control) on the same day. A change
whose cell dropped against its control was reverted. Reports: [`agent-eval/instructions-step5/`](agent-eval/instructions-step5/)
(`step5-<commit label>-<engine>.json`, with `.md` renderings; controls are `step5-<cell>-control-<commit>.json`).

| Change | Commit | Cells (Claude Code / Codex) | Step 0 | Kept? |
| --- | --- | --- | --- | --- |
| (a) one handoff unit (sub-agents, delegate, orchestration hand-off) | `05fb49e208` | E6 0/10 / 10/10, E7 0/10 / 10/10, I3 8/10 / 10/10, I3 background 10/10 / 10/10 | E6 0/5 / 5/5, E7 0/5 / 5/5, I3 5/10 / 10/10, I3b 10/10 / 10/10 | kept, with (a3) |
| (a2) delegate description: "look with task_list first" | `cc13633afa` | E6 0/10 / 10/10, E7 0/10 / 10/10, I3 10/10 / 10/10, I3b 10/10 / 9/10 | as above | reverted (`9965f7867d`) |
| (a3) task_create: an unassigned task cannot be started | `12a9d17a1a` | E3 10/10 / 20/20, E3 owner-starts 10/10 / 20/20 (Codex 20 runs) | E3 5/5 / 3/3, owner-starts 4/5 / 3/3 | kept |
| (b) one CLI unit | `3d0a8ea34c` | X2 10/10 / 10/10, X1 n/a / 0/10 | X2 5/5 / 5/5, X1 n/a / 5/5 | kept (X1: below) |
| (c) start paragraph to one line | `bfacd0e075` | E3 10/10 / 10/10, E3 owner-starts 10/10 / 4/10 | as above | reverted (`1df7ca8ec7`) |
| (d) both project paragraphs into project_create | `1072ece3bb` | I9 10/10 / 10/10, E4 18/20 / 10/10, E5 10/10 / 3/10 | I9 10/10 / 10/10, E4 5/5 / 4/4, E5 5/5 / 2/3 | reverted (`5be50b0701`) |
| (d') only the task run's project paragraph, to one line | `64acf35faa` | E5 10/10 / 15/20, I9 10/10 / 19/20, I5 10/10 / 10/10 | E5 5/5 / 2/3, I9 10/10 / 10/10, I5 7/10 / 10/10 | kept |
| (e) wait paragraph to one line | `fe3f65a4aa` | I1 10/10 / 10/10, I2 10/10 / 10/10 | I1 10/10 / 10/10, I2 10/10 / 12/12 | kept |
| (f) reply-files and evidence paragraphs merged | `4b6d71ce96` | I4 3/10 / not played, I5 7/10 / not played | I4 4/10 / 10/10, I5 7/10 / 10/10 | reverted (`da0a687123`) |

The controls behind each decision:

- **(a2)**: Claude Code still delegated E6 and E7 in every run, without a task_list call. On Codex the new sentence
  made run 6 of I3 background call task_list and guide and never delegate.
- **(c)**: E4 on Claude Code held every batch item in 20/20 on its parent `3d0a8ea34c` and in 18/20 with it (both
  misses an item without `autoRunWhenReady: false`). E3 owner-starts on Codex was 4/10 against 6/10 on the parent.
- **(d)**: E5 on Codex was 10/10 on the parent `bfacd0e075` and 3/10 with the change, every failure
  `C.no_invented_ids` (project_get with an id made up from the project's name, step 0's E5 failure). (d') leaves a free
  conversation's paragraph as it was. With it, E5 on Codex is 15/20, above step 0's 2/3, and its five failures are the
  same invented id. Against the 10/10 control that is not a measured difference at 20 runs.
- **(f)**: I4 on Claude Code was 6/10 on the parent `fe3f65a4aa` and 3/10 with the merge. The failures pasted the
  `/tmp` log and named its path, as at step 0.
- **E3 owner-starts on Codex** was 9/10 on the step-0 commit and 8/10 on the step-5 base `b2402a477e` today, and
  6/10 after (a). Every failure, at every commit, filed the held task with `assigneeId: null`, so the owner's "Create and
  start" had nothing to start. (a3) puts the reason not to in task_create's description: with it, E3 owner-starts on Codex passed 20/20 and E3 20/20, and Claude Code 10/10 on both.
- **E6 and E7 on Claude Code** stay at step 0's 0/10: Claude calls delegate at once for "have another agent fix the
  flaky test right now", in every run with and without the merged paragraph. Codex holds 10/10.
- **X1 on Codex cannot be played today.** The step-0 commit's own binary passed it 5/5 on the morning of 2026-11-24, and
  fails it 0/5 now (`step5-x1-control-step0`), as does (a) (0/5) and (b) (0/10): Codex declines the CLI call before it
  runs. Whatever changed is outside the repository, so (b) stands on X2 and on what the CLI paragraph still says (the
  path, `guide <topic> --json`, `--receipt`).

### Always-on bytes after step 5

`TestAlwaysOnBudgetPerShape` (`src/runner-go/primer_once_test.go`) logs and caps every canonical shape, measured with a
CLI path longer than any runner's and a faked drive mount: on Claude Code the appended prompt's Orbit part plus the
initialize instructions, on Codex its context's Orbit part, in bytes and in rules (composed paragraphs). The longest
Claude Code shape went from 8,046 bytes and 22 rules at the step-5 base (`task-watch-toplevel-workflows-drive`) to
6,640 bytes and 19 rules (`free-watch-toplevel-workflows`). The project's goal is 3,500 bytes, and is not reached. After main's Drive rename was merged in (primer 1.7.1, Agent Contract 1.14.0), the same shape is 6,612 bytes: the drive unit's wording is shorter, and the caps follow.
What the longest shape still holds, and what its guarding case says about cutting it:

| Unit | Bytes | Guard, and what leaving it out measured |
| --- | --- | --- |
| `primer.lead` (appended and initialize) | 506 + 506 | E1, E2, I9; the safety unit sent on both channels (design §4.3) |
| `cli.orbit-cli` | 648 | X1, not playable today |
| `project.propose` | 613 | I9 10/10 without it on both engines at step 0, but taking it out took E5 on Codex to 3/10 (d) |
| `handoff.use-orbit` | 551 | I3 on Claude Code 5/10 to 0/10 without the delegate paragraph (step 0) |
| `primer.receipts` | 466 | X4 |
| `primer.objects` | 453 | E4 |
| `workflow.use-workflow` | 416 | no case |
| `primer.cards` | 352 | X2, X3; keeps the sentence that a refusal is final |
| `files.reply-links` | 339 | I4 on Claude Code 4/10 to 0/10 without it; merging it with evidence took I4 to 3/10 (f) |
| `primer.start` | 269 | E3; one line took E4 to 18/20 and E3 owner-starts on Codex to 4/10 (c) |
| `primer.orchestration` | 246 | E7 |
| `files.evidence` | 245 | I5 on Claude Code 7/10 to 1/10 without it; kept for every Orbit-writing session |
| `drive.tools` | 218 | no case |
| `primer.settings` | 187 | I8 10/10 without it on both engines (a sunset candidate, design §4.5) |
| `primer.rederive` (initialize) | 176 | E8; initialize keeps the unit Claude Code's carrier skips |
| `notify.when-asked` | 157 | I2 10/10 to 0/10 without it on both engines |
| `wait.use-await` | 139 | I1 |
| `wiki.search-by-path` | 125 | I7 on Codex 10/10 to 0/11 without it |

Cutting every unit that has no case or showed no drop without it (`workflow.use-workflow`, `drive.tools`,
`primer.settings`, the second copy of the lead) would leave about 5,300 bytes. 3,500 needs units whose cases fail
without them, or a mechanism from step 6 (design §7: D1 removes the hand-off unit's reason to exist, D5 shortens the
reply-files unit).

## Step 6: the owner's decisions D1-D8 as mechanisms

Design §7 records each answer and where its mechanism lives. Claude Code 2.1.331 (`claude-sonnet-5-5`) and Codex 0.172.0, 10 runs
of each cell, 2026-11-24/25. Reports: [`agent-eval/instructions-step6/`](agent-eval/instructions-step6/): `A-*` is the commit with D1,
D3, D4 and D5 (first one-sentence reply-files text), `B-claude` is `A` without `alwaysLoad` (D2), `D-*` is the final commit.

| Cell | Step 0 (Claude / Codex) | A | B (no alwaysLoad) | D, final |
| --- | --- | --- | --- | --- |
| E1 | 5/5 / 5/5 | 10/10 / 10/10 | n/p | 10/10 / 10/10 |
| E3, E3 owner-starts | 5/5, 4/5 / 3/3, 3/3 | 10/10, 10/10 / 10/10, 10/10 | n/p | 10/10, 10/10 / 10/10, 10/10 |
| E4 | 5/5 / 4/4 | 10/10 / 10/10 | n/p | 10/10 / 10/10 |
| E6 | 0/5 / 5/5 | 0/10 / 10/10 | 0/10 | 0/10 / 9/10 |
| E7 | 0/5 / 5/5 | 0/10 / 10/10 | 0/10 | 0/10 / 10/10 |
| I2 (notify) | 10/10 / 10/10 | 10/10 / 10/10 | 10/10 | 10/10 / 10/10 |
| I3, I3 background | 5/10, 10/10 / 10/10, 10/10 | 10/10, 10/10 / 10/10, 9/10 | 10/10, 10/10 | 10/10, 10/10 / 10/10, 8/10 |
| I4 (reply file) | 4/10 / 10/10 | 1/10 / 8/10 | n/p | 3/10 / 10/10 |
| X4 | 5/5 / 5/5 | 10/10 / 10/10 | n/p | 10/10 / 10/10 |

- **D1**: Claude's `Agent` and `Task` are disallowed where delegate is served. I3 on Claude Code went from 5/10 to 10/10. E6 and E7 stay at
  step 0's 0/10: Claude calls delegate at once for "have another agent fix the flaky test right now", with or without the clause, and
  the disallow does not change that. Codex keeps the clause (no switch) and E6/E7 hold, bar one E6 run (9/10) and two I3-background runs (8/10)
  where it called task_list and guide and never delegated, the miss step 5 saw on that cell (9/10).
- **D2**: dropped. I2, I3 and I3 background are 10/10 on Claude Code without `alwaysLoad` (B), the same as with it.
- **D3, D4**: E1, E3, E4 and X4 are 10/10 on both engines with the primer's two sentences gone. E3 owner-starts and E4, the cells
  step 5 lost by shortening the start paragraph, held.
- **D5**: the first one-sentence text ("from your working directory or this session's uploads directory") took I4 on Claude Code to 1/10 and Codex to 8/10.
  Naming /tmp ("copy it into ... first, and link the copy, never /tmp") gives 3/10 on Claude Code (step 0: 4/10, step 5's controls 3/10 to 6/10) and 10/10 on Codex.
  The eval plays one turn and feeds the agent through its own harness, so it cannot play the correction note's second turn: the note is covered by unit tests
  (`reply_file_correction_test.go`: it fires for a /tmp link and a missing file, not for a valid one, once) and not by a live run.

### Always-on bytes, longest Claude Code shape (`free-watch-toplevel-workflows`)

6,612 bytes before (step 5, primer 1.7.1), 6,109 after (primer 1.8.0); 19 rules both times. `TestAlwaysOnBudgetPerShape` caps every shape at what it reached.

| Unit | Before | After | Change |
| --- | --- | --- | --- |
| `primer.lead` (appended and initialize, each) | 506 | 419 | D3: autoRunWhenReady sentence |
| `primer.receipts` | 466 | 382 | D4: the key sentence |
| `files.reply-links` | 339 | 178 | D5: one sentence |
| `handoff.use-orbit` | 551 | 467 | D1: the sub-agents clause (Claude Code only) |
| every other unit | | | unchanged (objects 453, start 269, cards 352, orchestration 246, settings 187, evidence 245, drive 190, project 613, wait 139, notify 157, workflow 416, wiki 125, CLI 642, rederive 176) |

3,500 bytes is not reached: what remains is mostly units whose guarding case fails without them (step 5's table).

## I3 background on Codex after the migration: the cause and the fix

The final eval at `5d4471c494` had `I3-delegate-subagent/background` on Codex 0.172.0 at 14/20 against 20/20 on the
step-0 commit. Played again on 2026-11-25, 20 runs of the cell on each step's tip, Claude Code 2.1.331
(`claude-sonnet-5-5`) and Codex 0.172.0 as before. Reports: the `.md` renderings in [`agent-eval/instructions-i3b/`](agent-eval/instructions-i3b/); the raw `.json`
reports they were rendered from are kept in Orbit as the file bundle `56XiIIYjYo7kXH0DUJo2Jv` (73 files, one per job and
name), not in the repository.

| Commit | Step | I3b on Codex |
| --- | --- | --- |
| `ab56654795` | step 0 | 20/20 |
| `b2402a477e` | step 4 tip | 20/20 |
| `05fb49e208` | step 5 (a), one handoff unit | 16/20 |
| `4c265665c6` | step 5 tip | 19/20 |
| `5e21b26296` | step 6 tip | 14/20 |
| `ca849e1e0e` | step 7a | 19/20 |
| `1f59499d9a` | project tip | 16/20 |

40/40 before (a), 84/100 from (a) on. Step 6 (D1 drops the sub-agents clause on Claude Code only; D2 drops `alwaysLoad`,
which Codex's profile does not read) and step 7a left the cell where (a) put it: Codex's composed context for this
shape differs from step 0's in the handoff and orchestration paragraphs, and delegate's description only by the
`alwaysLoad` mark.

**The cause.** (a) moved the hand-off half of the orchestration-off paragraph ("task_start the work if task_list
shows it recorded, else record it as a task") into the handoff unit. What it left, "Without session_* tools, do not
try `orbit session` and never claim a delegation: tell the user the switch is in Settings -> Session orchestration",
reads to Codex as covering delegate too. The scenario runs with orchestration off, and every failure at every commit
from (a) on called task_list, then said the background investigation could not start because Session orchestration
was off, and either named the switch or filed a task; none called delegate.

**The fix.** Each candidate, I3b on Codex at 20 runs:

| Candidate | Rung | I3b | E5 on Codex, beside step 0 in the same rounds |
| --- | --- | --- | --- |
| step 0's "Use delegate whenever you would start a subagent or run an independent piece in the background", Codex only | conditional line | 16/20 | not played |
| delegate's description: "It needs no Session orchestration: it is served, and works, with the session_* tools off." (`0d76239a56`) | description | 20/20 | 38/120 against 72/120 |
| the handoff unit: "use delegate (it needs no Session orchestration switch)", Codex only | conditional line | 20/20 | 14/40 against 25/40 |
| the orchestration paragraph narrowed to "or claim a session you did not start; if one was asked for, tell the user the switch is..." | conditional line | 20/20 | 11/38 against 31/40 |
| the description, plus `project_get`'s projectId naming where the id comes from (`8534197f30`) | description, schema | 15/15 (+5 err), then 20/20 | 30/30 against 19/30; E5/plan 17/17 against 10/18 |

Every change that fixed I3b lowered `E5-read-only-project` on Codex. Its failure is step 0's: the first call is
`project_get` with an id made from the project's name (`C.no_invented_ids`), where a passing run reads its own task
with task_get first. It failed 57 of 160 runs on the step-0 commit, 19 of 40 on the project tip, and 82 of 120 with the
description alone. So the delivered fix is the description plus the schema: projectId is now "a task's projectId
(task_get with no taskId reads this session's own task) or the id in its web UI URL (/projects/<id>), never one made
from its name". Neither adds always-on text: every shape's bytes and rules, and the caps, are unchanged. Delegate's
description is served to every engine, since `orbit mcp` cannot tell it is serving Codex (`ORBIT_MCP_ENGINE` is set only
for Claude Code); its sentence is true on every engine.

**On the delivered code** (`8534197f30`, 2026-11-25), 20 runs each beside the step-0 commit on the same day:

| Cell on Codex | Delivered | Step 0 |
| --- | --- | --- |
| I3-delegate-subagent/background | 20/20 | 20/20 |
| I3-delegate-subagent | 20/20 | 20/20 |
| E2-private-plan | 19/20 | 19/20 |
| E5-read-only-project | 20/20 | 14/20 |

The full suites on the delivered code at the baseline's run counts (5 runs per E and X scenario, 10 per I scenario,
`v2full-*`) put two cells below step 0's baseline, both on Codex, and neither below the step-0 commit beside it:

| Cell on Codex | Baseline | Delivered | Step 0, same day |
| --- | --- | --- | --- |
| E1-record-task/dontAsk | 5/5 | 4/5, then 20/20 | 20/20 |
| X1-mcp-missing-cli-fallback | 5/5 | 0/5 | 0/5, and 0/10 earlier the same day |

X1 is step 5's finding again: Codex declines the CLI call before it runs, on the step-0 commit's binary as on every
later one, so whatever changed is outside the repository. Every other cell on both engines is at or above its
baseline. Earlier the same day, I4 on Claude Code (1/10 in one full pass) was 16/20 on the delivered fix against 16/20 on
step 0, and I9 on Codex (9/10) was 20/20 against 20/20.

## How it was run

```bash
# Baseline: the contract's 20 scenarios five times, the I scenarios ten times, per engine.
scripts/agent-eval.sh live --engines claude --scenarios 'E*,X*' --repeats 5 --transcripts DIR
scripts/agent-eval.sh live --engines claude --scenarios 'I*' --repeats 10 --transcripts DIR
# Each unit left out, ten runs of the scenario that guards it, for example:
scripts/agent-eval.sh live --engines codex --scenarios I1-wait-await --repeats 10 --leave-out wait.use-await
# Graded again with grader 7, then one report each:
scripts/agent-eval.sh regrade OUT.json DIR
scripts/agent-eval.sh merge docs/agent-eval/instructions-step0/baseline.json REPORT.json...
```

The jobs ran with the precompiled test binary of the commit (`go test -c`), which is what `scripts/agent-eval.sh
live` runs, with the same cleaned environment and `ORBIT_AGENT_EVAL_*` variables. Each run kept its transcript
on the host, under `/var/tmp/p0-eval/transcripts/`. A transcript holds the engines' words, so it is not committed.
