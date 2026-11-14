---
name: playbooks
description: Orbit's long recipes: keeping a worked-out plan as one batch, filing many tasks from a file with the CLI, handing work off now, and finding out why an Orbit tool is missing or refused. Optional: guide and the tools' own descriptions are enough for any single call.
---

# Orbit playbooks 1.0.0

Long recipes for Orbit, written from the Orbit Agent Contract 1.8.0. They add steps to what you already know; they change no rule. For a single call, guide (no arguments for the routes, a topic for the recipe) and the tool's own description are enough, and they win if anything here disagrees with them. Name tools as your tool list does; run the Orbit CLI only by the absolute path your instructions give.

## Keep a worked-out plan

When: The person asks you to keep a plan that is already worked out and counted, or several related pieces of work at once.

1. Pick the record. One item is one task_create. Several related items are one task_create_batch (at most 50). A body of work with its own goal and acceptance, 4 or more dependent steps or several agents over days, may be proposed as project_create first; its card is the person's answer, and a no means tasks.
2. Give every item a ref (s1, s2, ...). Order with dependsOnRefs (when an item may run) and nest with parentRef (what it is part of). dependsOnTaskIds and parentTaskId name tasks that already exist.
3. Ask the person what would settle each item and pass their words as acceptanceCriteria; declare completionCriterion on every item. If they have not said, ask and end your turn.
4. Hold what must not start: autoRunWhenReady: false on that item. startNow: true only on an item they want running now.
5. Unsure where it lands? Call task_create_batch with dryRun: true first: it writes nothing and asks nobody.
6. Say in a sentence or two what you are about to file, then call task_create_batch once, keyed with an idempotencyKey derived from the plan.
7. Read the receipt: ok: true, outcome: written, items[] in input order, each with its id. Link each as [title](orbit-task:<id>). A declined card is a refusal: do not file it another way.

## File many tasks from a file

When: The work arrives as a file or a list too long to type: issues in a text file or a CSV, lines of a checklist.

1. Use the CLI's bulk door, by the absolute path your instructions give, never one task_create per line.
2. Build one --tasks document of at most 50 items with a script; every item carries title, description, completionCriterion and acceptanceCriteria, and autoRunWhenReady: false when it must wait.
3. Preview it: orbit task create-batch --tasks-file - --dry-run --json writes nothing and says where every item would land.
4. Write it: orbit task create-batch --tasks-file - --idempotency-key <a slug of the batch> --receipt. Inside a session it puts one card in front of the person; it exits 0 exactly when it wrote.
5. More than 50 items: split them into parts, each with its own key. A part that fails can be sent again with the same key and cannot file twice.
6. Outside a session (cron, CI) run the same command with the person's own token: ORBIT_USER_TOKEN=<token> orbit task create-batch ... is recorded as them and needs no card. The runner's machine credential cannot file work on its own (TASK_WRITE_NEEDS_OWNER_CARD).

```sh
jq -R -s 'split("\n") | map(select(length > 0)) | {tasks: map({title: ., description: ("Fix: " + .), completionCriterion: "EVIDENCE_JUDGMENT", acceptanceCriteria: "<what settles it>", autoRunWhenReady: false})}' issues.txt > plan.json
orbit task create-batch --tasks-file - --dry-run --json < plan.json
orbit task create-batch --tasks-file - --idempotency-key issues-txt-part-1 --receipt < plan.json
```

## Hand work off now

When: The person wants work running now, by another agent or in a conversation of its own.

1. Recorded already, with every prerequisite DONE: task_start on it. Its receipt names the started session.
2. Not recorded yet: task_create with startNow: true. One card covers the create and the start; do not call task_start after it.
3. The person wants a separate conversation rather than a work item: session_create on an agent. It exists only with Session orchestration on, and a sub-session never gets a wider permission mode than yours.
4. No session_* tools in your list: orchestration is off. Record the work as a task, tell the person the switch is in Settings -> Session orchestration, and never claim a delegation.
5. Then wait without polling: task_await or session_await, and end your turn. Orbit starts a new turn in this session when it finishes.

## Find out why an Orbit tool is missing or refused

When: A tool you expected is not in your list, or a call was refused and you are not sure why.

1. Call guide: it is listed in every session and only reads. Its index says, route by route, whether the route is available here and why not.
2. No Orbit tools at all: your engine did not start Orbit's MCP server. Use the CLI at the absolute path your instructions give: orbit guide --json, then orbit capabilities --summary --json, whose unavailable and withheld groups say why each command is missing.
3. A refused call: read its receipt, not its prose. error.code says what happened and error.retry what to do: resend, reread_first, fix_input, do_not_retry or wait.
4. Never get around a refusal by changing surfaces: MCP and the CLI reach the same server under the same approvals, so the answer would be the same, and a second ask without a new question.
5. Tell the person what is missing and where the switch is; the switches are theirs to change.

