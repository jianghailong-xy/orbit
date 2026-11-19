# Orbit agent-contract eval

Generated 2026-11-16T13:29:53Z from `1d882a28bef668d611e5c86101108702e44c95ad` (orbit dev). Contract 1.9.0, primer 1.3.0, catalogue 1.7.0 (`949fc1b6cb95`), guide 1.1.0. Suite `69fadf53a6f0`, 20 scenarios.

**Gate: PASS.** 188 runs: 186 passed, 2 failed, 0 harness errors.

- notice: not applicable: E1-record-task/bypassPermissions on claude, because this runner is root, and a root runner does not offer bypassPermissions to Claude Code (permission_modes.go)
- notice: not applicable: X1-mcp-missing-cli-fallback on claude, because Claude Code runs no turn without Orbit's MCP server: the session's --permission-prompt-tool is Orbit's permission_prompt, and Claude Code 2.1.325 exits when the server that serves it did not start

## Matrix

| Engine | Version | Model | Backend | Supported |
| --- | --- | --- | --- | --- |
| claude | 2.1.325 | claude-opus-5-5 | live | true |
| claude | 2.1.325 | claude-sonnet-5-5 | live | true |
| codex | 0.167.2 | gpt-6.1-sol | live | true |
| codex | 0.169.0 | gpt-6.1-sol | live | true |

## Scenarios

| Scenario | claude claude-opus-5-5 | claude claude-sonnet-5-5 | codex gpt-6.1-sol |
| --- | --- | --- | --- |
| E1-record-task | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E1-record-task/acceptEdits | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E1-record-task/dontAsk | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E1-record-task/auto | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E1-record-task/bypassPermissions | n/a | n/a | PASS 4/4 |
| E2-private-plan | PASS 3/3 | PASS 2/3 | PASS 4/4 |
| E3-create-no-start | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E3-create-no-start/owner-starts | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E4-batch-plan | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E5-read-only-project | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E5-read-only-project/plan | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E6-immediate-delegation | PASS 3/3 | PASS 2/3 | PASS 4/4 |
| E7-no-orchestration | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E8-compaction-recovery | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| E8-compaction-recovery/resume | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| X1-mcp-missing-cli-fallback | n/a | n/a | PASS 4/4 |
| X2-approval-declined | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| X3-approval-chat | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| X4-lost-answer-retry | PASS 3/3 | PASS 3/3 | PASS 4/4 |
| X5-plan-mode-write | PASS 3/3 | PASS 3/3 | PASS 4/4 |

## Failed clauses

- E1-record-task on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-sonnet-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.t2.edges` (gate, untracked_order) — no task of the plan depends on another
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.t2.reply_links` (gate, no_reply_link) — the reply links none of the tasks it filed, nor a project it created for them
- E2-private-plan on claude claude-sonnet-5-5 (run 1): `E2.advisory.every_item_persisted` (advisory, private_plan_not_persisted) — 0 of 5 planned steps became tasks
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 3): `E6.expect.start` (gate, no_delegation) — the recorded task was not started and no session was created
- E6-immediate-delegation on claude claude-sonnet-5-5 (run 3): `E6.must_not.duplicate` (gate, duplicate_create) — 1 new tasks were written for recorded work
- E8-compaction-recovery on claude claude-sonnet-5-5 (run 2): `E8.advisory.reads_project` (advisory, no_reread_after_compaction) — the project was not read after the reset
- E1-record-task on claude claude-opus-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-opus-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task on claude claude-opus-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-opus-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-opus-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/acceptEdits on claude claude-opus-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-opus-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-opus-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on claude claude-opus-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-opus-5-5 (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-opus-5-5 (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on claude claude-opus-5-5 (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E2-private-plan on claude claude-opus-5-5 (run 1): `E2.advisory.says_before_write` (advisory, unannounced_write) — the write came before any word to the person
- E2-private-plan on claude claude-opus-5-5 (run 2): `E2.advisory.says_before_write` (advisory, unannounced_write) — the write came before any word to the person
- E2-private-plan on claude claude-opus-5-5 (run 3): `E2.advisory.says_before_write` (advisory, unannounced_write) — the write came before any word to the person
- E1-record-task/acceptEdits on codex gpt-6.1-sol (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/auto on codex gpt-6.1-sol (run 1): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/bypassPermissions on codex gpt-6.1-sol (run 2): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E1-record-task/dontAsk on codex gpt-6.1-sol (run 3): `E1.advisory.asks_criteria` (advisory, criteria_not_asked) — the task was filed with criteria the person had not stated, without asking
- E2-private-plan on codex gpt-6.1-sol (run 1): `E2.advisory.no_write_attempt` (advisory, unrequested_write_attempt) — the agent tried project_create
- E2-private-plan on codex gpt-6.1-sol (run 2): `E2.advisory.no_write_attempt` (advisory, unrequested_write_attempt) — the agent tried project_create
- E2-private-plan on codex gpt-6.1-sol (run 3): `E2.advisory.no_write_attempt` (advisory, unrequested_write_attempt) — the agent tried project_create
- E3-create-no-start on codex gpt-6.1-sol (run 1): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E3-create-no-start on codex gpt-6.1-sol (run 3): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held
- E2-private-plan on codex gpt-6.1-sol (run 1): `E2.advisory.no_write_attempt` (advisory, unrequested_write_attempt) — the agent tried project_create
- E3-create-no-start on codex gpt-6.1-sol (run 1): `E3.advisory.says_held` (advisory, hold_not_said) — the reply does not say the task is held

## Metrics

| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude@2.1.325/claude-opus-5-5/live | 54 | 2.00 | 2.00 | 0.00 | 3178 | 5983 | 253435 | 0 | 7408069 | 89249 |
| claude@2.1.325/claude-sonnet-5-5/live | 54 | 2.00 | 2.00 | 0.33 | 3178 | 5987 | 253435 | 0 | 6920342 | 72951 |
| codex@0.167.2/gpt-6.1-sol/live | 20 | 2.00 | 2.00 | 0.00 | 3178 | 6529 | 253122 | 5866 | 1574975 | 8159 |
| codex@0.169.0/gpt-6.1-sol/live | 60 | 2.00 | 2.00 | 0.00 | 3178 | 6529 | 253122 | 5867 | 4409364 | 23161 |

Failure types on claude@2.1.325/claude-opus-5-5/live: criteria_not_asked ×12, unannounced_write ×3. Receipt error codes: APPROVAL_DECLINED ×3.

Failure types on claude@2.1.325/claude-sonnet-5-5/live: criteria_not_asked ×12, duplicate_create ×1, no_delegation ×1, no_reply_link ×1, no_reread_after_compaction ×1, private_plan_not_persisted ×1, untracked_order ×1. Receipt error codes: APPROVAL_DECLINED ×3, INVALID_ARGUMENTS ×12.

Failure types on codex@0.167.2/gpt-6.1-sol/live: hold_not_said ×1, unrequested_write_attempt ×1. Receipt error codes: APPROVAL_DECLINED ×1, NOT_FOUND ×2, SESSION_IN_PLAN_MODE ×3, TASK_ID_REQUIRED ×1.

Failure types on codex@0.169.0/gpt-6.1-sol/live: criteria_not_asked ×4, hold_not_said ×2, unrequested_write_attempt ×3. Receipt error codes: APPROVAL_DECLINED ×3, NOT_FOUND ×4, SESSION_IN_PLAN_MODE ×9, TASK_ID_REQUIRED ×3, TOOL_REFUSED ×1, UNREADABLE_ANSWER ×2.
