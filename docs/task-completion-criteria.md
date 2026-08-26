# Task completion criteria

Every task declares exactly one ordinary completion criterion. The choices are peers, not a
priority order or an escalation chain:

- `EXECUTABLE` runs one shell command and is satisfied only when its actual exit code equals
  `acceptanceExpectedExitCode`.
- `VERIFICATION` is satisfied only by `PASS` from an independent verification task. The subject
  uses `completionPolicy: VERIFICATION_PASSED`; the verifier points to it with `verifiesTaskId`.
- `HUMAN_SIGNOFF` is satisfied by one human signoff. It is also the compatibility value for a task
  that predates the field or whose creator omitted it. It does not mean another criterion failed.

An unsatisfied criterion is a current view of missing evidence. It is not an exceptional signal
that somebody must later clear.

## Status derivation and direct writes

`DONE` is the optimistic projection of a satisfied criterion, not an editable task fact. A person,
project coordinator/judgment session, task execution session, verifier, or foreman that tries to
write `task.status = DONE` receives `DIRECT_TASK_DONE_REFUSED` together with the task's declared
criterion and a criterion-specific `requiredAction`:

- finish the run so Orbit records and compares the `EXECUTABLE` exit code;
- record an independent verification `PASS` for `VERIFICATION`; or
- have a person use `orbit task signoff … --evidence …` (or `POST /tasks/:id/signoff`) for
  `HUMAN_SIGNOFF`.

The refusal deliberately remains at the task boundary rather than removing `DONE` from the generic
status enum: that is how it can name the task's actual route instead of saying only “not allowed.”
`FAILED` is unchanged. An execution session may still write it as a conservative self-report; it
does not release downstream work.

`HUMAN_SIGNOFF` is a durable event with a non-null signer, server timestamp, and non-blank evidence.
Creating that event, resolving the corresponding open `HUMAN_DECISION_REQUIRED` blocker, and
deriving task status `DONE` are one PostgreSQL transaction. Thus the blocker/signal is not cleaned
up later: it is the open view of the criterion being unsatisfied and ceases to be open at the same
commit that satisfies it. Retries return the original event rather than changing who/when/evidence.

## `EXECUTABLE` environment contract

The runner executes the command synchronously as `bash -lc <acceptanceCommand>`, after the task's
ordinary execution turn, with a two-minute timeout. A trailing `&` is passed to Bash as command
text and never activates Orbit's detached-shell shortcut, because the runner must observe a final
exit code.

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
