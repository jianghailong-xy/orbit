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

To create a task with existing uploaded Orbit attachments, pass their IDs:

```bash
orbit task create --title "Review screenshots" --completion-criterion EVIDENCE_JUDGMENT \
  --attachment-id '<attachment-id>,<attachment-id>' --json
```

`--attachment-id` is optional and repeatable. Attachments must belong to your account; they are copied
into the new task's inputs, preserving the originals. Batch task JSON and the MCP tools `task_create`
and `task_create_batch` accept the optional `attachmentIds` array on each task.

Inside a task-backed Orbit session, task commands may omit the task ID and use `ORBIT_TASK_ID`. In-session
CLI mutations are attributed to the current agent and session. Headless mutations that use only a runner
credential fall back to the runner owner.

### Reviewing a confirmation request

When a run of an `OWNER_CONFIRMED` task declares its work finished (`orbit task request-confirmation`), Orbit
hands the request to the task's reviewer first — the project's coordinator conversation, or outside a project
the session the task was filed from — as an `<orbit-confirmation-review>` block, and the owner is not asked
until the review is in or its window runs out (`docs/owner-confirmation-review-contract.md`). The reviewer
answers with one of:

```bash
orbit task confirmation-review --input-file - --json <<'EOF'
{"taskId": "<task>", "requestId": "<request-id>", "reviewedSha": "<sha>", "judgment": "Ready; one call for you.",
 "checked": [{"text": "suite passes", "evidenceRefs": ["<ci run>"]}], "notChecked": [], "leftOpen": [],
 "needsYou": [{"text": "Ship it behind the flag?", "options": [{"label": "Yes"}, {"label": "No"}], "recommendedOption": 0}]}
EOF
orbit task confirmation-return --input '{"taskId": "<task>", "requestId": "<request-id>", "reason": "…", "problems": [{"text": "…"}]}'
```

Both take the whole input as one JSON object (`--input JSON` or `--input-file -`), name the task the block
names rather than `ORBIT_TASK_ID`, and are accepted only from the session the request was handed to, inside a
turn. Neither confirms anything: only the owner does, in the app. A return sends the reason to the run as its
next message without asking the owner; after the owner has confirmed, it records the problems under their
receipt and tells them instead.

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

A session can ask another for a reply. The send still returns at once, with `requestId` and `replyBy`; the
outcome — the answer, or why there is none (`NO_REPLY`, `RECIPIENT_ENDED`, `EXPIRED`, `UNDELIVERED`) — comes
back to the asking session later as a turn of its own, exactly once. The session that was asked answers with
`orbit session reply` (the MCP tool is `session_reply`), using the `request-id` its message arrived with:

```bash
orbit session send <session-id> --message "Merge now or wait for review?" --expect-reply \
  --reply-options '[{"label":"merge now"},{"label":"wait","description":"until review"}]' \
  --reply-within-seconds 3600 --json
orbit session reply <request-id> --option 1 --message "the reviewer is back at 3" --json
```

`orbit project send <project-id> --expect-reply` asks the project's coordinator the same way; the request
stays with the coordinator conversation it was delivered to. Requests need a calling session — a reply needs a
conversation to come back to — so the headless runner credential cannot make one.

`--agent-name` selects the Orbit agent (project directory and runner configuration) that should execute the
session. Check `orbit capabilities --json` instead of assuming a session operation is authorized.

Creating sessions and using lifecycle operations requires a live caller session while its account has
Session orchestration on (one switch for every workspace, on unless the owner turns it off in Settings). The
runner receives a short-lived, session-bound proof. Every request rechecks the live session assignment and that
switch, so ending, deleting, reassigning, or turning orchestration off revokes access without waiting for proof
expiry. When orchestration is on, `orbit agent list`, `agent create`, and `agent update` expose the same
agent-management surface to the CLI. Only a human can switch orchestration.

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

## Personal access tokens

A personal access token lets a script or a terminal act as **you**: it calls the REST API the web app uses
(`/api/...`), and what it writes is recorded as yours. `orbit login` gets one through the browser; or issue one
in Orbit under **Settings → Access tokens**, with the scopes it needs (read-only, read-write, or a custom set),
optionally the workspaces it is confined to, and a lifetime of 30, 90 or 365 days, or none. The token is shown
once.

```bash
orbit login                                   # approve in the browser; add --server https://orbit.example.com on a new machine
orbit login --scopes read-write --expires 30d --name "deploy box"
orbit login --with-token < token.txt          # a token issued under Settings → Access tokens
orbit whoami
orbit api /api/tasks
orbit api -X POST /api/tasks --data-file - < task.json
orbit api /api/tasks/page --paginate --json
orbit logout                                  # revokes the token, then forgets it
```

- `orbit login` asks the server for a token and opens `<server>/cli-login?code=…`. Signed in to Orbit there,
  you see the token's name, scopes, lifetime and the host asking, and approve or deny it. The CLI waits up to
  ten minutes, then saves the token it is handed. `--name` defaults to `orbit CLI on <host>`, `--scopes` to
  `read-only` (or `read-write`, or a list such as `tasks:read,tasks:write`), and `--expires` to `90d` (`30d`,
  `365d` or `never`). The token belongs to the account that approved it. The server keeps only its hash, and
  the token itself is in the one answer the CLI collects.
- `orbit login --with-token` reads an issued token from stdin only, so it never sits in an argument list or a
  shell history.
- Either way the CLI checks the token with the server and saves it, with the server's URL, in
  `$ORBIT_HOME/user.json` (`~/.orbit/user.json`, mode `0600` in a `0700` directory). The file is separate from
  the runner's `config.json`, and the runner service never reads it. A machine needs no runner to log in.
- `ORBIT_USER_TOKEN` takes precedence over a saved login, for CI and containers. It is sent to
  `ORBIT_SERVER_URL`, or else to this machine's runner server, or else to the server the binary was built for.
- `orbit api [-X METHOD] PATH [--data JSON | --data-file -] [--paginate] [--json]` sends one request under
  `/api` on the token's own server and prints the answer, indented (or compact with `--json`). It exits
  non-zero on anything but 2xx, after printing the answer. `--paginate` follows `nextCursor`, as
  `/api/tasks/page` answers, and prints every page. PATH can be a path only, never a URL.
- `orbit logout` revokes the token on the server and removes `user.json`; when the server cannot be reached
  it removes nothing. `--keep-token` only removes the file.
- A 401 means the token is invalid, revoked or expired; the server does not say which. Run `orbit login`
  again.
- No scope opens the owner's own decisions (confirmation cards, evidence verdicts, approvals, starting or
  finishing a project), the account, administration, or the access tokens themselves. Those stay in the app.

### Which identity a command acts as

The first of these that is present decides. `orbit whoami` prints the identity and the rule that chose it, and
`orbit capabilities --json` carries the same answer as `identity`:

1. `ORBIT_SESSION_ID`: inside an Orbit session the CLI acts as that session. A personal access token on the
   machine is ignored there, and stderr says so once, so an agent never becomes you because somebody logged
   in on its machine.
2. `ORBIT_SERVICE_TOKEN`: a service token.
3. `ORBIT_USER_TOKEN`, or else the login saved in `user.json`: you. A process the runner started skips this
   rule (see [On a runner machine](#on-a-runner-machine)).
4. The runner credential in `config.json`: the machine.

`orbit api` acts only as you. So do the `task`, `project` and `session` commands while you are logged in: each one
whose user route answers it the way its runner route does calls that route with your token, on your server, and
prints the same JSON it prints as the runner. `orbit session list` and `orbit session get` read
`GET /api/sessions/compact` and `GET /api/sessions/:id/compact` for that. The rest are refused before anything is
read or sent, saying why and what to use instead: the ones that act for an Orbit session (`task evidence-decide`,
`request-confirmation`, `confirmation-review`, `confirmation-return` and `await`; `project ensure-coordinator`,
`send`, `request-start` and `request-done`; `session await` and `reply`), and the few whose user route answers
in another shape or not at all (`task batch-pin`, `session create`, `session import`). No command falls back to
the runner credential while you are logged in: the machine's other commands — `orbit task-list`, `orbit provider`,
`orbit notify`, `orbit token` and the rest — are refused too, so run them where you are not logged in.
`orbit capabilities --json` marks every command `available` or not under the identity in effect, with the reason.

Inside a session the session decides for every command, the session commands included: a service token in the
session's environment is not used there.

### Service token or personal access token?

Use a **service token** for an integration that belongs to this machine: a bridge or a cron job that drives the
sessions this runner hosts. Use a **personal access token** for anything that should act as **you**: creating
and updating tasks, reading projects, or working with sessions across your account, from this machine or any
other.

| | Service token | Personal access token |
| --- | --- | --- |
| Represents | An integration on this machine | You |
| Issued by | `orbit token mint`, with this machine's runner credential | You, under Settings → Access tokens |
| Reaches | `orbit session` get, list, send and create, for this runner's sessions; create is pinned to one workspace | The REST API under `/api`, within its scopes and optional workspaces |
| Lifetime | 24 hours by default, at most 90 days | 30, 90 or 365 days, or none |
| Revoked with | `orbit token revoke` | `orbit logout`, or Settings → Access tokens |

### On a runner machine

Logging in on a runner machine is supported, and no agent process is ever handed `ORBIT_USER_TOKEN`. But when
the runner service runs as the same OS user, every agent session it starts can read `user.json`: file
permissions do not separate the processes of one account. `orbit login` warns when that is the case. Do your
own scripting on that machine as a separate OS user, or give the token used there only the scopes it needs,
confine it to workspaces, and keep its lifetime short.

The commands the runner runs itself never act as you, even when you are logged in in its `ORBIT_HOME`. This
covers a task's EXECUTABLE acceptance command and a `!` command in a session. The runner marks the processes it
starts for its sessions (engines, shell commands, background jobs) with `ORBIT_RUNNER_CHILD=1`, and there the CLI
skips your login: such a process acts as its session if it has one, and otherwise as the machine. So
`orbit wiki check` and `orbit wiki plan check` still run as the runner, and `orbit whoami` there says why. A
terminal you open yourself has no such mark.

## Security notes

- The runner token in `~/.orbit/config.json` is a long-lived machine credential. Protect it with operating-
  system file permissions and never copy it into a repository or shared log.
- A service token should receive only the scopes and lifetime its integration needs.
- `~/.orbit/user.json` holds a personal access token that acts as you. Run `orbit logout` (or revoke the token
  under Settings → Access tokens) when a machine no longer needs it.
- The runner machine's OS account is the local trust boundary; sibling processes owned by that account are
  not isolated from each other.
- Capability output is contextual. Treat it as the source of truth after upgrades or credential changes.
- Prefer `--message-file` for untrusted or multiline input so shell interpolation does not change the content.
