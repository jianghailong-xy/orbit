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

- finish the run so Orbit records and compares the `EXECUTABLE` exit code;
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
ordinary execution turn, with a two-minute timeout. A trailing `&` is passed to Bash as command
text and never activates Orbit's detached-shell shortcut, because the runner must observe a final
exit code.

The ordinary execution turn does not first write `IN_PROGRESS`. A newly dispatched task remains
`OPEN` until the reserved shell result is recorded; a retry of a prior failed attempt may already
be `IN_PROGRESS`. Both are pending inputs to the evaluator. A matching actual exit code derives
`DONE`, and a non-matching actual exit code derives `FAILED`, in the same transaction that stores
the command, raw combined output, and actual exit code. If the reserved turn cannot return a
comparable result (for example, an old runner omits the shell fields or the declaration changes
while it runs), Orbit leaves the task's pending status untouched and appends an
`EXECUTABLE_ACCEPTANCE_UNAVAILABLE` needs-human signal instead of silently parking it.

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
