# Orbit operation catalogue v1.4.0

> Generated from `src/runner-go/operation_catalog.go` — do not edit by hand.
> Content hash: `fa27c1a1f808dda9d075e00e82fe61790ea37e53a7505c9b5620bd9461a8d50c`.

Every operation an Orbit agent can call is declared once in the operation catalogue. This table is that catalogue rendered for a person: `orbit capabilities --json` and the MCP `tools/list` payload are its two machine surfaces, and the leaf `--help` texts are held to it by tests. `MCP` and `CLI` say how each surface reaches the operation — `always`, an `orchestration` grant, an engine `permission_prompt` bridge, `session`-only, `headless`-only, or a `watch_switch`/`wiki_switch` — and `absent` when that surface deliberately has no door. Gates that must hold together are joined with `+` (for example `orchestration+watch_switch`). `Idempotency` is `read` (safe to repeat), `caller_key` (retry with the same key), `server_key` (a redelivered turn deduplicates) or `none` (re-read before retrying).

| Operation | Object | Risk | Writes | Approval | Destructive | Idempotency | MCP | CLI | Intent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `agent_create` | agent | high | yes | card (`orbit_agent_create`) | no | none | orchestration | orchestration — `orbit agent create` | Create an agent: where and under which identity work runs. |
| `agent_delete` | agent | high | yes | card (`orbit_agent_delete`) | yes | none | orchestration | orchestration — `orbit agent delete` | Delete an agent. |
| `agent_list` | agent | low | no | none | no | read | orchestration | orchestration — `orbit agent list` | See the agents work can run under. |
| `agent_update` | agent | high | yes | card (`orbit_agent_update`) | no | none | orchestration | orchestration — `orbit agent update` | Change an agent's defaults, location or environment. |
| `api` | account | high | yes | none | no | none | absent | headless — `orbit api` | Call any user REST route with the person's own token. |
| `ask_owner` | owner | high | yes | owner | no | none | always | absent | Ask the account owner a question. |
| `bg_kill` | background_job | high | yes | none | yes | none | always | absent | Stop a background job. |
| `bg_list` | background_job | low | no | none | no | read | always | absent | See this session's background jobs. |
| `bg_output` | background_job | low | no | none | no | read | always | absent | Read a background job's output. |
| `bg_run` | background_job | high | yes | none | no | none | always | absent | Run a command in the background on this runner. |
| `criterion_check_report` | project | high | yes | none | no | none | always | absent | Report the Agent check this session is running. |
| `criterion_check_start` | project | high | yes | none | no | none | always | absent | Start a criterion check as the project's coordinator. |
| `criterion_confirm` | project | high | yes | none | no | none | always | absent | Confirm a project criterion as the project's coordinator. |
| `criterion_confirmation_withdraw` | project | high | yes | none | no | none | always | absent | Withdraw a criterion confirmation as the project's coordinator. |
| `file_fetch` | file | low | no | none | no | read | always | session — `orbit file fetch` | Read a file's bytes back. |
| `file_list` | file | low | no | none | no | read | always | always — `orbit file list` | See the files this session keeps. |
| `file_pin` | file | medium | yes | none | no | none | always | session — `orbit file pin` | Keep a file so it survives the turn. |
| `file_upload` | file | medium | yes | none | no | none | always | session — `orbit file upload` | Upload a file as an attachment this session's reply can carry. |
| `integration_abandon` | project | high | yes | none | yes | none | always | absent | Abandon a running landing job. |
| `integration_observe` | project | medium | yes | none | no | none | always | absent | Ask for the project's integration line to be observed again. |
| `integration_request_promotion` | project | high | yes | owner | no | none | always | session — `orbit project request-promotion` | Ask the account owner to promote an integration branch. |
| `integration_retry` | project | medium | yes | none | no | none | always | absent | Retry a failed landing as the project's coordinator. |
| `integration_skip_merge_check` | project | high | yes | card (`orbit_integration_skip_merge_check`) | no | none | always | always — `orbit project skip-merge-check` | Skip a merge check for one landing. |
| `login` | account | medium | yes | none | no | none | absent | headless — `orbit login` | Sign this machine in to an Orbit account. |
| `logout` | account | medium | yes | none | no | none | absent | headless — `orbit logout` | Sign this machine out. |
| `merge_receipt` | merge_receipt | medium | yes | none | no | none | always | always — `orbit session merge-receipt` | Record that a merge happened, as evidence about the caller's own work. |
| `merge_receipts` | merge_receipt | low | no | none | no | read | always | always — `orbit session merge-receipts` | Read the merge receipts recorded for a session. |
| `notify` | owner | medium | yes | none | no | none | always | always — `orbit notify` | Alert the person this run works for on their devices. |
| `open_item_hand_over` | owner | high | yes | owner | no | none | always | absent | Hand an open item to the account owner. |
| `open_item_resolve` | project | medium | yes | none | no | none | always | absent | Close an open integration or task-failure item. |
| `permission_prompt` | permission | low | no | none | no | read | engine | absent | Answer an engine tool-permission prompt from the account owner. |
| `project_blocker_resolve` | project | high | yes | card (`orbit_blocker_resolve`) | no | none | always | always — `orbit project resolve-blocker` | Resolve a project blocker. |
| `project_create` | project | high | yes | card (`orbit_project_create`) | no | none | always | always — `orbit project create` | Record a whole body of work with its own goal and acceptance. |
| `project_crossings` | project | low | no | none | no | read | always | always — `orbit project crossings` | Read the cross-project move requests awaiting the account owner. |
| `project_delete` | project | high | yes | none | yes | none | always | always — `orbit project delete` | Delete an empty project permanently. |
| `project_ensure_coordinator` | project | high | yes | none | no | none | orchestration | orchestration — `orbit project ensure-coordinator` | Open a project's coordinator conversation when the standing one cannot be reached. |
| `project_get` | project | low | no | none | no | read | always | always — `orbit project get` | Read a project's goal, acceptance criteria, status and integration. |
| `project_integration_get` | project | low | no | none | no | read | always | always — `orbit project integration` | Read a project's landing and merge-check integration settings. |
| `project_merge_evidence` | merge_receipt | medium | yes | none | no | none | always | always — `orbit project merge-evidence` | Record what a target branch was observed to contain, as a project's merge evidence. |
| `project_request_done` | project | high | yes | owner | no | none | always | session — `orbit project request-done` | Ask the account owner to settle a project as done. |
| `project_request_start` | project | high | yes | owner | no | none | always | session — `orbit project request-start` | Ask the account owner to start a project. |
| `project_send` | project | medium | yes | none | no | caller_key | orchestration | orchestration — `orbit project send` | Send one message to a project's coordinator. |
| `project_update` | project | high | yes | card (`orbit_project_update_integration`) | no | none | always | always — `orbit project update` | Change a project's goal, criteria, instructions or integration. |
| `provider_create` | provider | high | yes | card (`orbit_provider_create`) | no | none | always | always — `orbit provider create` | Add a credential provider. |
| `provider_delete` | provider | high | yes | card (`orbit_provider_delete`) | yes | none | always | always — `orbit provider delete` | Delete a credential provider. |
| `provider_list` | provider | low | no | none | no | read | always | always — `orbit provider list` | See the credential providers and the engines each can run. |
| `provider_update` | provider | high | yes | card (`orbit_provider_update`) | no | none | always | always — `orbit provider update` | Change a credential provider. |
| `request_owner_action` | owner | high | yes | owner | no | none | always | absent | Ask the account owner to perform a consequential action. |
| `runner_delete` | runner | high | yes | card (`orbit_runner_delete`) | yes | none | orchestration | orchestration — `orbit runner delete` | Delete a runner and the agents bound to it. |
| `runner_engine_install` | runner | high | yes | none | no | none | orchestration | orchestration — `orbit runner install` | Install or update an engine CLI on one of this account's runners. |
| `runner_engine_install_status` | runner | low | no | none | no | read | orchestration | orchestration — `orbit runner install-status` | Read where an engine install or update stands. |
| `runner_list` | runner | low | no | none | no | read | orchestration | orchestration — `orbit runner list` | See the runners of this account and whether they are online. |
| `schedule_wakeup` | session | medium | yes | none | no | none | always | absent | Schedule a wake-up in this session, once or on a loop. |
| `session_await` | watch | medium | yes | none | no | caller_key | orchestration+watch_switch | orchestration+watch_switch — `orbit session await` | Be woken when sessions finish their turn, need a person, or end. |
| `session_complete` | session | medium | yes | none | no | none | orchestration | orchestration — `orbit session complete` | Move a session to Completed. |
| `session_create` | session | high | yes | none | no | none | orchestration | orchestration — `orbit session create` | Open a new conversation to run a sub-task immediately. |
| `session_delete` | session | medium | yes | none | no | none | orchestration | orchestration — `orbit session delete` | Move a session to Trash. |
| `session_end` | session | medium | yes | none | no | none | orchestration | orchestration — `orbit session end` | End a session. |
| `session_get` | session | low | no | none | no | read | orchestration | orchestration — `orbit session get` | Read one session's state. |
| `session_import` | session | medium | yes | none | no | none | absent | orchestration — `orbit session import` | Import a Claude Code transcript from this machine as an Orbit session. |
| `session_interrupt` | session | medium | yes | none | no | caller_key | orchestration | orchestration — `orbit session interrupt` | Interrupt a session's turn. |
| `session_list` | session | low | no | none | no | read | orchestration | orchestration — `orbit session list` | See the sessions this agent may read. |
| `session_merge` | session | high | yes | none | no | none | orchestration | orchestration — `orbit session merge` | Merge a session's branch into its target. |
| `session_reply` | session | medium | yes | none | no | caller_key | orchestration | orchestration — `orbit session reply` | Answer a request this session was sent. |
| `session_search` | session | low | no | none | no | read | orchestration | orchestration — `orbit session search` | Search sessions by their text. |
| `session_send` | session | medium | yes | none | no | caller_key | orchestration | orchestration — `orbit session send` | Send a message to a session. |
| `task_attribution` | task | low | no | none | no | read | always | always — `orbit task attribution` | Read where a task counts, where it was noticed, and what is blocking it. |
| `task_await` | watch | medium | yes | none | no | caller_key | watch_switch | session+watch_switch — `orbit task await` | Be woken when tasks finish, or as soon as one fails. |
| `task_batch_pin` | task | medium | yes | none | no | none | always | always — `orbit task batch-pin` | Re-pin many tasks' engine, provider or model in one request. |
| `task_comment` | task | medium | yes | none | no | none | always | always — `orbit task comment` | Add a comment to a task. |
| `task_confirmation_return` | task | medium | yes | none | no | none | always | always — `orbit task confirmation-return` | Send an owner-confirmation request back to its run with what must change. |
| `task_confirmation_review` | task | medium | yes | none | no | none | always | always — `orbit task confirmation-review` | Record this session's review of an owner-confirmation request. |
| `task_create` | task | high | yes | card (`orbit_task_create`) | no | caller_key | always | always — `orbit task create` | Record one durable piece of work. |
| `task_create_batch` | task | high | yes | card (`orbit_task_batch`) | no | caller_key | always | always — `orbit task create-batch` | Record a whole plan of tasks, with their edges, in one atomic call. |
| `task_delete` | task | high | yes | none | yes | none | always | always — `orbit task delete` | Delete a task permanently. |
| `task_dependency_add` | task | medium | yes | none | no | none | always | always — `orbit task dependency-add` | Make one task wait for another. |
| `task_dependency_graph` | task | low | no | none | no | read | always | always — `orbit task dependency-graph` | Read a task's dependency graph. |
| `task_dependency_remove` | task | medium | yes | none | no | none | always | always — `orbit task dependency-remove` | Remove a dependency edge. |
| `task_evidence_decide` | task | high | yes | none | no | none | always | always — `orbit task evidence-decide` | Decide one version of a task's completion evidence, as the session it is addressed to. |
| `task_evidence_list` | task | low | no | none | no | read | always | always — `orbit task evidence-list` | Read a task's immutable completion-evidence revisions. |
| `task_evidence_submit` | task | medium | yes | none | no | caller_key | always | always — `orbit task evidence-submit` | Submit a structured completion-evidence revision for a task. |
| `task_get` | task | low | no | none | no | read | always | always — `orbit task get` | Read one task's full record. |
| `task_labels` | task | low | no | none | no | read | always | always — `orbit task labels` | See every label in use and how its tasks are progressing. |
| `task_list` | task | low | no | none | no | read | always | always — `orbit task list` | See what work exists, filtered by status, list, project, label or priority. |
| `task_progress_report` | task | medium | yes | none | no | none | always | always — `orbit task progress` | Report structured progress on the task this run is doing. |
| `task_reopen` | task | medium | yes | none | no | none | always | always — `orbit task reopen` | Take a stopped task back to OPEN in place so the next attempt reuses it. |
| `task_request_confirmation` | owner | high | yes | owner | no | none | always | always — `orbit task request-confirmation` | Declare the task's work finished so the account owner is asked to confirm it. |
| `task_start` | task | high | yes | none | no | none | always | always — `orbit task start` | Start a task now on its assignee. |
| `task_update` | task | medium | yes | none | no | none | always | always — `orbit task update` | Change a task's fields, dependencies or pins. |
| `tasklist_create` | task_list | medium | yes | none | no | none | always | always — `orbit task-list create` | Create a dispatch policy for a class of work. |
| `tasklist_delete` | task_list | high | yes | none | yes | none | always | always — `orbit task-list delete` | Delete a task list; its tasks are detached, not deleted. |
| `tasklist_get` | task_list | low | no | none | no | read | always | always — `orbit task-list get` | Read one task list's dispatch policy and progress. |
| `tasklist_list` | task_list | low | no | none | no | read | always | always — `orbit task-list list` | See the task lists and what each holds. |
| `tasklist_propose_dag` | task_list | high | yes | card (`orbit_dag_change`) | no | none | always | always — `orbit task-list propose-dag` | Preview or apply a batch of dependency changes to a list. |
| `tasklist_update` | task_list | medium | yes | none | no | none | always | always — `orbit task-list update` | Change a task list's concurrency, pause, instructions or foreman settings. |
| `watch_cancel` | watch | medium | yes | none | no | none | watch_switch | session+watch_switch — `orbit watch cancel` | Cancel a watch so it wakes nobody. |
| `watch_create` | watch | medium | yes | none | no | caller_key | watch_switch | session+watch_switch — `orbit watch create` | Ask Orbit to wake this session when a condition holds. |
| `watch_get` | watch | low | no | none | no | read | watch_switch | session+watch_switch — `orbit watch get` | Read one watch in full, including why it has not fired. |
| `watch_list` | watch | low | no | none | no | read | watch_switch | session+watch_switch — `orbit watch list` | See this session's watches. |
| `watch_update` | watch | medium | yes | none | no | none | watch_switch | session+watch_switch — `orbit watch update` | Change a watch's condition or deadline. |
| `whoami` | account | low | no | none | no | read | absent | headless — `orbit whoami` | Tell the person who this process acts as. |
| `wiki_draft` | wiki | medium | yes | none | no | caller_key | wiki_switch | session+wiki_switch — `orbit wiki draft` | Draft a wiki page section for review. |
| `wiki_get` | wiki | low | no | none | no | read | wiki_switch | session+wiki_switch — `orbit wiki get` | Read one or more wiki entries. |
| `wiki_import` | wiki | medium | yes | none | no | none | absent | session+wiki_switch — `orbit wiki import` | Import a Markdown file or tree into a wiki space. |
| `wiki_note` | wiki | medium | yes | none | no | none | wiki_switch | session+wiki_switch — `orbit wiki note` | Record one claim or pitfall in the shared wiki. |
| `wiki_propose` | wiki | medium | yes | none | no | caller_key | wiki_switch | session+wiki_switch — `orbit wiki propose` | Propose a change to the shared wiki. |
| `wiki_search` | wiki | low | no | none | no | read | wiki_switch | session+wiki_switch — `orbit wiki search` | Search the shared wiki for what is known. |
| `wiki_verify` | wiki | medium | yes | none | no | none | absent | session+wiki_switch — `orbit wiki verify` | Wait for the server's verdicts on a wiki import. |
| `withdraw_owner_request` | owner | medium | yes | none | no | none | always | absent | Withdraw a request this session filed with the account owner. |

## Deliberately absent surfaces

An operation missing from one surface is a declared decision, not drift: the catalogue row says why.

| Operation | Surface without a door | Why |
| --- | --- | --- |
| `ask_owner` | CLI | asks as the project's coordinator session: a terminal outside one is refused by the server |
| `bg_kill` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_list` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_output` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
| `bg_run` | CLI | runner-hosted background jobs: a per-session socket call, not a control-plane API call |
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
| `request_owner_action` | CLI | files as the calling session and answers it with a turn: a terminal outside one is refused by the server |
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
