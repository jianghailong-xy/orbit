# When a coding task outlives a context window

Long migrations, test-suite rescues, and dependency upgrades rarely fit inside one agent
conversation. The hard part is not starting another prompt; it is preserving the plan, the
evidence, and the point at which a person should take over.

Orbit's category is **Self-hosted mission control for coding agents**.

Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.

This article is for small engineering and infrastructure teams that already run agents against
private code or internal systems. It shows how to turn a multi-day change into durable work while
keeping a human review point. For the product tour, start with the [README](../README.md) and the
[90-second demo storyboard](90-second-demo.md).

## The failure mode: the plan is trapped in a chat

A single session is a useful place to explore a change. It is a poor system of record for work that
has dependencies:

```text
upgrade dependency ──▶ update migration ──▶ run verification ──▶ review and merge
        │                       │
        └──▶ rescue flaky test ─┘
```

If the browser closes, the runner reboots, or the runtime reaches its context limit, a chat-only
workflow forces someone to reconstruct which step was complete, what was blocked, and why a command
was approved. That reconstruction is where valuable context and review discipline disappear.

## Put the plan in a task graph

In Orbit, a **task** is a durable unit of queued work. Tasks can live in a list, depend on other
tasks, carry comments, and point to one or more sessions. A **session** is the conversation with a
runtime on a runner; it can come and go without becoming the project plan.

The useful separation is:

| Durable in the control plane | Local to a run |
| --- | --- |
| Task title, owner, status, dependencies, and comments | Runtime context window |
| Session and transcript history | Process state on the runner |
| Approval and outcome records | Current checkout or optional worktree |
| Queue position and runner heartbeat | Provider-specific resume behavior |

User turns are stored before delivery, and PostgreSQL is the system of record for the queue and
history. The task graph therefore remains readable when a session ends. A new session can inspect
the task, its prerequisites, and the comment history instead of asking a person to paste the old
conversation back into context.

## A recovery-friendly workflow

### 1. Write the smallest useful tasks

Name the outcome and the boundary of each step. For example:

- `Bump the parser dependency and update the lockfile`
- `Run the migration fixture against the demo database`
- `Rescue the flaky ingestion test; do not change production code until the failure is explained`

Add dependencies only where they carry meaning. A verification task should wait for the change it
actually verifies; unrelated investigation can run in parallel on another runner.

### 2. Leave an operator note at every handoff

Comments are not a replacement for the transcript. They are the short, durable handoff that tells
the next session what a person decided:

```text
2026-09-29 — The migration is prepared but not applied. The fixture passes locally.
Next: run the verification task against the disposable database. Do not merge until the diff
and the rollback path have been reviewed.
```

This note survives a context reset and gives a reviewer an explicit place to correct the plan.

### 3. Start with a safe checkout

The repository includes a tiny [demo repo fixture](../examples/demo-repo/) with a local test and no
credentials. Copy it into a standalone Git repository, point a workspace at it, and ask an agent to
run `npm test` and explain the result. The fixture is deliberately boring: it validates the path
from a task to a runner before a private repository is attached.

For concurrent tasks, enable per-session git worktrees. A worktree reduces file collisions between
sessions; it is **not** a security sandbox. Processes still inherit the runner account's operating-
system access.

### 4. Treat interruption as a state transition, not a lost conversation

There are several distinct interruptions:

1. **The browser closes.** The control plane keeps the task, transcript, and approval state. Open
   the session from another client and continue reviewing.
2. **A runtime reaches its context limit.** Start a fresh session against the same task. The task
   graph and handoff comments carry the intent; the provider's exact resume behavior still varies.
3. **The runner reboots or disappears.** Heartbeats let the control plane mark a lost runner and
   keep eligible queued work visible. Supported runtimes can resume after a process or machine
   restart, but verify the behavior of the engine and version you operate.
4. **A command needs a decision.** The approval card records the exact command and the Allow/Deny
   choice. A later session can see the outcome instead of guessing whether the command ran.

The important invariant is not that every runtime resumes at the exact byte of a turn. It is that
the project does not depend on one context window to remember what matters.

## A practical handoff checklist

Before ending a session, ask the agent to leave:

- the current task and the next task it expects to unblock;
- tests run, with the command and result;
- files changed and files intentionally untouched;
- approvals requested or granted;
- a rollback or discard path;
- one question that requires a person, if any.

When the next session starts, ask it to read the task, dependencies, and latest comment before
touching the checkout. Review the diff and the transcript, then make the merge decision yourself.

## What this workflow does not promise

Orbit coordinates and supervises agents; it does not guarantee that an agent finishes correctly
without review, approval, or a human merge decision. Runtime support, resume behavior, model
features, and usage data vary by engine and provider. A worktree prevents checkout collisions, not
host-level access. Operators still own TLS, least-privilege runner accounts, backups, monitoring,
and restore testing.

## Try the scenario

1. Follow the [Quick Start](../README.md#quick-start) on a trusted host.
2. Add a runner and point a workspace at the [demo repo fixture](../examples/demo-repo/).
3. Create two dependent tasks, run the first, and leave a handoff comment.
4. Close the browser, reopen the task, and review the session and comment history before starting
   the dependent task.

For the exact shots and narration, use [Work that outlives a chat](90-second-demo.md#scene-1--work-that-outlives-a-chat-008032)
in the 90-second storyboard. For deployment and recovery boundaries, read the
[architecture overview](architecture.md) and [self-hosting guide](self-hosting.md).
