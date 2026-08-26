# Runner CLI and automation

The static `orbit` runner binary also exposes task, project, and session commands for scripts and agent orchestration.
Human-readable output is the default; use `--json` for stable machine parsing. Discover the commands available
to the current credential and execution context before using them:

```bash
orbit capabilities --json
```

## Tasks and task lists

```bash
orbit task list --status OPEN --json
orbit task create --title "Check deployment" --description "Verify health and logs" --json
orbit task update <task-id> --status DONE --json
orbit task delete <task-id> --json
orbit task-list create --title "Release" --json
```

Inside a task-backed Orbit session, task commands may omit the task ID and use `ORBIT_TASK_ID`. In-session
CLI mutations are attributed to the current agent and session. Headless mutations that use only a runner
credential fall back to the runner owner.

## Projects

```bash
orbit project get <project-id> --json
orbit project update <project-id> --status CANCELLED --json
orbit project delete <project-id> --json
```

Project deletion is permanent and only succeeds while the project is empty. It never deletes or detaches tasks;
move them to another project or delete them first.

## Sessions

```bash
orbit session create --prompt "Review the change" --agent-name reviewer --json
orbit session get <session-id> --json
orbit session send <session-id> --message "Please add a regression test" --json
orbit session complete <session-id> --json
orbit session delete <session-id> --json
```

Session deletion moves the session to Trash and retains its data so a human can restore it. It does not expose
the permanent purge operation to agents.

`--agent-name` selects the Orbit agent (project directory and runner configuration) that should execute the
session. Check `orbit capabilities --json` instead of assuming a session operation is authorized.

Creating sessions and using lifecycle operations requires a live caller session whose current workspace has
orchestration enabled. The runner receives a short-lived, session-bound proof. Every request rechecks the live
session assignment and workspace policy, so ending, deleting, reassigning, or disabling orchestration revokes
access without waiting for proof expiry. When orchestration is enabled, `orbit agent list`, `agent create`,
and `agent update` expose the same agent-management surface to the CLI. Only a human can enable orchestration.

## Headless runner-local access

A process on a registered runner with no `ORBIT_SESSION_ID` can use the runner credential to inspect and send
messages only to sessions hosted by that runner:

```bash
orbit session list --status AWAITING_INPUT --json
orbit session get <session-id> --json
orbit session send <session-id> --message-file - --json < event.txt
```

It cannot see sessions on other runners, create arbitrary sessions, or use destructive lifecycle operations.

## Service tokens

Use a service token when a long-lived integration must create or access sessions without borrowing the broad
runner credential. A token has explicit scopes, an expiry, and—when it can create sessions—an agent pin.
The destructive lifecycle verbs are not service-token scopes.

```bash
orbit token mint \
  --scope session:create,session:get \
  --agent-id <agent-id> \
  --ttl 24h \
  --label "automation bridge"

orbit token list --json
orbit token revoke <token-id>
```

The token value is printed once. Store it in the integration's secret manager as `ORBIT_SERVICE_TOKEN`. A
service token cannot mint another token, and revocation is checked on every request.

## Security notes

- The runner token in `~/.orbit/config.json` is a long-lived machine credential. Protect it with operating-
  system file permissions and never copy it into a repository or shared log.
- A service token should receive only the scopes and lifetime its integration needs.
- The runner machine's OS account is the local trust boundary; sibling processes owned by that account are
  not isolated from each other.
- Capability output is contextual. Treat it as the source of truth after upgrades or credential changes.
- Prefer `--message-file` for untrusted or multiline input so shell interpolation does not change the content.
