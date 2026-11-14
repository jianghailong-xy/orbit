# Claude/Codex permission matrix for Orbit's own calls

> Generated from `src/runner-go/permission_matrix_test.go` — do not edit by hand. The test that renders it derives every cell from the code that decides it, so this is what the runner does, not what it is meant to do.

What happens to each kind of Orbit call, per engine, surface and permission mode (docs/orbit-agent-contract.md §4.1). The product rule it keeps: **Orbit's own tools never ask through the engine** (`ALWAYS_ALLOWED_TOOLS`); a write that needs the owner files Orbit's own card, in every mode; and **Plan reads, waits and asks the owner, and refuses every other write**, on every engine and on both surfaces, by the session's live mode — so a switch into or out of Plan, by the owner or by Claude Code itself, counts from the next call. What each operation does in Plan is the operation catalogue's `Plan` column (docs/operation-catalog.md).

| Cell | Meaning |
| --- | --- |
| runs | runs, and nobody is asked |
| Orbit card | Orbit's own card for the write (or, for a background job, the background-job gate's); it runs once the owner says yes |
| refused | refused by Orbit with what to do instead: Plan's write refusal, or the background-job gate's refusal |
| declined | the engine's own prompt is answered no without asking anybody: Plan cannot run what it asks about |
| engine card | the engine's own prompt goes to the owner on a card |
| auto review | the engine's own Auto review judges it first (Codex's reviewer) |

## Claude · MCP

Orbit's MCP tools under Claude Code's `mcp__orbit__*` allow rule (ALWAYS_ALLOWED_TOOLS). In Plan, Claude Code holds back a tool not annotated read-only and asks the permission prompt, which Orbit answers itself, with no card: yes to a call Plan runs, and its Plan refusal to a write.

| Call | Example | Plan | Default | Accept Edits | Don't Ask | Auto | Bypass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read | `task_get` | runs | runs | runs | runs | runs | runs |
| wait on Orbit's own work | `task_await` | runs | runs | runs | runs | runs | runs |
| a line or a question for the owner | `notify` | runs | runs | runs | runs | runs | runs |
| preview (writes nothing) | `task_create_batch` with `dryRun` | runs | runs | runs | runs | runs | runs |
| write: a schedule (`runAt`) | `task_update` with `runAt` | refused | runs | runs | runs | runs | runs |
| write: a dependency edge | `task_dependency_remove` | refused | runs | runs | runs | runs | runs |
| destructive write | `task_delete` | refused | runs | runs | runs | runs | runs |
| write that files its own card | `task_create` | refused | Orbit card | Orbit card | Orbit card | Orbit card | Orbit card |
| background job | `bg_run` | refused | Orbit card | Orbit card | refused | runs | runs |

## Claude · CLI

The in-session `orbit` CLI through Claude Code's shell, where every command `capabilities --json` offers the session is pre-approved (orbitCLIAllowedTools, generated from the catalogue). Claude Code runs an allowlisted command in every mode, Plan included, so the CLI's own Plan gate refuses a write there, with the MCP tool's words.

| Call | Example | Plan | Default | Accept Edits | Don't Ask | Auto | Bypass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read | `orbit task get T1` | runs | runs | runs | runs | runs | runs |
| wait on Orbit's own work | `orbit task await --task-id T1` | runs | runs | runs | runs | runs | runs |
| a line or a question for the owner | `orbit notify --message plan ready` | runs | runs | runs | runs | runs | runs |
| preview (writes nothing) | `orbit task create-batch --tasks-file - --dry-run` | runs | runs | runs | runs | runs | runs |
| write: a schedule (`runAt`) | `orbit task update T1 --run-at 2026-11-15T09:00:00Z` | refused | runs | runs | runs | runs | runs |
| write: a dependency edge | `orbit task dependency-remove T1 T0` | refused | runs | runs | runs | runs | runs |
| destructive write | `orbit task delete T1` | refused | runs | runs | runs | runs | runs |
| write that files its own card | `orbit task create --title x` | refused | Orbit card | Orbit card | Orbit card | Orbit card | Orbit card |

## Codex · MCP

Orbit's MCP tools under Codex, whose consent the runner answers (codexAutomaticApproval): an Orbit tool recognized by its catalogue name is consented to in every mode, so what happens is Orbit's own gates'. Codex asks at all only about a tool whose annotations do not say read-only and do say destructive or open-world.

| Call | Example | Plan | Default | Accept Edits | Don't Ask | Auto | Bypass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read | `task_get` | runs | runs | runs | runs | runs | runs |
| wait on Orbit's own work | `task_await` | runs | runs | runs | runs | runs | runs |
| a line or a question for the owner | `notify` | runs | runs | runs | runs | runs | runs |
| preview (writes nothing) | `task_create_batch` with `dryRun` | runs | runs | runs | runs | runs | runs |
| write: a schedule (`runAt`) | `task_update` with `runAt` | refused | runs | runs | runs | runs | runs |
| write: a dependency edge | `task_dependency_remove` | refused | runs | runs | runs | runs | runs |
| destructive write | `task_delete` | refused | runs | runs | runs | auto review | runs |
| write that files its own card | `task_create` | refused | Orbit card | Orbit card | Orbit card | Orbit card | Orbit card |
| background job | `bg_run` | refused | Orbit card | Orbit card | refused | auto review | runs |
| a third-party server's tool | `acme.deploy` | declined | engine card | engine card | runs | auto review | runs |

## Codex · CLI

The in-session `orbit` CLI through Codex's shell. Codex is handed no allowlist, so an `orbit` command is a shell command like any other there; Orbit's MCP tools are Codex's way in.

| Call | Example | Plan | Default | Accept Edits | Don't Ask | Auto | Bypass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| read | `orbit task get T1` | declined | engine card | engine card | runs | auto review | runs |
| write: a schedule (`runAt`) | `orbit task update T1 --run-at 2026-11-15T09:00:00Z` | declined | engine card | engine card | runs | auto review | runs |
| write that files its own card | `orbit task create --title x` | declined | engine card | engine card | Orbit card | auto review | Orbit card |

## Notes

- **How the engines are modelled.** Everything in a cell is Orbit's code except the engine's own first decision. Claude Code's is as measured on 2.1.325: a call an allow rule covers runs in every mode, Plan included, except that Plan holds back an MCP tool whose annotations do not say `readOnlyHint` and asks the permission prompt (`TestRealClaudePlanModeHoldsOnlyTheOrbitToolsThatWrite` runs the installed CLI against it). Codex's is codex-rs 0.167.2's: no consent under the `never` policy with full disk access (Don't Ask, Bypass), otherwise consent only for a tool whose annotations do not say read-only and do say, or default to, destructive or open-world, and in Auto its own reviewer first. The catalogue declares `readOnlyHint`, `destructiveHint` and `openWorldHint` for every Orbit tool (`withCatalogAnnotations`), which is what keeps both engines from asking about Orbit's reads.
- **A schedule and a dependency edge need no card, in any mode but Plan.** `task_update` with `runAt` (`PATCH /runner/tasks/:id`) and `task_dependency_add` / `task_dependency_remove` (`POST`/`DELETE /runner/tasks/:id/dependencies`) can start recorded work later, but no sooner than `task_start` does now, and `task_start` needs no card once the work is recorded (contract R1.4): the owner answered for the work when it was filed. A card here would ask the owner the same question again for every reschedule. In Plan they are writes and are refused, with the rest.
- **Don't Ask asks nobody but Orbit's own cards.** A write that files its card still asks (a question is not a job), and a background job is refused. On Codex, Don't Ask runs every command unasked: Codex takes no allowlist.
- **Where the gate reads the mode.** The runner hosting the session answers it over the session's socket (`bgJobService`, op `mode`); a write is refused when the socket does not answer, and there is no gate where there is no session or no socket to ask: a person's own terminal has neither, and a background job's environment carries the session but not the socket, so a job started before Plan can still write. Like the background-job gate, this protects against an agent acting ahead of the owner, not against a hostile process on the machine.
