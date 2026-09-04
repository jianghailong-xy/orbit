# Task completion criteria

Every task declares exactly one ordinary completion criterion. The choices are peers, not a
priority order or an escalation chain:

- `EXECUTABLE` runs one shell command and is satisfied only when its actual exit code equals
  `acceptanceExpectedExitCode`.
- `VERIFICATION` is satisfied only by `PASS` from an independent verification task. The subject
  uses `completionPolicy: VERIFICATION_PASSED`; the verifier points to it with `verifiesTaskId`.
- `EVIDENCE_JUDGMENT` is satisfied by one decision on the task's own submitted evidence, made by any
  credentialed principal and bound to the exact evidence version it names. It is also the
  compatibility value for a task
  that predates the field or whose legacy user/JWT creator omitted it. It does not mean another
  criterion failed.

Runner CLI, MCP, and runner REST creates require `completionCriterion` explicitly on every task
and batch item. Command, policy, or verifier-relation fields do not stand in for that declaration;
old runner clients fail loudly instead of silently creating a human obligation. The legacy
user/JWT API and existing rows retain omission compatibility.

An unsatisfied criterion is a current view of missing evidence. It is not an exceptional signal
that somebody must later clear.

## Shape advice and deliberate overrides

On task creation Orbit compares the literal wording of `acceptanceCriteria` with a small keyword
table in `src/apiserver/src/tasks/task-criterion-shape-advice.ts`. It is deliberately a heuristic,
not a validator and not NLP:

- test/spec/command/exit-code wording tends toward `EXECUTABLE`;
- correctness, intent, coverage, reasonableness, or independent-review wording tends toward
  `VERIFICATION`;
- authorization, irreversibility, release/deletion, or value-tradeoff wording tends toward
  `EVIDENCE_JUDGMENT`.

Only one unambiguous category produces a question. Unknown wording and wording that matches more
than one category produce no advice. When the suggested criterion differs from the declaration,
the create returns `409 TASK_CRITERION_SHAPE_ADVICE` with `kind: ADVISORY`, a
`suggestedCriterion`, and a reason. This is separate from declaration consistency: an impossible
declaration remains a hard `TASK_COMPLETION_DECLARATION_INVALID` refusal.

The caller may adopt the suggestion, or retry with the original criterion and a non-blank
`completionCriterionOverrideReason`. Orbit stores that explanation on the task and returns it from
task reads. It is audit material for later readers, never evidence that satisfies the criterion.

## Status derivation and direct writes

`DONE` is the optimistic projection of a satisfied criterion, not an editable task fact. A person,
project coordinator/judgment session, task execution session, verifier, or foreman that tries to
write `task.status = DONE` receives `DIRECT_TASK_DONE_REFUSED` together with the task's declared
criterion and a criterion-specific `requiredAction`:

- let the declared command finish so Orbit compares the `EXECUTABLE` exit code (it is compared,
  not recorded);
- record an independent verification `PASS` for `VERIFICATION`; or
- decide the open judgment request with `orbit task judge … --evidence …`, the `task_judge` MCP
  tool, or `POST /tasks/:id/judgment` for `EVIDENCE_JUDGMENT`.

The refusal deliberately remains at the task boundary rather than removing `DONE` from the generic
status enum: that is how it can name the task's actual route instead of saying only “not allowed.”
`FAILED` is unchanged. An execution session may still write it as a conservative self-report; it
does not release downstream work.

`EVIDENCE_JUDGMENT` is a durable event with a non-null deciding principal, server timestamp, and a
non-blank finding, carried on the judgment request row itself (migration 0224 removed the separate
`task_human_signoff` table and folded its prose into `decision_note`).
Creating that event, resolving the corresponding open `HUMAN_DECISION_REQUIRED` blocker, and
deriving task status `DONE` are one PostgreSQL transaction. Thus the blocker/signal is not cleaned
up later: it is the open view of the criterion being unsatisfied and ceases to be open at the same
commit that satisfies it. Retries return the original decision rather than changing who/when/finding.

## `EXECUTABLE` environment contract

The runner executes the command synchronously as `bash -lc <acceptanceCommand>`, after the task's
ordinary execution turn. A trailing `&` is passed to Bash as command text and never activates
Orbit's detached-shell shortcut, because the runner must observe a final exit code.

The wall-clock budget is two minutes unless the task declares `acceptanceTimeoutSeconds` (1 to
86400), which replaces it for that task's acceptance command only — an interactive `!`-shell keeps
the two minutes unconditionally. The declared value is used exactly as given: nothing negotiates
it, clamps it, or decides before the command starts whether it was allowed to ask for that long.
Migration `0236` added it because the fixed ceiling made EXECUTABLE unusable for any repository
whose suite runs longer than two minutes, including this one — a suite measured at 101s, 104s,
105s and 126s across four runs of the same tree derived `DONE` or `FAILED` according to host load.

A budget is not a second chance. Exceeding whichever budget applies kills the command and reports
`-1`, which is compared like any other exit code, so it derives `FAILED` exactly as it did before —
size the budget above a passing run rather than raising it after a failure. The one thing that
changed is diagnosis: the killed command's output ends with a bracketed line naming the budget that
expired, so a reader can tell it from a suite that genuinely went red. That line is transcript text
and nothing else — it is not stored, and it is not a termination kind.

The ordinary execution turn does not first write `IN_PROGRESS`. A newly dispatched task remains
`OPEN` until the reserved shell turn reports; a retry of a prior failed attempt may already be
`IN_PROGRESS`. Both are pending inputs to the comparison. A matching actual exit code derives
`DONE` and a non-matching one derives `FAILED`, in the transaction that acknowledges the turn.

Nothing about the run is stored. The account owner decided on 2026-09-03 that the exit code is a
comparison input and not data — "根据 exit code 来简单判断，不需要实际记录数据" — so migration `0230`
restored the comparison alone: no judgment request, no result row, no attempt, no evidence, and no
comment carrying the command's output. Two consequences follow and are accepted:

- A timeout, a cancellation, a signal and a start failure are **not distinguishable** from a
  command that ran and returned the wrong code. The runner reports `-1` for all of them and it is
  compared like any other integer, so every one of them derives `FAILED`. Declaring
  `acceptanceTimeoutSeconds` changes when the timeout fires, never what it derives.
- The reason a task failed is **not recorded**. Diagnosis is reading the session: the run's own
  `error` carries `acceptance command exited N; expected M`, and the command's output is in the
  session transcript where the shell turn ran.

If the reserved turn cannot return a comparable result at all (an old runner omits the shell
fields, the turn never reports one, or the declaration changes while the command runs), there is
nothing to compare and Orbit does not guess. It leaves the task's pending status untouched and
appends an `EXECUTABLE_ACCEPTANCE_UNAVAILABLE` needs-human signal instead of silently parking it.

The working directory is the session execution directory:

1. When git worktree isolation is active, it is that session's worktree at the same relative
   subdirectory as the configured workspace directory.
2. Otherwise it is the workspace/agent `workDir` (falling back to the runner's configured
   `workDir`, then the runner process cwd).

The environment is the runner process environment with the workspace/agent's configured env
layered over it. Agent values may override ordinary runner values. `ORBIT_HOME` remains owned by
the runner, and session-scoped values are removed rather than inherited or accepted from agent
configuration: `ORBIT_SESSION_ID`, `ORBIT_AGENT_ID`, `ORBIT_TASK_ID`, `ORBIT_SPAWN_DEPTH`,
`ORBIT_ALLOW_ORCHESTRATION`, `ORBIT_ORCHESTRATION_TOKEN`, and `ORBIT_MCP_PERMISSION_PROMPT`.
No extra criterion-specific env is injected.

A command may use PostgreSQL when the task's own workspace deliberately provides a reachable
database and credentials through the normal runner/agent environment or repository configuration.
Orbit does not inject its control-plane PostgreSQL connection, does not promise a local `postgres`
service, and does not provision or reset a database for the command. In particular, a portable
criterion must not assume `COORDINATOR_PG_URL` exists. Destructive database checks should target an
explicitly isolated disposable database.
