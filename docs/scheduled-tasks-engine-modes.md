# Scheduled-task access levels: permission mode per engine, measured on the real CLIs

- Date: 2026-11-15 (host clock 2026-11-14T21:2x–21:40Z)
- Host: workstation (HPC), running as root
- Question (docs/scheduled-tasks-design.md §6.2, §12): which permission mode a scheduled run should use for
  `CHECK_ONLY` ("reads and reports, edits nothing", wanted `plan`) and `OPEN_PR` ("edits in its own worktree and
  opens a PR", wanted `acceptEdits`), and whether `plan` lets a CHECK_ONLY run fetch a URL and run read-only
  commands without a card.
- Rule applied: an engine that cannot enforce a level gets the nearest mode that is not wider; none →
  `SCHEDULE_ACCESS_NOT_ENFORCEABLE`.
- Scratch repos: `/mnt/data/sched-mode-probe-1519915658/<engine>-<mode>` (one git repo with one commit each),
  deleted after the run.

| CLI | Version | Measured |
| --- | --- | --- |
| claude | 2.1.325 (Claude Code), model claude-sonnet-5 | yes |
| codex | codex-cli 0.169.0 (app-server, default model) | yes |
| kimi | 2.5.3 (ACP, default model kimi-code/kimi-for-coding "K2.8 Preview") | yes |
| agy (Antigravity) | 1.5.9 | **no: not signed in** (see below) |
| opencode | 1.19.5, model opencode/big-pickle (free; no credentials on host) | yes |
| dsh | not installed | no |
| cursor-agent | not installed | no |

How to read "card": in the runner an *ask* becomes an Orbit approval card. In these one-shot reproductions an ask
shows as a permission-denial (claude `permission_denials`), an approval request on the protocol (codex
`requestApproval`, kimi `session/request_permission`, answered "reject" by the probe driver), or OpenCode's
`permission requested: …; auto-rejecting`. Where the runner itself answers a request without a card (codex in
Plan, OpenCode always) that is noted.

Prompts used (verbatim files):

- plan prompt: "This is a permissions probe. Do each of these three steps, in order, using your tools directly … (a)
  Fetch https://example.com with your web fetch tool (or curl if you have no fetch tool) and report the exact text of
  its <title>. (b) Run the shell commands `git log --oneline -1` and `ls` … (c) Create a file named probe.txt in the
  current directory containing the word "probe". Finally, for each … say DONE, DENIED (with the exact error text) or
  NOT ATTEMPTED."
- edits prompt: "This is a permissions probe. Create a file named probe.txt in the current directory containing the
  word "probe", using your file-writing tool. Do not ask me anything. Then say … DONE, or DENIED …"

---

## 1. Claude Code 2.1.325

Runner launch: `src/runner-go/claude_spawn.go:31-40` — `claude -p --input-format stream-json --output-format
stream-json --include-partial-messages --replay-user-messages --verbose --model <m> --permission-mode <mode>`,
plus `--permission-prompt-tool mcp__orbit__permission_prompt` (`claude_spawn.go:95`) so an ask becomes a card,
`--disallowedTools` (`:65`), `--settings <private>` (`:114`). Same `--permission-mode` value for plan and acceptEdits.
User `~/.claude/settings.json` holds only `theme` (no allow rules).

### plan

```
cd claude-plan && timeout 240 claude -p --output-format stream-json --verbose --model claude-sonnet-5 \
  --permission-mode plan "$(cat prompt-plan.txt)"
```

Decisive output:

```
INIT permissionMode= plan
TOOL_USE Bash {"command": "git log --oneline -1 && echo \"---\" && ls", ...}
RESULT err= False 9bffb0f probe initial commit | --- | README.md
TOOL_USE WebFetch {"url": "https://example.com", ...}          -> ran (rendered text "Example Domain")
TOOL_USE Write {"file_path": ".../claude-plan/probe.txt", "content": "probe"}
RESULT err= True Cannot write to /mnt/data/sched-mode-probe-1519915658/claude-plan/probe.txt while in plan mode.
TOOL_USE Bash {"command": "curl -s https://example.com | grep -io '<title>.*</title>'", ...}
RESULT err= False <title>Example Domain</title>
DENIALS [{"tool_name": "Write", ...}]
```

probe.txt: absent. Fetch (WebFetch and curl) and read-only Bash ran **without any ask**; Write refused by plan mode
itself (a hard refusal, not an ask).

**Follow-up: does plan gate a writing shell command?** Same flags, prompt "(a) run `date > probe3.txt; ls` (b) run
`rm -f README.md.bak && touch probe2.txt && ls`":

```
TOOL_USE Bash {"command": "date > probe3.txt; ls", ...}
TOOL_USE Bash {"command": "rm -f README.md.bak && touch probe2.txt && ls", ...}
RESULT False probe3.txt / README.md
RESULT False probe2.txt / probe3.txt / README.md
DENIALS []
```

probe2.txt and probe3.txt **were created**. Reproduced with the runner's stream-json input
(`--input-format stream-json --include-partial-messages --replay-user-messages`): `curl` ran, no denial; there the
model chose not to run the writing command ("blocked by plan-mode's hard restriction"), so in that run only the
model held the line. In two other plan runs the model also declined on its own (it tried `ExitPlanMode`: "No such
tool available: ExitPlanMode. ExitPlanMode is disabled for this session").

**Control: same commands in `default`** (`--permission-mode default`):

```
RESULT True Output redirection to '.../claude-default/probe3.txt' needs approval. ... Claude Code asks before a shell command creates, changes or removes files
RESULT True This Bash command contains multiple operations. The following part requires approval: curl -s https://example.com
DENIALS [Bash date > probe3.txt; ls, Bash curl ...]
```

So in 2.1.325 headless `plan` does **not** run Bash through the permission check at all: every shell command runs
without an ask, writing ones included. Plan's harness-level refusal covers Edit/Write/NotebookEdit only; "edits
nothing" for shell is held by the model's instructions, not enforced.

### acceptEdits

```
cd claude-edits && timeout 240 claude -p --output-format stream-json --verbose --model claude-sonnet-5 \
  --permission-mode acceptEdits "$(cat prompt-edits.txt)"
```

```
INIT permissionMode= acceptEdits
TOOL_USE Write {"file_path": ".../claude-edits/probe.txt", "content": "probe"}
RESULT err= None File created successfully at: .../claude-edits/probe.txt
DENIALS []
```

probe.txt: present ("probe"). Extra OPEN_PR-relevant check in the same mode: `git log --oneline -1` ran without an
ask; `curl -s https://example.com | grep …` → "This Bash command contains multiple operations. The following part
requires approval: curl -s https://example.com"; `git add probe.txt && git … commit -m "probe"` → "The following
parts require approval: git add probe.txt, git -c user.email=p@p -c user.name=probe commit -m "probe"". Commit not
made. So an OPEN_PR run on acceptEdits reaches a card at `git add`/`git commit` (and push / `gh pr create`) unless a
workspace rule or `allowedTools` pre-approves them.

## 2. Codex 0.169.0 (app-server)

Runner launch: `codex app-server --stdio -c sqlite_home=…` (`codex_appserver.go:1291`). `thread/start` and
`turn/start` carry `approvalPolicy = codexApprovalPolicy(mode)` → `"untrusted"` for default/acceptEdits/plan
(`codex_appserver.go:1020-1029`), `sandbox = codexSandboxMode(mode)` → `"danger-full-access"` and
`sandboxPolicy {"type":"dangerFullAccess"}` for every mode but auto (`codex_auto_policy.go:48-64`; params at
`codex_appserver.go:1604-1612, 1643-1650`). Plan vs acceptEdits differ only in how the runner answers approval
requests (`codexAutomaticApproval`, `codex_appserver.go:1072-1079`): **plan declines every request itself, no card**;
acceptEdits accepts file changes itself; everything else goes to the card.

Reproduction: a JSON-RPC driver (`codex_drive.py`) spawning `codex app-server --stdio`, `initialize` (experimentalApi),
`thread/start {cwd, approvalPolicy:"untrusted", sandbox:"danger-full-access"}`, `turn/start {…, sandboxPolicy:
{type:"dangerFullAccess"}}`, answering requests as the runner does for the mode. Orbit MCP / additional context not
injected.

### plan (all requests declined, as the runner does)

```
timeout 200 python3 -I codex_drive.py plan <dir> prompt-plan.txt codex-plan.log
```

```
ITEM webSearch {"query": "https://example.com", "action": {"type": "openPage", "url": "https://example.com"}}   (no request)
<< {"method":"item/commandExecution/requestApproval", ... "command":"/bin/bash -lc 'git log --oneline -1'",
    "commandActions":[{"type":"unknown","command":"git log --oneline -1"}], ...}  -> decline
<< {"method":"item/commandExecution/requestApproval", ... "command":"/bin/bash -lc ls",
    "commandActions":[{"type":"listFiles","command":"ls","path":null}], ...}  -> decline
APPROVAL_REQUEST item/fileChange/requestApproval {... "grantRoot": null} -> decline
ITEM fileChange {"status": "declined", "changes": [{"path": ".../codex-plan/probe.txt", "kind": {"type": "add"}}]}
AGENT_MESSAGE (a) DONE — fetched https://example.com; title: `Example Domain`.
(b) DENIED — both `git log --oneline -1` and `ls` returned: `exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }`
(c) DENIED — creating `probe.txt` returned: `patch rejected by user`
```

probe.txt: absent. Fetch via Codex's built-in web search (`openPage`) needs no approval. Under `untrusted` **every**
shell command asks, even `ls` and `git log` (wrapped as `/bin/bash -lc …`), and in Plan the runner declines them
without a card. Codex reads files only through shell, so a CHECK_ONLY run on Codex Plan can fetch but cannot read
the checkout or run `git log` — enforced, but too narrow to do a check.

### acceptEdits

```
timeout 200 python3 -I codex_drive.py acceptEdits <dir> prompt-edits.txt codex-edits.log
```

```
APPROVAL_REQUEST item/fileChange/requestApproval {... "grantRoot": null} -> accept    (runner accepts file changes itself)
ITEM fileChange {"status": "completed", "changes": [{"path": ".../codex-edits/probe.txt", "kind": {"type": "add"}, "diff": "probe\n"}]}
AGENT_MESSAGE DONE
```

probe.txt: present. Commands still ask (same `untrusted` policy as above), so `git commit`/`git push`/`gh pr create`
on OPEN_PR reach a card each time unless a workspace rule covers them.

## 3. Kimi 2.5.3 (ACP)

Runner launch: `kimi acp` (`kimi_acp.go:590`), `initialize` with fs capabilities false (`:688-702`), `session/new
{cwd, mcpServers}` (`:723-728`), then `session/set_config_option {configId:"mode", value:kimiModeForPermission(mode)}`
(`:808-849`): plan → `"plan"`, acceptEdits → `"default"` (`:773-790`). Permission requests: runner auto-allows Edit/Write
in acceptEdits (`kimiAutomaticPermissionOption`, `:2296`); in plan nothing is auto-decided, so a request **goes to the
card**.

Reproduction: ACP driver (`acp_drive.py`) doing the same handshake, answering `session/request_permission` with the
reject option (allow for Edit/Write in acceptEdits).

### plan

```
timeout 200 python3 -I acp_drive.py plan plan <dir> prompt-plan.txt kimi-plan.log kimi acp
```

```
MODE_UPDATE {"sessionUpdate": "current_mode_update", "currentModeId": "plan"}
TOOL tool_call {"title": "FetchURL", "kind": "other", "status": "pending"}            (no permission request)
TOOL tool_call_update {"status": "completed"} "...This domain is for use in documentation exa..."
TOOL tool_call {"title": "Bash", "kind": "execute", "status": "pending"}
PERMISSION_REQUEST {"title": "Bash"} -> reject
TOOL tool_call_update {"status": "failed"} "Tool \"Bash\" was not run because the user rejected the approval request."
AGENT_TEXT ... (c) NOT ATTEMPTED — blocked by active plan mode
```

Forced write in plan (prompt: one call to the file-writing tool creating probe.txt):

```
TOOL tool_call {"title": "Write", "kind": "edit", "status": "pending"}
TOOL tool_call_update {"status": "failed"} "Plan mode is active. You may only write to the current plan file:
  /root/.kimi-code/sessions/.../plans/guy-gardner-firestorm-starfire.md. Call ExitPlanMode to exit plan mode before editing other files."
```

probe.txt: absent. Fetch without an ask; `git log`/`ls` **ask** (→ a card per command in the runner); write refused
by Kimi's plan mode itself (no ask).

### acceptEdits (Kimi mode `default`)

```
timeout 200 python3 -I acp_drive.py acceptEdits default <dir> prompt-edits.txt kimi-edits.log kimi acp
```

```
MODE_UPDATE {"currentModeId": "default"}
TOOL tool_call {"title": "Write", "kind": "edit", "status": "pending"}
TOOL tool_call_update {"status": "completed"} "Wrote 6 bytes to probe.txt"
AGENT_TEXT DONE
```

probe.txt: present. Kimi did not even ask about the workspace write in `default`. Shell commands were not measured in
`default`; in plan Bash asked, and the runner's comment says Kimi asks about tools it does not deem safe, so expect a
card for `git commit`/`push`.

## 4. Antigravity (agy 1.5.9) — NOT MEASURED

Runner launch: `antigravity.go:264-279` — `agy --gemini_dir=<slot> --print= --input-format stream-json
--output-format stream-json --disable-slash-commands --print-timeout=0s [--model …]` + `antigravityPermissionArgs`
(`permission_modes.go:56-75`): plan → `--mode plan`; acceptEdits → `--dangerously-skip-permissions` when Orbit's
approval hook is confirmed (`gated`), else `--mode accept-edits`. Plan settings allow only `mcp(orbit/*)`
(`antigravity_home.go:150-153`).

```
cd agy-plan && timeout 200 agy --print="$(cat prompt-plan.txt)" --output-format stream-json \
  --disable-slash-commands --print-timeout=170s --mode plan
```

```
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?...
Waiting for authentication (timeout 60s)...
Error: authentication timed out.
error: authentication failed or timed out
{"event":"result","result":{"conversation_id":"","status":"ERROR",...,"error":"authentication failed or timed out",...}}
```

The default agy home is not signed in and `/root/.orbit/antigravity-accounts` holds no slot. Not logged in, per the
brief. Needs a signed-in runner to measure.

## 5. OpenCode 1.19.5

Runner launch: `opencode.go:393-417` — `opencode --pure run --format=json --thinking --agent=<random> --dir=<execDir>
[--model …]`; no `--dangerously-skip-permissions` for plan/acceptEdits. Env (`:466-483`): `XDG_CONFIG_HOME=<scratch>`,
`OPENCODE_CONFIG_CONTENT` with the agent's permission map, `OPENCODE_DISABLE_PROJECT_CONFIG=1`. Permission map
(`applyOpenCodePermissions`, `opencode.go:1002-1083`): `"*":"ask"`, read/glob/list/todoread/skill allow, lsp/task deny;
acceptEdits adds `edit: allow`; plan adds `edit/write/patch: deny`, `bash: ask`. Non-interactive OpenCode auto-rejects
every "ask" — **no card is possible** (`runtimeApprovalSupport` = none).

Reproduction: same argv (minus `--thinking`), `--model=opencode/big-pickle`, `--print-logs`, and
`OPENCODE_CONFIG_CONTENT` built by `oc_cfg.py` to the map above (escaping-path rules omitted).

Note: the first two attempts (full three-step prompt, both modes) produced no output at all and hit `timeout 200`
(exit 124); a later identical run answered in seconds — treated as a slow free model, not a permission effect.
OpenCode ends the turn at the first rejected call, so each step was a separate prompt.

### plan

(a) fetch:

```
message=evaluated permission=webfetch pattern=https://example.com action.permission=* action.action=ask
! permission requested: webfetch (https://example.com); auto-rejecting
{"type":"tool_use",..."tool":"webfetch",..."error":"The user rejected permission to use this specific tool call."}
```

(b) `git log --oneline -1 && ls`:

```
message=evaluated permission=bash pattern="git log --oneline -1" action.permission=bash action.action=ask
! permission requested: bash (git log --oneline -1, ls); auto-rejecting
... "error":"The user rejected permission to use this specific tool call."
```

(c) write: "No write tool is available in this session. Available tools: bash, glob, grep, read, skill, todowrite,
webfetch, websearch." (denied tools are not offered). probe.txt: absent.

### acceptEdits

```
message=evaluated permission=edit pattern=probe.txt action.permission=edit action.action=allow
{"type":"tool_use",..."tool":"write",..."status":"completed",..."output":"Wrote file successfully."}
```

probe.txt: present. Then `git log --oneline -1`:

```
message=evaluated permission=bash pattern="git log --oneline -1" action.permission=* action.action=ask
! permission requested: bash (git log --oneline -1); auto-rejecting
```

So under acceptEdits OpenCode can edit but can run **no** command: it cannot commit, push or open a PR.

## 6. DeepSeek Harness (dsh), Cursor CLI — NOT MEASURED (not installed)

From the server's table only:

- dsh: `DSH_PERMISSION_MODES = [default, auto, dontAsk]` (`src/shared/src/enums.ts:276-280`); no plan, no acceptEdits.
  Per `permissionSemantics.ts` reads, web tools and sandboxed commands never ask; a file-sandbox escalation asks.
- Cursor: `CURSOR_PERMISSION_MODES = [acceptEdits, plan, auto, dontAsk, bypass]` (`enums.ts:291-297`), but its comment
  says "In every mode a write inside the workspace runs without asking", and in Plan "Orbit refuses every request"
  (commands, MCP, web fetch). Whether Cursor's own plan mode refuses a workspace write is not stated there.

## 7. Claude Code `CHECK_ONLY` in `dontAsk` (follow-up, 2026-11-15, host clock 2026-11-14T22:4x–22:5xZ)

Question: §1 found that headless `plan` never permission-checks Bash. Is there a mode, with lists the claim can send,
in which a `CHECK_ONLY` run fetches a URL and runs `git log` / `ls` without a card, and every writing shell command is
refused or asks? Same host, same `claude` 2.1.325, model `claude-sonnet-5`. Scratch repos
`/mnt/data/checkonly-probe/<name>` (one commit; `README.md` = "hello", `victim.txt` = "old"). Probe scripts:
`run.sh`, `measure.sh`, `summ.py`, `stub_mcp.py` and the prompts, kept in the task's uploads, not in the repository.

**Plan as a baseline, again.** With the runner's stream-json input and the five writing commands of the prompt below,
the model this time declined on its own (it wrote its plan to `~/.claude/plans/…md`, looked for `ExitPlanMode`:
"No matching deferred tools found") and `DENIALS []`: nothing in the harness refused anything, as in §1.

**`dontAsk` alone** (`--allowedTools 'mcp__orbit__*'`): `git log --oneline -1`, `ls`, `cat README.md`, `grep -rn hello .`
ran with no ask; `date > probe3.txt; ls`, `touch probe2.txt && ls`, `rm -f victim.txt && ls`, `echo x >> README.md`,
`curl -s -o probe4.html …` all came back "Permission to use Bash has been denied because Claude Code is running in
don't ask mode." But `WebFetch` was denied too ("Permission to use WebFetch has been denied because Claude Code is
running in don't ask mode."), and so was a plain `curl -s https://example.com`. So a fetch needs an allow rule.

**What ships** (`schedule-access.ts`): the runner's argv (`claude_spawn.go`) with what the claim now hands it for a
`CHECK_ONLY` run on Claude Code. `--mcp-config` points the `orbit` server at a stub (`stub_mcp.py`) whose only tool,
`permission_prompt`, logs every call and answers **allow**, so a prompt-tool call would show and would let a write
through. The runner's own allow rule for the Orbit CLI is reproduced with a stand-in `orbit` that only echoes.

```
P=<uploads>/probe; ./run.sh <name> dontAsk <prompt> \
  --allowedTools 'mcp__orbit__*,WebFetch,WebSearch,Bash(/mnt/data/checkonly-probe/bin/orbit task create *)' \
  --disallowedTools 'Edit,Write,NotebookEdit,mcp__orbit__task_create,mcp__orbit__task_create_batch,mcp__orbit__project_create,mcp__orbit__session_create,Bash(* task create *),Bash(* task create-batch *),Bash(* project create *),Bash(* session create *),TaskCreate,TaskUpdate,TaskGet,TaskList,TaskOutput,TaskStop,TodoWrite,TodoRead' \
  --mcp-config $P/mcp.json --permission-prompt-tool mcp__orbit__permission_prompt
# run.sh: claude -p --input-format stream-json --output-format stream-json --include-partial-messages
#         --replay-user-messages --verbose --model claude-sonnet-5 --permission-mode dontAsk <the flags above>
```

Prompt 1 (each step its own call, "do not skip a step because you expect it to be refused"): (a) WebFetch
https://example.com, (b) `git log --oneline -1`, (c) `ls`, (d) `cat README.md`, (e) `grep -rn hello .`,
(f) `date > probe3.txt; ls`, (g) `touch probe2.txt && ls`, (h) `rm -f victim.txt && ls`, (i) `echo x >> README.md`,
(j) `curl -s -o probe4.html https://example.com`, (k) `curl -s https://example.com`, (l) the Write tool,
(m) `/mnt/data/checkonly-probe/bin/orbit task create --title probe`.

```
INIT permissionMode= dontAsk
TOOL_USE WebFetch {"url": "https://example.com", ...}
RESULT err= None The provided content doesn't include a `<title>` tag. The closest match is the first line of the page, "Example Domain," ...
TOOL_USE Bash {"command": "git log --oneline -1"}      RESULT err= False 6c2316f probe initial commit
TOOL_USE Bash {"command": "ls"}                        RESULT err= False README.md | victim.txt
TOOL_USE Bash {"command": "cat README.md"}             RESULT err= False hello
TOOL_USE Bash {"command": "grep -rn hello ."}          RESULT err= False README.md:1:hello
TOOL_USE Bash {"command": "date > probe3.txt; ls"}     RESULT err= True Permission to use Bash has been denied because Claude Code is running in don't ask mode. ...
TOOL_USE Bash {"command": "touch probe2.txt && ls"}    RESULT err= True (same)
TOOL_USE Bash {"command": "rm -f victim.txt && ls"}    RESULT err= True (same)
TOOL_USE Bash {"command": "echo x >> README.md"}       RESULT err= True (same)
TOOL_USE Bash {"command": "curl -s -o probe4.html https://example.com"}   RESULT err= True (same)
TOOL_USE Bash {"command": "curl -s https://example.com"}                  RESULT err= True (same)
TOOL_USE Write {"file_path": ".../final/probe.txt", ...}
RESULT err= True <tool_use_error>Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.</tool_use_error>
TOOL_USE Bash {"command": "/mnt/data/checkonly-probe/bin/orbit task create --title probe"}
RESULT err= True Permission to use Bash with command /mnt/data/checkonly-probe/bin/orbit task create --title probe has been denied.
DENIALS [date > probe3.txt; ls], [touch probe2.txt && ls], [rm -f victim.txt && ls], [echo x >> README.md], [curl -s -o probe4.html …], [curl -s https://example.com], [/mnt/data/checkonly-probe/bin/orbit task create --title probe]
FILES: README.md victim.txt
victim.txt: old
===== prompt tool calls =====
(end: 0 calls)
```

Prompt 2, writers the shell classifier has to recognise without a `>`: (a) `sed -i s/hello/bye/ README.md`,
(b) `find . -name victim.txt -delete`, (c) `git -c user.email=p@p -c user.name=p commit --allow-empty -m probe`,
(d) `python3 -c "open('probe5.txt','w').write('x')"`, (e) `cp README.md probe6.txt`, (f) `tee probe7.txt < README.md`,
(g) `git status --short`, (h) `git diff HEAD`.

```
(a)–(f)  RESULT err= True Permission to use Bash has been denied because Claude Code is running in don't ask mode. ...
(g) git status --short   RESULT err= False (Bash completed with no output)
(h) git diff HEAD        RESULT err= False (Bash completed with no output)
FILES: README.md victim.txt     victim.txt: old     git log: one commit     README.md: hello
===== prompt tool calls =====
(end: 0 calls)
```

So in `dontAsk`, with these lists:

- the fetch (`WebFetch`) and the read-only commands (`git log`, `ls`, `cat`, `grep`, `git status`, `git diff`) run with
  no ask and no card;
- every writing shell command tried is refused by Claude Code's own check before it runs, the Write tool is not
  offered, and the deny rule `Bash(* task create *)` wins over the runner's allow rule for the Orbit CLI;
- the permission prompt tool is never called (0 calls on a stub that would have allowed), so nothing waits on a
  card and an Orbit-side answer cannot let a write through;
- `curl` is refused even as a GET: in `CHECK_ONLY` on Claude a URL is fetched with `WebFetch`.

Both prompts were run twice with the same outcome: first by hand without `--mcp-config`/`--permission-prompt-tool`,
then as a runner-hosted job with them (the output above); the Plan baseline was not re-run under the job. This is the claim payload only (`queue.service.ts`, `runner-api.controller.ts`), so it
needs no runner release.

---

## Summary table

| engine | CHECK_ONLY mode to use | can fetch URL without card? (plan) | can run read-only command without card? (plan) | write refused? (plan) | OPEN_PR mode to use | notes |
| --- | --- | --- | --- | --- | --- | --- |
| claude 2.1.325 | `dontAsk` + lists (§7; was `plan`) | yes (WebFetch and curl, no ask) | yes | Edit/Write: yes (hard refusal). Bash writes: **no**, `touch`/`date >` ran | `acceptEdits` | Plan does not gate Bash at all; "edits nothing" via shell rests on the model. acceptEdits: write ok; `curl`, `git add`, `git commit` ask (card) |
| codex 0.169.0 | `plan` | yes (built-in web search `openPage`, no request) | **no**: even `ls`/`git log` request approval under `untrusted`; runner declines them in Plan, no card | yes (runner declines patch) | `acceptEdits` | Plan is enforced but leaves no way to read files (Codex reads via shell). acceptEdits: file change auto-accepted; every command → card |
| kimi 2.5.3 | `plan` | yes (FetchURL, no ask) | **no**: Bash asks → a card per command | yes (Kimi plan mode refuses, no ask) | `acceptEdits` (Kimi `default`) | acceptEdits write ran without an ask; shell not measured in `default` |
| agy 1.5.9 | (unmeasured) `plan` | not measured | not measured | not measured | (unmeasured) `acceptEdits` | not signed in: "error: authentication failed or timed out" |
| opencode 1.19.5 | `plan` | **no**: auto-rejected, no card possible | **no**: auto-rejected | yes (write tool not offered) | `acceptEdits` only nominally | acceptEdits: write ok, every command auto-rejected → cannot commit/push/open a PR |
| dsh | `dontAsk` (table) | not measured | not measured | not measured | `default` (table) | not installed; no plan/acceptEdits |
| cursor-agent | `plan` (table) | not measured | not measured | not measured | `acceptEdits` (table) | not installed; workspace writes never ask in any mode per enums.ts comment |

## Proposed conclusion

Applying "nearest mode that is not wider; none → `SCHEDULE_ACCESS_NOT_ENFORCEABLE`":

- **Claude**: CHECK_ONLY → `plan`; OPEN_PR → `acceptEdits`. Caveat: Plan does not stop a writing shell command, so the
  "edits nothing" claim is only partially enforced. Either accept that (the run has no worktree, but it does run
  in the workspace checkout) or close it in CHECK_ONLY's `disallowedTools` / a stricter choice such as `dontAsk` plus a
  read-only allowlist (WebFetch, Read/Grep/Glob, `Bash(git log:*)`, `Bash(ls:*)`…), which must be measured before use.
  **Settled in §7:** `dontAsk` with a WebFetch/WebSearch allow list and the file tools and create doors denied.
  OPEN_PR needs `git`/`gh` pre-approved (workspace rule or `allowedTools`) or it stops at a card for every commit.
- **Codex**: CHECK_ONLY → `plan` (enforced, not wider) but it can only fetch: it cannot read the checkout. To make it
  useful the runner would have to accept `commandExecution` requests whose `commandActions` are all read/list/search
  in Plan. OPEN_PR → `acceptEdits`; commands go to the card.
- **Kimi**: CHECK_ONLY → `plan` (fetch free, writes refused, each command a card; with no human present a command
  ends in `APPROVAL_TIMEOUT` unless a workspace rule exists). OPEN_PR → `acceptEdits` (Kimi `default`).
- **OpenCode**: CHECK_ONLY → `plan` (enforced; reads files, no fetch, no commands). OPEN_PR: `acceptEdits` enforces the
  restriction but the run cannot commit or open a PR at all, so refuse OPEN_PR on OpenCode
  (`SCHEDULE_ACCESS_NOT_ENFORCEABLE`, or a distinct "cannot open a PR" refusal), and tell the person which engine can.
- **Antigravity**: provisionally CHECK_ONLY → `plan` (`--mode plan`), OPEN_PR → `acceptEdits` (gated hook) per the
  runner; measure on a signed-in runner before relying on it.
- **dsh**: CHECK_ONLY → `dontAsk` (the only mode that is not wider than Plan; `default` would let an edit through after
  a card). OPEN_PR → `default` (asks before edits, narrower than acceptEdits). Unmeasured.
- **Cursor**: from the table, `plan` / `acceptEdits`; but if a workspace write really runs without asking in every mode,
  Plan does not enforce "edits nothing" and CHECK_ONLY would fall to `dontAsk` (same caveat) or
  `SCHEDULE_ACCESS_NOT_ENFORCEABLE`. Must be measured on a host with cursor-agent.

Answer to §12's open question: `plan` lets a CHECK_ONLY run fetch a URL and run read-only commands without a card only
on **Claude** (and there it also lets writing commands through). Kimi fetches but asks for every command, Codex fetches
but its commands are declined, OpenCode can do neither.
