# Task run sidebar

Board: `docs/mocks/task-run-sidebar/01-board.html` (PNGs `01-board-1.png`, `01-board-2.png`).
Owner decisions, 2026-11-26: **D1 = A, D2 = B, D3 = A**.

## Problem

Opening a task from inside its own run conversation lays `TaskOverPagePanel` over the transcript
(`AppShell.tsx`, `?task=<id>`). The panel covers more than half the window, so every line of the
conversation is cut off. Its first screen holds what was set up when the task was filed: the
criteria text, the brief (already the conversation's first message), and the five "Runs with" chips.
What the reader came for is at the bottom of Activity, in a long comment, if anywhere: why the task
ended FAILED, what is left on its branch, and what to do next.

## Decisions

- **D1 = A, overridden.** D1 docked the panel only in the task's own run conversation. The owner's
  later `session-task-column` ruling (2026-11-26, `docs/mocks/session-task-column`, option A) wins, and
  the owner confirmed it for this column on 2026-11-26 (question 354PPFKSkI4Hmg66904vp): opened over
  **any session page**, the task docks beside the conversation as a column. Opened from any other page,
  it stays the overlay that `task-link-in-place` settled. The ruling also replaces this design's first
  numbers, a 380 px column from a 1280 px window, with main's 420 px from 1640 px (below).
- **D2 = B.** In a task's own run conversation (a session that is one of the task's runs) the sidebar
  is **open by default**. It can be closed, and the choice is remembered per session. In any other
  conversation it opens only when asked for.
- **D3 = A.** A FAILED task whose criterion is EXECUTABLE gets **Re-run the check**: the acceptance
  command runs again in the same conversation, on the branch as it is now, and no agent turn starts.

## The column

Width 420 px, docked to the right of the conversation, which narrows instead of being covered, from a
window 1640 px wide (`TASK_COLUMN_QUERY`, the width at which the conversation keeps 560 px). Below
1640 px it falls back to today's overlay. Its blocks, top to bottom:

1. **Head.** The title clamped to 2 lines, a status pill that carries its reason (`Failed · check exited 1`),
   then elapsed time and cost. On the right: `⤢` (full task page), `⋮`, `✕`.
2. **State block.** What it is now and what it needs from you, in one tinted card:
   - Running: today's Now (the `task_progress_report` steps).
   - Needs you: the evidence summary with Accept / Send back.
   - Done: Delivered, cut to two lines (accepted, landed).
   - Failed: **Why it failed**, which lists the acceptance rounds of this run (exit code, time, the
     tree they ran on, and an **Output** link that scrolls the conversation to that round's shell
     turn). It also shows the first line of the newest comment, and three buttons:
     **Re-run the check**, **Retry the task**, **Close as not needed**.
3. **Branch.** Ahead/behind main, the commits still on the branch, and a one-line landing status,
   read from the task's existing integration/landing record.
4. **Done means.** One row per criterion with ✓ / ✕ / ○. The criteria text and the brief fold behind `Show`.
5. **Runs.** One row per run, with the current one marked `this conversation`.
6. **Runs with** and **Activity**, one line each, expanding in place.

The full task page (`TaskDetailPage`) keeps everything it shows today; the column is a compact
arrangement of the same panel, not a second component.

## Correction to the board

Board 1 ② shows "Agent's own run of the check · exit 0". Nothing records that: it was the agent's
claim, written in a comment. The column shows only the acceptance rounds Orbit ran. Before the web
work starts, the board is redrawn to match.

## Data that does not exist yet

- **Acceptance rounds are not recorded.** `executable-acceptance-round.ts` says so: a round leaves
  only its reserved shell turn (`system:task-acceptance:v1:<turn>:<expected>`) and, on failure, the
  session's `error` sentence `acceptance command exited N; expected M`. The runner's
  `/turn-complete` carries `shellExitCode` and `shellOutput`; the apiserver reads the exit code
  inside the comparison block and **drops the output**. Wiki: "Failed acceptance command may leave
  no output in task comments" (34scaKKJ6XmhDMpslzNxl).
  → Persist, per acceptance shell turn: the exit code, the expected code, the branch SHA it ran on,
  when it finished, and the clipped, redacted output tail (16 KB, as `IntegrationCheckResult` does).
  **Constraint:** the comparison block stays one status write with no other database touch
  (`executable-exit-code-judgment.spec.ts`, by the owner's direction). The round record is written
  outside that block.
- **Re-run the check** has no door. Today a round is minted only when an agent turn completes on an
  OPEN/IN_PROGRESS task (`awaitsExecutableAcceptance`).
  → A new owner action on a FAILED EXECUTABLE task. It moves the task back to a pending state and
  queues one acceptance shell turn on the task's latest run session, keyed so that one press queues
  exactly one round. The round then settles through the existing comparison. It needs a runner
  online for that session's workspace; if there is none, the button says so rather than queueing silently.
- **The reason on the Failed pill** comes from the session's run outcome. It needs a shared copy table:
  check exited N / run stopped / over budget / runner lost, and so on.

## Build order

1. Server: acceptance round record and its read (task detail lists rounds per run). Covered by a pg spec.
2. Server and runner: Re-run the check, with idempotent queueing and a pg spec for FAILED → round → DONE/FAILED.
3. Shared: failure-reason copy table for the pill.
4. Web: the compact column (blocks above), docked in the task's own run conversation and open by
   default; `⤢` opens the full page; overlay below 1280 px.
5. iOS / Android: the task card at the top of a task's run conversation uses the same order, after the web version is signed off.
