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
that somebody must later clear. This model does not itself write `task.status`; status derivation
and the durable human-signoff event are separate changes.

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
