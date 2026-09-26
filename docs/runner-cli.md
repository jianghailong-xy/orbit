# Runner CLI and automation

The static `orbit` runner binary also exposes task, project, and session commands for scripts and agent orchestration.
Human-readable output is the default; use `--json` for stable machine parsing. Discover the commands available
to the current credential and execution context before using them:

```bash
orbit capabilities --json
```

The document also names the binary itself: `cliVersion` and `sourceSha`, the commit it was built from —
or `dev-local` for a build that named none. `orbit status` prints both on its first line once a runner is
registered.

## Tasks and task lists

```bash
orbit task list --status OPEN --json
orbit task create --title "Check deployment" --description "Verify health and logs" --json
orbit task update <task-id> --status DONE --json
orbit task reopen <task-id> --json
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

## Providers

`--provider` on `orbit session create`, `orbit task create` and `orbit task update` takes a built-in engine
(`claude`, `codex`, `kimi`, `opencode`) or a provider configured on the account. List what is accepted, and
configure the account's own providers, with:

```bash
orbit provider list --json
printf %s "$ENDPOINT_KEY" | orbit provider create --label "Local vLLM" --runtime claude \
  --base-url http://127.0.0.1:8000 --api-key-file - \
  --models '[{"value":"qwen3.8-27b-fp8","label":"Qwen3.8 27B FP8","contextWindow":131072,"reasoningLevels":["low","medium","xhigh"]}]' \
  --json
orbit provider update local-vllm --base-url http://127.0.0.1:8001 --json
orbit provider delete local-vllm --json
```

A configured provider's slug is derived from its label: read it from the `create` output or from
`provider list`. The key is stored encrypted and never returned — every read, the write commands' own output
included, reports only `hasApiKey`. Inside a session each write is first put on a confirmation card in front
of the account owner, with the key shown only as set, and nothing is written if they decline; headless, the
runner owner at their own terminal is not asked. `update` and `delete` reach only the account's own
providers, never a shared one. The MCP tools `provider_create`, `provider_update` and `provider_delete` are
the same doors.

### Self-hosted endpoints (vLLM)

A `claude`-runtime provider points Claude Code at any endpoint serving the Anthropic Messages API; vLLM does,
at `/v1/messages`. What decides which endpoint a session actually talks to:

- At dispatch the control plane puts the provider's base URL and key into the engine's environment as
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, over any variable of the same name in the agent's environment,
  and the runner layers them over its own process environment. So the provider's endpoint beats both.
- Claude Code then applies the `env` blocks of its own settings files, and those win over the process
  environment: `~/.claude/settings.json` on the runner machine, the project's `.claude/settings.json` and
  `.claude/settings.local.json` in the agent's directory, and managed settings. Keep `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` out of them, or every session on that machine or project goes where they say.
- The URL is resolved on the machine the session runs on: `http://127.0.0.1:8000` is that runner's own port.
  Start the session on an agent whose runner hosts the endpoint (`orbit agent list` shows each agent's runner).
- `contextWindow` reaches Claude Code as the model's real window (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), so
  auto-compact keeps the session inside what the server was started with (`--max-model-len`). Without it Claude
  Code assumes 200k for a model it does not know.
- Claude Code sends an effort (`output_config.effort`) for a model it does not recognise — `high` when the
  session sets none — and vLLM hands it to the chat template as `reasoning_effort`. A template that takes only
  some levels fails every request: Qwen3.8's accepts `xhigh`, `medium` and `low`, and anything else is
  `400 Unexpected reasoning effort high.` Declare the levels the model accepts in `reasoningLevels` and every
  session's effort, including a change made mid-session, is moved onto the nearest of them: no effort counts
  as `high`, and of two equally near levels the higher is used. `[]` declares a model that takes no effort,
  and the engine is told to send none. The chat template needs no patch.
- The server's own start-up flags are the endpoint's business. `--served-model-name` must be the model's
  `value`. A hybrid DeltaNet/Mamba model such as Qwen3.8 refuses to start while `--max-num-seqs` (default 256)
  exceeds the Mamba cache blocks the GPU can hold, so lower it to at most the count vLLM reports (179 on a
  machine where the default is refused).

## Watches

Inside a session, wait on Orbit's own work with a watch instead of a sleep loop. The control plane holds the watch,
so it outlives the command, the shell and the engine; when its condition holds, Orbit starts a turn in the session
the command ran in.

```bash
orbit task await --task-id <task-id>,<task-id> --json     # every task terminal, or any one failed
orbit session await --session-id <session-id> --until ALL_SETTLED --json
orbit watch create --target TASK:<task-id> --predicate '{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_DONE"}' --json
orbit watch list --state ACTIVE --json
orbit watch cancel <watch-id> --json
```

A watch wakes the session that makes it, so these commands need `ORBIT_SESSION_ID` and have no headless form.
`session await`, and a watch that names sessions, need orchestration, as `session get` does. `orbit session create
--wait` records its wait as a watch before it starts: if the wait runs out or the control plane stops answering, the
output carries that watch under `"watch"`, and the watch keeps waiting. If no watch could be recorded, a session that
has not settled carries `"watch": {"error", "note", "code"}` instead (`code` is the control plane's refusal code, when it
gave one), stderr says so in one line naming `orbit session await`, and nothing will wake the caller for it; a watch the
control plane refuses (a quota, a permission) ends the wait at once. The exit status stays 0: the session exists.

## Wiki

The Orbit wiki is a codebase's own knowledge — decisions and what they rejected, pitfalls and their
fixes, conventions — and an agent reads it and proposes to it, never decides.

```bash
orbit wiki search "trgm index" --kind decision --json
orbit wiki search src/apiserver/src/wiki --limit 5 --json
orbit wiki get <entry-id>[,<entry-id>...] --include sources --json
orbit wiki propose --ops '[...]' --rationale "why it is worth recording" --idempotency-key <key> --json
orbit wiki propose --ops-file ops.json --dry-run --json
```

The three verbs are the three MCP tools of the same name (`wiki_search`, `wiki_get`, `wiki_propose`)
with the same parameters. Each acts for the session it runs in (`ORBIT_SESSION_ID`): what that
session may read is what its bound workspace shares, and its proposal is recorded against it, so
there is no headless form. `search` and `get` only read. `propose` records a changeset that waits
for the owner in Review — `--dry-run` checks every op and records nothing — and an agent cannot
accept, edit, reject, delete or overwrite an entry: deciding is the owner's, and a request carrying
a session header is refused `WIKI_OWNER_CHANNEL_ONLY` on the decide route. Cite an entry to the
user as `[title](orbit-wiki:<id>)`, the way every other Orbit thing is cited.

A proposal is answered per op — `pending`, `applied`, `conflict` (with the entry's current revision
and a diff) or `refused` (with the contract's reason codes and, for a schema failure, every field
that failed) — and a batch none of whose ops was recorded answers with the first refusal's status
and every op's outcome in the body, so a 4xx there is the answer rather than a failed call. A source
must resolve among the owner's own records, and a quote must be a substring of the record it cites
(`WIKI_SOURCE_UNRESOLVED`, `WIKI_QUOTE_NOT_FOUND`).

The wiki is switched on per account by the server's rollout flag. A session spawned with it off
(`ORBIT_WIKI=off`) is offered neither these commands nor the tools, and a server that has the wiki
off answers `404 WIKI_DISABLED` — which this binary reports as the wiki being off, not as a missing
entry. A runner newer than the server it talks to says in words that the server has no wiki door
rather than reporting a bare 404.

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
runner credential. A token has explicit scopes, an expiry, and—when it can create sessions—a workspace pin.
The destructive lifecycle verbs are not service-token scopes.

```bash
orbit token mint \
  --scope session:create,session:get \
  --workspace-id <workspace-id> \
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
