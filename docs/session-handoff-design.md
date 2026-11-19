# Session handoff: hand any session over to a fresh one

Status: proposal (2026-11-18). Board: `docs/mocks/session-handoff/`. Builds on coordinator handoff v1
(`docs/coordinator-handoff.md`) and v2 (`docs/coordinator-handoff-v2-design.md`, project 34ycavCsYoARJ89WqS2F6,
DONE 2026-11-17).

## Why

The context sheet of an ordinary session offers only **Compact**. Compact keeps the same conversation, and the
engine summarizes its own earlier turns in a way nobody controls. A coordinator can also **Start a new
coordinator**: the old one writes a note, Orbit moves its pending work, and a fresh conversation starts about 40k
tokens in. Ordinary sessions, the long coding and investigation ones included, have no such way out.

## What coordinator handoff v2 taught

- **The note carries judgment; the server carries state.** Every defect the production walkthrough found was state
  no note could fix:
  - A handoff stopped the old coordinator's SubAgents (fixed: task 34z9KDtdyAA8XEs8MISGq).
  - The gateways refused a kept SubAgent's parent-bound token once its parent ended (fixed: task
    34zCpUaz7KvannC7oJnys).
- **The user's own words do not survive paraphrase.** A summary of a summary drops rulings. Quote them.
- **Test on the deployed build with a real long-running delegate run, early.** Unit tests passed while production
  failed twice.
- **Check the runner's engines before an end-to-end test.** A broken Codex auto-update cost a whole round (task
  34zOR9yPfEAH0IOmc7S69).
- **Measure the successor's first-turn context.** Coordinators went from 58k to 39k.

## The design

### 1. The action

In every session's context sheet (web popover, iOS/macOS sheet, Android sheet), under Compact: **Hand over to a
new session**, "Write a handoff note and continue in a fresh session." For a coordinator this is the existing
"Start a new coordinator". It is one mechanism with two labels.

The confirm dialog is the coordinator's: the note step, then "N pending items move over", each with its kind
(WATCH, SUBAGENT, JOB, WAKEUP, LOOP, plus SERVICE for a session's `bg_run` services, D4).

### 2. The note

A platform turn (`session-handoff:v1:` turn key) asks the outgoing session for five sections:

**Goal · Where things stand · Decisions the user made · Waiting on · Next**

"Decisions the user made" lists the user's instructions and choices with a short quote each. Ordinary sessions have
no project to record rulings on, so the quotes go into the note itself, which Orbit checks (below).

### 3. The successor's opening

The successor's opening is built from the following:

- The user's **first prompt, verbatim**: the request the whole session served.
- The **note**.
- A dated **state digest** rendered by the server, which replaces re-reading:
  - workspace, branch, HEAD and uncommitted files (from the runner's last report);
  - tasks this session created, with their status;
  - pending waits;
  - for a task run, the task's title, criterion and evidence revisions.

The whole opening stays at or under 16,000 characters, like the coordinator digest. The existing rule stays too: a
later read wins over the digest.

### 4. What moves in the swap (one transaction, as in v2)

- **Watches, scheduled wakeups and loops:** they move to the successor, as for coordinators.
- **SubAgent and `bg_run` wakes:** they forward to the successor, and a handed-over session's gateway tokens keep
  serving its running SubAgents. Both are v2's mechanisms, generalized from "coordinator" to "session".
- **Pending approvals:** an approval card waiting on the old session is answered as before. Its result goes to the
  session whose turn asked. An approval the successor needs is asked again.
- **Queued messages:** they move to the successor's queue.
- **The task-run link:** for a task's run session, the successor becomes the task's run (D2). Evidence submission and
  evidence reviews address it from then on.
- **Guests, followers and share links:** they follow the successor. The old session shows a "Handed over" banner
  linking to it.

### 5. The checkout (D1)

The successor runs in the **same worktree and branch**. The old engine is ended, and the new engine starts in the
same directory. Uncommitted edits, build caches, running jobs (D4) and SubAgents' worktrees stay exactly where they
are. The worktree's owner becomes the successor, so gc never reclaims it in between.

### 6. Prompting (D3)

From about 60% of the context window, the context sheet's header says "Context is getting full: Compact or Hand
over". Nothing else prompts; no automatic handoff.

### 7. The old session

The old session is completed (not deleted) and read-only. It shows "Handed over to a new session · Open", and its
conversation ends with the note.

## Decisions (recommendation first)

- **D1 Checkout.**
  - **A: hand over the same worktree.** Recommended: no copy, uncommitted work and running jobs keep their files.
  - B: a fresh worktree from the committed tip, with uncommitted edits committed first.
- **D2 Task runs.**
  - **A: offered, and the successor becomes the task's run.** Recommended.
  - B: not offered on task runs.
- **D3 Prompting.**
  - **A: one line in the context sheet from about 60%.** Recommended.
  - B: also a banner in the conversation.
- **D4 Services.**
  - **A: `bg_run` services keep running across a same-worktree handoff.** Recommended: a dev server stays up.
  - B: services stop, as when a session ends today.

## Phases

1. **Server.** Generalize the handoff endpoints and state from `/projects/:id/coordinator/handoff` to
   `/sessions/:id/handoff`. Make the coordinator path a caller of the same service. The swap moves waits, wakeups,
   loops, queued messages and the task-run link. Generalize the keep-work signal and the gateway rule to any
   handed-over session.
2. **Runner** (needs a runner release). Hand the worktree to the successor engine. Keep jobs, services (D4),
   watches and SubAgents across it. Never reclaim a worktree whose owner moved.
3. **Note and opening.** The five-section prompt, the verbatim first prompt, and the state digest, with a spec on a
   large session (≤ 16,000 characters).
4. **Clients.** Web, iOS/macOS and Android: the action and its 60% line, the confirm dialog with kinds (SERVICE
   added), the successor's note card, and the old session's banner.
5. **Walkthrough on production.** First, check the runner's engines. Then:
   - an ordinary session with uncommitted edits, a running `bg_run` service and job, a Codex delegate run and a
     wakeup is handed over;
   - the successor sees the same diff, the service still answers, and every wake arrives;
   - measure the first-turn tokens;
   - repeat on a task run, whose evidence the successor submits.

## Out of scope

- Automatic handoff.
- Handing a session over to another workspace or machine.
- Merging two sessions.
