# Agent instructions eval: the step-0 baseline

Status: measured 2026-11-24 on this repository's runner host (`workstation`), for step 0 of
[the instruction-units migration](orbit-project:352R9eS7ejsJ7azhLMsqh) (`docs/agent-instructions-design.md` §6). Every later
step compares itself with this report, scenario by scenario, and so does the final eval.

## What was measured

- **Code.** The runs were played on commit `dccc711c83`. They were then graded again from their transcripts by the
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
  (`scripts/agent-eval.sh live --leave-out UNIT`; the unit ids are `src/runner-go/instruction_units.go`'s).
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
| `I1-wait-await` | `wait` | 10/10 | 10/10 | 10/10 | 10/10 |
| `I2-notify-when-done` | `notify` | 10/10 | 0/10 | 12/12 (+2 err) | 0/10 |
| `I3-delegate-subagent` | `delegate` | 5/10 | 0/10 | 10/10 (+4 err) | 10/10 |
| `I3-delegate-subagent/background` | `delegate` | 10/10 | 10/10 | 10/10 (+4 err) | 4/10 |
| `I4-reply-file-link` | `reply-files` | 4/10 | 0/10 | 10/10 | 10/10 |
| `I5-evidence-file-upload` | `evidence-files` | 7/10 | 1/10 | 10/10 | 10/10 |
| `I6-progress-report` | `progress` | 1/10 | 0/10 | 10/10 | 2/10 |
| `I7-wiki-path-search` | `wiki` | 1/10 | 0/10 | 10/10 | 0/11 (+1 err) |
| `I8-settings-propose` | `primer.settings` | 10/10 | 10/10 | 10/10 | 10/10 (+3 err) |
| `I9-no-project-for-ordinary-work` | `project` | 10/10 | 10/10 | 10/10 | 10/10 (+4 err) |

### Where leaving the paragraph out lowers the pass rate

- **`notify`**: on both engines, 10/10 to 0/10 on Claude Code and 12/12 to 0/10 on Codex. Without it the agent answers
  the watch's wake in the conversation, which the person who stepped away does not see.
- **`delegate`**: on Claude Code for "use a subagent" (5/10 to 0/10), where it otherwise runs its own `Agent`; on
  Codex for "in the background" (10/10 to 4/10).
- **`reply-files`** on Claude Code: 4/10 to 0/10. Without it the agent always names the `/tmp` path or pastes the
  log.
- **`evidence-files`** on Claude Code: 7/10 to 1/10. Without it the report stays in the checkout and is never
  `file_upload`ed.
- **`progress`** on Codex: 10/10 to 2/10. On Claude Code it is 1/10 to 0/10 (below).
- **`wiki`** on Codex: 10/10 to 0/11. On Claude Code it is 1/10 to 0/10 (below).

### Where it does not, said plainly

- **`wait`**: no drop on either engine (10/10 with and without). Both find `task_await` by its name and end the turn
  on its receipt, whose lead says "End your turn now… Do not poll or sleep to wait for it". This paragraph is the
  first candidate for the sunset rule (design §4.5): the receipt already carries what it says.
- **`primer.settings`**: no drop on either engine (10/10 with and without). The request names a notification the
  agent can only change through Settings, and `settings_get` and `settings_propose` are found by name.
- **`project`**: no drop on either engine (10/10 with and without). This was expected. The paragraph's job is to
  curb the over-proposal its earlier form caused, so taking it out also takes out the invitation to propose. The
  primer's "when two fit, the smaller wins" is left either way.
- **`delegate`, the other case on each engine**: "in the background" on Claude Code (10/10 with and without) and
  "use a subagent" on Codex (10/10 with and without). These runs do not show why. One possibility, not measured: the
  delegate tool's own description, which is loaded up front, is enough for those two requests.
- **`reply-files` and `evidence-files` on Codex**: no drop (10/10 with and without). Codex hands the log over with
  `file_upload` and an `orbit-attachment:` link in both forms.
- **`progress` and `wiki` on Claude Code**: the drop is from 1/10 to 0/10, which ten runs cannot tell from noise. On
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

## How it was run

```bash
# Baseline: the contract's 20 scenarios five times, the I scenarios ten times, per engine.
scripts/agent-eval.sh live --engines claude --scenarios 'E*,X*' --repeats 5 --transcripts DIR
scripts/agent-eval.sh live --engines claude --scenarios 'I*' --repeats 10 --transcripts DIR
# Each unit left out, ten runs of the scenario that guards it, for example:
scripts/agent-eval.sh live --engines codex --scenarios I1-wait-await --repeats 10 --leave-out wait
# Graded again with grader 7, then one report each:
scripts/agent-eval.sh regrade OUT.json DIR
scripts/agent-eval.sh merge docs/agent-eval/instructions-step0/baseline.json REPORT.json...
```

The jobs ran with the precompiled test binary of the commit (`go test -c`), which is what `scripts/agent-eval.sh
live` runs, with the same cleaned environment and `ORBIT_AGENT_EVAL_*` variables. Each run kept its transcript
on the host, under `/var/tmp/p0-eval/transcripts/`. A transcript holds the engines' words, so it is not committed.
