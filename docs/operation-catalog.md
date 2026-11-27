# Orbit operation catalogue v1.12.0

> Generated from `src/runner-go/operation_catalog.go` — do not edit by hand.
> Content hash: `bf71fcf795fc37cb0c43f5869345629c8ab6ad6dc1ab75497f46dc5ee548c074`.

Every operation an Orbit agent can call is declared once in the operation catalogue. This table is that catalogue rendered for a person: `orbit capabilities --json` and the MCP `tools/list` payload are its two machine surfaces, and the leaf `--help` texts are held to it by tests. `MCP` and `CLI` say how each surface reaches the operation — `always`, an `orchestration` grant, an engine `permission_prompt` bridge, `session`-only, `headless`-only, or a `watch_switch`/`wiki_switch` — and `absent` when that surface deliberately has no door. Gates that must hold together are joined with `+` (for example `orchestration+watch_switch`). `Idempotency` is `read` (safe to repeat), `caller_key` (retry with the same key), `server_key` (a redelivered turn deduplicates) or `none` (re-read before retrying). `Plan` is what a session in Plan mode gets: the call `runs`, is `refused` with what to do instead, or its `own_gate` decides; the per-engine matrix is docs/permission-matrix.md.

## Reading it a piece at a time

`orbit capabilities --json` is the whole catalogue as one process is offered it, which is larger than any engine shows a model at once. An agent that wants one operation asks for less: `--summary` (one row per command, and the commands not offered here grouped under why), `--family NAME` (one family, each command with its absolute argv, approval, success evidence and a minimal example) or `--id ID` (one operation in full, both surfaces' examples included). The `guide` MCP tool and `orbit guide [TOPIC] --json` arrange the same rows by what a person asks for: without a topic they answer the objects and the intent routes, and with one its recipe. Guide 1.1.0 has these topics (a `?` marks an optional step):

| Topic | Routes | Steps | Intent |
| --- | --- | --- | --- |
| `task-create` | R1.1 | `task_list`? → `task_create` → `task_get`? | Record one piece of work the user wants kept, followed up or done later. |
| `task-batch` | R1.2 | `task_create_batch`? → `task_create_batch` → `task_list`? | Keep a plan that is already worked out: several tasks with their order and parts, in one call. |
| `project-create` | R1.3 | `project_create` → `task_create_batch`? | Record a whole body of work with its own goal and acceptance, coordinated from this conversation. |
| `task-start` | R1.4, R1.5 | `task_start` → `task_create`? → `task_await`? | Run work now: recorded work on its assignee, or new work created and started on one card. |
| `task-schedule` | R1.6 | `task_create` → `task_update`? | Have the server start work once, at a set time. |
| `delegate` | R1.7 | `session_create` → `session_await`? | Hand work that should run now to another agent as its own conversation. |
| `inspect` | R1.8 | `project_get`? → `task_get` → `task_list`? → `session_get`? | Read the state of a project, a task or a session before deciding anything. |
| `wait` | R1.9 | `task_await` → `session_await`? → `watch_create`? | Wait for Orbit work to finish without holding the turn open. |
| `wiki` | R1.10 | `wiki_search` → `wiki_get`? → `wiki_propose`? → `wiki_note`? | Find what is already known about a file or a pattern, and keep what you learned. |
| `files` | R1.11 | `file_upload` → `file_list`? → `file_fetch`? → `drive_put`? → `drive_get`? → `drive_list`? → `drive_move`? → `drive_delete`? → `drive_sync`? | Keep a screenshot, report or log in Orbit instead of the repository, or read one back. |
| `task-list` | R1.12 | `tasklist_list`? → `tasklist_create` → `tasklist_update`? | Give a class of work its own dispatch policy: a concurrency cap, a pause, standing instructions. |
| `agent` | R1.13 | `agent_list` → `agent_update`? → `agent_create`? | Choose where work runs and under which identity, or change an agent's defaults. |
| `finish-task` | — | `task_get` → `task_progress_report` → `bg_run`? → `task_evidence_submit` → `task_comment`? | Carry the task this session runs to its end: progress, checks and the evidence its criterion decides by. |

| Operation | Object | Risk | Writes | Approval | Destructive | Idempotency | Plan | MCP | CLI | Intent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `agent_create` | agent | high | yes | card (`orbit_agent_create`) | no | none | refused | orchestration | orchestration — `orbit agent create` | Create an agent: where and under which identity work runs. |
| `agent_delete` | agent | high | yes | card (`orbit_agent_delete`) | yes | none | refused | orchestration | orchestration — `orbit agent delete` | Delete an agent. |
| `agent_list` | agent | low | no | none | no | read | runs | orchestration | orchestration — `orbit agent list` | See the agents work can run under. |
| `agent_update` | agent | high | yes | card (`orbit_agent_update`) | no | none | refused | orchestration | orchestration — `orbit agent update` | Change an agent's defaults, location or environment. |
| `api` | account | high | yes | none | no | none | refused | absent | headless — `orbit api` | Call any user REST route with the person's own token. |
| `ask_owner` | owner | high | yes | owner | no | none | runs | always | absent | Ask the account owner a question. |
| `bg_kill` | background_job | high | yes | none | yes | none | refused | always | absent | Stop a background job. |
| `bg_list` | background_job | low | no | none | no | read | runs | always | absent | See this session's background jobs. |
| `bg_output` | background_job | low | no | none | no | read | runs | always | absent | Read a background job's output. |
| `bg_run` | background_job | high | yes | none | no | none | own_gate | always | absent | Run a command in the background on this runner. |
| `browser_clear_logins` | browser | high | yes | card (`orbit_browser_clear_logins`) | yes | none | refused | browser_switch | session+browser_switch — `orbit browser clear-logins` | Stop the account's Orbit Cloud browser and delete its saved logins, after the owner confirms. |
| `browser_open` | browser | low | no | none | no | read | runs | browser_switch | session+browser_switch — `orbit browser open` | Start the account's Orbit Cloud browser and get its tab's address, optionally opening a page in it. |
| `browser_request_sign_in` | browser | low | no | none | no | read | runs | browser_switch | session+browser_switch — `orbit browser request-sign-in` | Ask the account owner to sign in to a site in the Orbit Cloud runner's browser, and wait for their answer. |
| `browser_status` | browser | low | no | none | no | read | runs | browser_switch | session+browser_switch — `orbit browser status` | Read the state of the account's Orbit Cloud browser. |
| `condition_get` | schedule | low | no | none | no | read | runs | always | absent | Read a task's or a schedule's condition: its state, newest samples and events. |
| `criterion_check_report` | project | high | yes | none | no | none | refused | always | absent | Report the Agent check this session is running. |
| `criterion_check_start` | project | high | yes | none | no | none | refused | always | absent | Start a criterion check as the project's coordinator. |
| `criterion_confirm` | project | high | yes | none | no | none | refused | always | absent | Confirm a project criterion as the project's coordinator. |
| `criterion_confirmation_withdraw` | project | high | yes | none | no | none | refused | always | absent | Withdraw a criterion confirmation as the project's coordinator. |
| `drive_delete` | file | high | yes | none | yes | none | refused | always | always — `orbit drive rm` | Move an entry to the owner's Trash. |
| `drive_get` | file | low | no | none | no | read | runs | always | session — `orbit drive get` | Download a drive file into this session's uploads directory. |
| `drive_list` | file | low | no | none | no | read | runs | always | always — `orbit drive ls` | See the contents of a drive folder. |
| `drive_move` | file | medium | yes | none | no | none | refused | always | always — `orbit drive mv` | Move or rename an entry on the drive. |
| `drive_put` | file | medium | yes | none | no | none | refused | always | session — `orbit drive put` | Copy a local file into the owner's Drive. |
| `drive_sync` | file | medium | yes | none | no | none | refused | always | session — `orbit drive sync` | Copy a local directory into a Drive folder in the background. |
| `file_fetch` | file | low | no | none | no | read | runs | always | session — `orbit file fetch` | Read a file's bytes back. |
| `file_list` | file | low | no | none | no | read | runs | always | always — `orbit file list` | See the files this session keeps. |
| `file_pin` | file | medium | yes | none | no | none | refused | always | session — `orbit file pin` | Keep a file so it survives the turn. |
| `file_upload` | file | medium | yes | none | no | none | refused | always | session — `orbit file upload` | Upload a file as an attachment this session's reply can carry. |
| `guide` | catalog | low | no | none | no | read | runs | always | always — `orbit guide` | Find which operation answers a request, and the shortest way to call it here. |
| `integration_abandon` | project | high | yes | none | yes | none | refused | always | absent | Abandon a running landing job. |
| `integration_observe` | project | medium | yes | none | no | none | refused | always | absent | Ask for the project's integration line to be observed again. |
| `integration_request_promotion` | project | high | yes | owner | no | none | refused | always | session — `orbit project request-promotion` | Ask the account owner to promote an integration branch. |
| `integration_retry` | project | medium | yes | none | no | none | refused | always | absent | Retry a failed landing as the project's coordinator. |
| `integration_skip_merge_check` | project | high | yes | card (`orbit_integration_skip_merge_check`) | no | none | refused | always | always — `orbit project skip-merge-check` | Skip a merge check for one landing. |
| `login` | account | medium | yes | none | no | none | refused | absent | headless — `orbit login` | Sign this machine in to an Orbit account. |
| `logout` | account | medium | yes | none | no | none | refused | absent | headless — `orbit logout` | Sign this machine out. |
| `merge_receipt` | merge_receipt | medium | yes | none | no | none | refused | always | always — `orbit session merge-receipt` | Record that a merge happened, as evidence about the caller's own work. |
| `merge_receipts` | merge_receipt | low | no | none | no | read | runs | always | always — `orbit session merge-receipts` | Read the merge receipts recorded for a session. |
| `notify` | owner | medium | yes | none | no | none | runs | always | always — `orbit notify` | Alert the person this run works for on their devices. |
| `open_item_hand_over` | owner | high | yes | owner | no | none | refused | always | absent | Hand an open item to the account owner. |
| `open_item_resolve` | project | medium | yes | none | no | none | refused | always | absent | Close an open integration or task-failure item. |
| `permission_prompt` | permission | low | no | none | no | read | runs | engine | absent | Answer an engine tool-permission prompt from the account owner. |
| `project_blocker_resolve` | project | high | yes | card (`orbit_blocker_resolve`) | no | none | refused | always | always — `orbit project resolve-blocker` | Resolve a project blocker. |
| `project_create` | project | high | yes | card (`orbit_project_create`) | no | none | refused | always | always — `orbit project create` | Record a whole body of work with its own goal and acceptance. |
| `project_crossings` | project | low | no | none | no | read | runs | always | always — `orbit project crossings` | Read the cross-project move requests awaiting the account owner. |
| `project_delete` | project | high | yes | none | yes | none | refused | always | always — `orbit project delete` | Delete an empty project permanently. |
| `project_ensure_coordinator` | project | high | yes | none | no | none | refused | orchestration | orchestration — `orbit project ensure-coordinator` | Open a project's coordinator conversation when the standing one cannot be reached. |
| `project_get` | project | low | no | none | no | read | runs | always | always — `orbit project get` | Read a project's goal, acceptance criteria, status and integration. |
| `project_integration_get` | project | low | no | none | no | read | runs | always | always — `orbit project integration` | Read a project's landing and merge-check integration settings. |
| `project_merge_evidence` | merge_receipt | medium | yes | none | no | none | refused | always | always — `orbit project merge-evidence` | Record what a target branch was observed to contain, as a project's merge evidence. |
| `project_request_done` | project | high | yes | owner | no | none | refused | always | session — `orbit project request-done` | Ask the account owner to settle a project as done. |
| `project_request_reopen` | project | high | yes | owner | no | none | refused | always | session — `orbit project request-reopen` | Ask the account owner to reopen a settled project. |
| `project_request_start` | project | high | yes | owner | no | none | refused | always | session — `orbit project request-start` | Ask the account owner to start a project. |
| `project_ruling_record` | project | medium | yes | none | no | none | runs | always | absent | Record an owner ruling given in this conversation as a project record. |
| `project_send` | project | medium | yes | none | no | caller_key | refused | orchestration | orchestration — `orbit project send` | Send one message to a project's coordinator. |
| `project_update` | project | high | yes | card (`orbit_project_update_integration`) | no | none | refused | always | always — `orbit project update` | Change a project's goal, criteria, instructions or integration. |
| `provider_create` | provider | high | yes | card (`orbit_provider_create`) | no | none | refused | always | always — `orbit provider create` | Add a credential provider. |
| `provider_delete` | provider | high | yes | card (`orbit_provider_delete`) | yes | none | refused | always | always — `orbit provider delete` | Delete a credential provider. |
| `provider_list` | provider | low | no | none | no | read | runs | always | always — `orbit provider list` | See the credential providers and the engines each can run. |
| `provider_update` | provider | high | yes | card (`orbit_provider_update`) | no | none | refused | always | always — `orbit provider update` | Change a credential provider. |
| `request_owner_action` | owner | high | yes | owner | no | none | runs | always | session — `orbit owner-request` | Ask the account owner to perform a consequential action. |
| `runner_delete` | runner | high | yes | card (`orbit_runner_delete`) | yes | none | refused | orchestration | orchestration — `orbit runner delete` | Delete a runner and the agents bound to it. |
| `runner_engine_install` | runner | high | yes | none | no | none | refused | orchestration | orchestration — `orbit runner install` | Install or update an engine CLI on one of this account's runners. |
| `runner_engine_install_status` | runner | low | no | none | no | read | runs | orchestration | orchestration — `orbit runner install-status` | Read where an engine install or update stands. |
| `runner_list` | runner | low | no | none | no | read | runs | orchestration | orchestration — `orbit runner list` | See the runners of this account and whether they are online. |
| `schedule_create` | schedule | high | yes | owner | no | none | runs | always | absent | Propose a scheduled task on a create card the owner answers. |
| `schedule_delete` | schedule | high | yes | none | yes | none | refused | always | absent | Delete a scheduled task; its runs and findings are kept. |
| `schedule_end` | schedule | medium | yes | none | no | none | runs | always | absent | End a scheduled task whose goal is reached. |
| `schedule_get` | schedule | low | no | none | no | read | runs | always | absent | Read one scheduled task: last result, findings, note, use and history. |
| `schedule_list` | schedule | low | no | none | no | read | runs | always | absent | See the owner's scheduled tasks. |
| `schedule_pause` | schedule | medium | yes | none | no | none | refused | always | absent | Pause a scheduled task. |
| `schedule_resume` | schedule | medium | yes | none | no | none | refused | always | absent | Resume a paused or held scheduled task. |
| `schedule_run_now` | schedule | medium | yes | none | no | none | refused | always | absent | Start one run of a scheduled task now. |
| `schedule_run_report` | schedule | medium | yes | none | no | none | runs | always | absent | Report the scheduled run this session serves, once. |
| `schedule_run_stop` | schedule | medium | yes | none | no | none | refused | always | absent | Stop one run of a scheduled task. |
| `schedule_update` | schedule | high | yes | owner | no | none | runs | always | absent | Change a scheduled task; a change that grows its envelope waits on the owner's card. |
| `schedule_wakeup` | session | medium | yes | none | no | none | runs | always | absent | Schedule a wake-up in this session, once or on a loop. |
| `session_await` | watch | medium | yes | none | no | caller_key | runs | orchestration+watch_switch | orchestration+watch_switch — `orbit session await` | Be woken when sessions finish their turn, need a person, or end. |
| `session_complete` | session | medium | yes | none | no | none | refused | orchestration | orchestration — `orbit session complete` | Move a session to Completed. |
| `session_create` | session | high | yes | none | no | none | refused | orchestration | orchestration — `orbit session create` | Open a new conversation to run a sub-task immediately. |
| `session_delete` | session | medium | yes | none | no | none | refused | orchestration | orchestration — `orbit session delete` | Move a session to Trash. |
| `session_end` | session | medium | yes | none | no | none | refused | orchestration | orchestration — `orbit session end` | End a session. |
| `session_get` | session | low | no | none | no | read | runs | orchestration | orchestration — `orbit session get` | Read one session's state. |
| `session_import` | session | medium | yes | none | no | none | refused | absent | orchestration — `orbit session import` | Import a Claude Code transcript from this machine as an Orbit session. |
| `session_interrupt` | session | medium | yes | none | no | caller_key | refused | orchestration | orchestration — `orbit session interrupt` | Interrupt a session's turn. |
| `session_list` | session | low | no | none | no | read | runs | orchestration | orchestration — `orbit session list` | See the sessions this agent may read. |
| `session_merge` | session | high | yes | none | no | none | refused | orchestration | orchestration — `orbit session merge` | Merge a session's branch into its target. |
| `session_move` | session | medium | yes | none | no | none | refused | orchestration | orchestration — `orbit session move` | File a session in a folder, or move it to another workspace. |
| `session_reply` | session | medium | yes | none | no | caller_key | refused | orchestration | orchestration — `orbit session reply` | Answer a request this session was sent. |
| `session_search` | session | low | no | none | no | read | runs | orchestration | orchestration — `orbit session search` | Search sessions by their text. |
| `session_send` | session | medium | yes | none | no | caller_key | refused | orchestration | orchestration — `orbit session send` | Send a message to a session. |
| `settings_get` | account | low | no | none | no | read | runs | always | session — `orbit settings get` | Read the owner's Settings a conversation can propose a change to, with their tiers. |
| `settings_propose` | account | high | yes | owner | no | none | runs | always | session — `orbit settings propose` | Propose a change to the owner's own Settings, on a card only they can save. |
| `subagent_rate` | subagent | medium | yes | none | no | none | runs | always | session — `orbit subagent rate` | Rate how useful a SubAgent's result was. |
| `task_attribution` | task | low | no | none | no | read | runs | always | always — `orbit task attribution` | Read where a task counts, where it was noticed, and what is blocking it. |
| `task_await` | watch | medium | yes | none | no | caller_key | runs | watch_switch | session+watch_switch — `orbit task await` | Be woken when tasks finish, or as soon as one fails. |
| `task_batch_pin` | task | medium | yes | none | no | none | refused | always | always — `orbit task batch-pin` | Re-pin many tasks' engine, provider or model in one request. |
| `task_comment` | task | medium | yes | none | no | none | refused | always | always — `orbit task comment` | Add a comment to a task. |
| `task_confirmation_return` | task | medium | yes | none | no | none | refused | always | always — `orbit task confirmation-return` | Send an owner-confirmation request back to its run with what must change. |
| `task_confirmation_review` | task | medium | yes | none | no | none | refused | always | always — `orbit task confirmation-review` | Record this session's review of an owner-confirmation request. |
| `task_create` | task | high | yes | card (`orbit_task_create`) | no | caller_key | refused | always | always — `orbit task create` | Record one durable piece of work. |
| `task_create_batch` | task | high | yes | card (`orbit_task_batch`) | no | caller_key | refused | always | always — `orbit task create-batch` | Record a whole plan of tasks, with their edges, in one atomic call. |
| `task_delete` | task | high | yes | none | yes | none | refused | always | always — `orbit task delete` | Delete a task permanently. |
| `task_dependency_add` | task | medium | yes | none | no | none | refused | always | always — `orbit task dependency-add` | Make one task wait for another. |
| `task_dependency_graph` | task | low | no | none | no | read | runs | always | always — `orbit task dependency-graph` | Read a task's dependency graph. |
| `task_dependency_remove` | task | medium | yes | none | no | none | refused | always | always — `orbit task dependency-remove` | Remove a dependency edge. |
| `task_evidence_decide` | task | high | yes | none | no | none | refused | always | always — `orbit task evidence-decide` | Decide one version of a task's completion evidence, as the session it is addressed to. |
| `task_evidence_list` | task | low | no | none | no | read | runs | always | always — `orbit task evidence-list` | Read a task's immutable completion-evidence revisions. |
| `task_evidence_submit` | task | medium | yes | none | no | caller_key | refused | always | always — `orbit task evidence-submit` | Submit a structured completion-evidence revision for a task. |
| `task_get` | task | low | no | none | no | read | runs | always | always — `orbit task get` | Read one task's full record. |
| `task_labels` | task | low | no | none | no | read | runs | always | always — `orbit task labels` | See every label in use and how its tasks are progressing. |
| `task_list` | task | low | no | none | no | read | runs | always | always — `orbit task list` | See what work exists, filtered by status, list, project, label or priority. |
| `task_progress_report` | task | medium | yes | none | no | none | refused | always | always — `orbit task progress` | Report structured progress on the task this run is doing. |
| `task_reopen` | task | medium | yes | none | no | none | refused | always | always — `orbit task reopen` | Take a stopped task back to OPEN in place so the next attempt reuses it. |
| `task_request_confirmation` | owner | high | yes | owner | no | none | refused | always | always — `orbit task request-confirmation` | Declare the task's work finished so the account owner is asked to confirm it. |
| `task_start` | task | high | yes | none | no | none | refused | always | always — `orbit task start` | Start a task now on its assignee. |
| `task_update` | task | medium | yes | none | no | none | refused | always | always — `orbit task update` | Change a task's fields, dependencies or pins. |
| `tasklist_create` | task_list | medium | yes | none | no | none | refused | always | always — `orbit task-list create` | Create a dispatch policy for a class of work. |
| `tasklist_delete` | task_list | high | yes | none | yes | none | refused | always | always — `orbit task-list delete` | Delete a task list; its tasks are detached, not deleted. |
| `tasklist_get` | task_list | low | no | none | no | read | runs | always | always — `orbit task-list get` | Read one task list's dispatch policy and progress. |
| `tasklist_list` | task_list | low | no | none | no | read | runs | always | always — `orbit task-list list` | See the task lists and what each holds. |
| `tasklist_propose_dag` | task_list | high | yes | card (`orbit_dag_change`) | no | none | refused | always | always — `orbit task-list propose-dag` | Preview or apply a batch of dependency changes to a list. |
| `tasklist_update` | task_list | medium | yes | none | no | none | refused | always | always — `orbit task-list update` | Change a task list's concurrency, pause, instructions or foreman settings. |
| `watch_cancel` | watch | medium | yes | none | no | none | runs | watch_switch | session+watch_switch — `orbit watch cancel` | Cancel a watch so it wakes nobody. |
| `watch_create` | watch | medium | yes | none | no | caller_key | runs | watch_switch | session+watch_switch — `orbit watch create` | Ask Orbit to wake this session when a condition holds. |
| `watch_get` | watch | low | no | none | no | read | runs | watch_switch | session+watch_switch — `orbit watch get` | Read one watch in full, including why it has not fired. |
| `watch_list` | watch | low | no | none | no | read | runs | watch_switch | session+watch_switch — `orbit watch list` | See this session's watches. |
| `watch_update` | watch | medium | yes | none | no | none | runs | watch_switch | session+watch_switch — `orbit watch update` | Change a watch's condition or deadline. |
| `whoami` | account | low | no | none | no | read | runs | absent | headless — `orbit whoami` | Tell the person who this process acts as. |
| `wiki_draft` | wiki | medium | yes | none | no | caller_key | refused | wiki_switch | session+wiki_switch — `orbit wiki draft` | Draft a wiki page section for review. |
| `wiki_get` | wiki | low | no | none | no | read | runs | wiki_switch | session+wiki_switch — `orbit wiki get` | Read one or more wiki entries. |
| `wiki_import` | wiki | medium | yes | none | no | none | refused | absent | session+wiki_switch — `orbit wiki import` | Import a Markdown file or tree into a wiki space. |
| `wiki_note` | wiki | medium | yes | none | no | none | refused | wiki_switch | session+wiki_switch — `orbit wiki note` | Record one claim or pitfall in the shared wiki. |
| `wiki_propose` | wiki | medium | yes | none | no | caller_key | refused | wiki_switch | session+wiki_switch — `orbit wiki propose` | Propose a change to the shared wiki. |
| `wiki_read` | wiki | low | no | none | no | read | runs | wiki_switch | session+wiki_switch — `orbit wiki read` | Read the wiki's documents from a wiki chat. |
| `wiki_search` | wiki | low | no | none | no | read | runs | wiki_switch | session+wiki_switch — `orbit wiki search` | Search the shared wiki for what is known. |
| `wiki_verify` | wiki | medium | yes | none | no | none | refused | absent | session+wiki_switch — `orbit wiki verify` | Wait for the server's verdicts on a wiki import. |
| `withdraw_owner_request` | owner | medium | yes | none | no | none | runs | always | absent | Withdraw a request this session filed with the account owner. |

## Writes Plan mode runs

Plan reads, waits and asks the owner, and refuses every other write. These are the writes it runs, and the operations whose own gate decides there; a preview (`task_create_batch` with `dryRun`, `orbit task create-batch --dry-run`, `orbit task-list propose-dag` without `--apply`) writes nothing and runs like a read.

| Operation | Plan | Why |
| --- | --- | --- |
| `ask_owner` | runs | puts a question to the owner; a question is not work |
| `bg_run` | own_gate | the background-job gate (background_gate.go) decides in every mode: Plan refuses the job, with what to do instead |
| `notify` | runs | puts a line in front of the owner; a message is not work |
| `project_ruling_record` | runs | records what the owner already said; a record of a ruling is not work |
| `request_owner_action` | runs | asks the owner for an action that is theirs to take; a question is not work |
| `schedule_create` | runs | puts a create card in front of the owner; nothing is scheduled until they press Create |
| `schedule_end` | runs | ends a schedule whose goal is reached; it changes no code, and the owner can undo it |
| `schedule_run_report` | runs | reports the scheduled run this session serves, which is what a check-only run is for |
| `schedule_update` | runs | changes a schedule inside what the owner allowed, or asks them on a card; it changes no code |
| `schedule_wakeup` | runs | schedules this session's own next turn; it changes no work |
| `session_await` | runs | waits on Orbit's own work for this session; a wait changes no work |
| `settings_propose` | runs | puts a settings card in front of the owner; nothing is written until they save it |
| `subagent_rate` | runs | records what this session made of a SubAgent's result; it changes no work |
| `task_await` | runs | waits on Orbit's own work for this session; a wait changes no work |
| `watch_cancel` | runs | stops a wait of this session's own |
| `watch_create` | runs | waits on Orbit's own work for this session; a wait changes no work |
| `watch_update` | runs | changes what this session waits for, and nothing else |
| `withdraw_owner_request` | runs | takes back a question this session asked |

## Deliberately absent surfaces

An operation missing from one surface is a declared decision, not drift: the catalogue row says why.

| Operation | Surface without a door | Why |
| --- | --- | --- |
| `ask_owner` | CLI | asks as the project's coordinator session: a terminal outside one is refused by the server |
| `bg_kill` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_list` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_output` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_run` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `condition_get` | CLI | a condition's reads are served to sessions, like a scheduled task's; the person reads it in the app |
| `criterion_check_report` | CLI | reports the Agent check the calling session is running: a terminal is no such session |
| `criterion_check_start` | CLI | starts a check as the project's coordinator session: a terminal outside one is refused by the server |
| `criterion_confirm` | CLI | confirms as the project's coordinator session: a terminal outside one is refused by the server |
| `criterion_confirmation_withdraw` | CLI | withdraws as the project's coordinator session: a terminal outside one is refused by the server |
| `integration_abandon` | CLI | abandons a running job as the project's coordinator session: a terminal outside one is refused by the server |
| `integration_observe` | CLI | asks for an observation as the project's coordinator session: a terminal outside one is refused by the server |
| `integration_retry` | CLI | reruns a landing as the project's coordinator session: a terminal outside one is refused by the server |
| `open_item_hand_over` | CLI | hands an item to the account owner as the project's coordinator session: a terminal outside one is refused by the server |
| `open_item_resolve` | CLI | closes an item as the project's coordinator session: a terminal outside one is refused by the server |
| `permission_prompt` | CLI | runtime approval bridge, called by the engine mid-turn |
| `project_ruling_record` | CLI | records as the project's coordinator session, from one of its turns: a terminal outside one is refused by the server |
| `schedule_create` | CLI | proposes a schedule in the calling session's workspace, on its engine: a terminal outside a session has neither |
| `schedule_delete` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_end` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_get` | CLI | a scheduled task's reads are served to sessions; the person reads them in the app |
| `schedule_list` | CLI | a scheduled task's reads are served to sessions; the person reads them in the app |
| `schedule_pause` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_resume` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_run_now` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_run_report` | CLI | reports the scheduled run the calling session serves: a terminal is no such session |
| `schedule_run_stop` | CLI | controls a schedule as the calling session: a terminal outside one is refused by the server |
| `schedule_update` | CLI | changes a schedule as the calling session, which the envelope rule judges: a terminal outside one is refused by the server |
| `schedule_wakeup` | CLI | wakes the calling session: there is no session to wake at a terminal outside one |
| `withdraw_owner_request` | CLI | withdraws as the calling session what it filed: a terminal outside one is refused by the server |
| `api` | MCP | calls any user REST route with the person's own token; a general escape hatch, not an agent operation |
| `login` | MCP | signs this machine's account in; a person's own terminal act |
| `logout` | MCP | signs this machine's account out; a person's own terminal act |
| `session_import` | MCP | imports a Claude Code transcript from this machine's disk as a session: a runner's local work, not a control-plane call |
| `whoami` | MCP | tells the person who this process acts as; there is no agent-session equivalent |
| `wiki_import` | MCP | imports a file or directory tree from this machine into the wiki: a runner's local read, not a control-plane call |
| `wiki_verify` | MCP | runs a model over a wiki entry on this runner: a runner's work, not a tool call |

## Receipts and retries

Each operation states what proves it succeeded and how a retry is made safe. Read them from
`orbit capabilities --json` (`successEvidence`, `retry`) or from the row above; the rules they
follow are docs/orbit-agent-contract.md §5.2 and §6.
