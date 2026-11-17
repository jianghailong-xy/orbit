# Coordinator handoff v2: hand over state, not just a note

Status: proposal (2026-11-16). Board: `docs/mocks/coordinator-handoff-v2/`. Builds on
`docs/coordinator-handoff.md` (v1, shipped).

## Why

Three problems seen on project "Scheduled tasks v1" after its 11-16 handoff (successor
`34yXbX7gnkH9qsCHgNmb3`):

1. **The successor's conversation opened with the project's whole history.** Answered questions (up to 50),
   the start receipt and merge lines were stacked at its head. These records are project-scoped
   (`closedQuestions` in the open-items read, and the promotion and criteria reads), and
   `decisionReceiptAnchor` places a record older than every loaded event at `'head'`. In a
   conversation that has no older page, nothing ever moves them down.
2. **Pending work that is not a watch is lost at the swap.** The swap transaction
   (`ProjectsService.coordinator`, `projects.service.ts` ~4985) moves `watch` rows only. Each of
   these stays addressed to the completed coordinator:
   - `delegate` runs: the wake is dropped (`subagent-wake.ts`, `sessionHasEnded` → `DROPPED`).
   - `bg_run` jobs: the wake is dropped (`background-job-wake.ts`, `DROPPED`).
   - `session_scheduled_wakeup` and `session_wakeup_loop` rows: they keep `session_id` of the old
     coordinator.

   A handoff during a deploy hands the successor nobody's result.
3. **Owner rulings live only in prose.** "Agreed with the owner" is a section of a free-text note.
   Each handoff summarizes the last summary, and a ruling that drops out of one note is gone for
   every later coordinator.

There is also a context cost: the successor's first turn reached 58k tokens. Of that, 38.6k was
fixed system/tool/memory content and 17.6k came from `project_get` + `task_get`. A later `/upgrade`
added 30k: its skill body, plus an `<orbit_project_coordinator_context>` block delivered again,
although the opening already carried it. That re-delivery is a separate defect and is not designed
here.

## Principle

What the successor must act on is **state Orbit holds and moves**. The note carries only what cannot
be state: judgment, threads in progress, what the coordinator was about to do.

| What | v1 | v2 |
|---|---|---|
| Project, tasks, criteria, landings | Reread by the successor | Same; opening read is a server digest (§3) |
| Watches (`task_await`, `watch_create`) | Moved in the swap | Unchanged |
| Open owner questions, open items | Project-scoped | Unchanged |
| `delegate` runs, `bg_run` jobs | Stay with the old session; wake dropped | Wake forwarded to the successor (§1) |
| Scheduled wakeups, wakeup loops | Stay with the old session | Moved in the swap (§1) |
| Owner rulings | Note prose | Project rulings record (§2) |
| Judgment, next steps | Note | Note (sections: Where things stand / Waiting on / Next / Rulings not yet recorded) |

## 1. Move all pending work in the swap

In the same transaction as the watch move, after it:

- `session_scheduled_wakeup` and `session_wakeup_loop`: set `session_id` to the successor. A loop
  keeps its schedule.
- `delegate` runs and `bg_run` jobs keep running where they are (a local run or job lives in the
  old session's worktree and runner process, which stay until it ends). What changes is where
  their wake goes: **a coordinator that ended by a COMPLETED handoff forwards its wakes to
  `handedOverToSessionId`**, following the chain if that one was handed over too, instead of
  dropping them. This is one rule in the wake path (`subagent-wake.ts`, `background-job-wake.ts`),
  checked where `sessionHasEnded` now answers `DROPPED`, so no row moves and no column is added.
- The confirm dialog's preview (`GET …/coordinator/pending-waits`) lists all of these, each with a
  kind: "Deploy 55a189aa3 to production · SubAgent, running 12m".
  `CoordinatorPendingWait` gains `kind: 'WATCH' | 'SUBAGENT' | 'JOB' | 'WAKEUP' | 'LOOP'`.
  `movedWaits` records them as moved.

A wake filed to the successor names its origin: "Started by the previous coordinator: …".

## 2. Owner rulings as a project record

A new `project_ruling` row: project, the ruling in one sentence, the owner's own words (a quote), a
source (an answered `ask_owner` question, or a turn of a coordinator conversation by id), who
recorded it, and when. A later ruling can supersede an earlier one, with the old one marked
superseded rather than deleted.

- An answered `ask_owner` question becomes a ruling automatically (the question's answer is the
  quote).
- A coordinator records a chat ruling with a new tool `project_ruling_record { projectId, ruling,
  quote, sourceTurnId, supersedes? }`. The quote must be a substring of that turn's owner text,
  the same check `wiki_note` makes on citations.
- The handoff note turn's prompt asks the outgoing coordinator to record any ruling not yet recorded
  **before** it writes the note. The note's "Agreed with the owner" section becomes "Rulings not yet
  recorded", normally empty.
- The successor's opening digest lists live rulings (one line each). The project page shows them
  under the criteria.

Rulings are not acceptance criteria and change nothing the platform enforces. They are what the
coordinator was told.

## 3. The successor's opening

- **Server digest instead of two reads.** The replacement renders a compact state digest into the
  opening, the same data `project_get`/`task_list` return, one line per task and criterion, open
  items and live rulings. The target is under 4k tokens. The prompt keeps "read project_get when you
  need detail" but no longer requires both reads before the first report. The digest is dated, and
  the existing rule stays: where it disagrees with a later read, the read wins.
- **Handoff note card** (already drawn) gains a line: "12 decisions, 3 merges before this
  conversation · Open previous coordinator".

## 4. The successor's conversation starts clean

Rule, the same in web (`decisionReceiptAnchor`), iOS/macOS and Android (`ReceiptAnchor.place`): **a
record stamped before the conversation was created is not drawn in it.** `'head'` stays for a record
newer than the conversation's creation but older than its oldest loaded page, which is the case it
was made for. Open items are not records and are unaffected: an open question asked before the
handoff is still drawn, because it still needs an answer.

This also fixes a coordinator opened by plain replace (no note): it starts clean the same way.

## 5. Later (not in this project)

- Suggest a handoff at about 55% of the context window: a line in the composer, not an automatic act.
- Compare the note's "Waiting on" with the moved items, and add "Not mentioned in the note: …" to the
  opening.
- Heavy skills run as subagents in a coordinator (`/upgrade` in a coordinator that delegates the
  deploy anyway).

## Open decisions (recommendation first)

- **D1 Rulings record.** A: its own record, `project_ruling` (recommended: it has a source, a quote
  and supersession, and survives any number of handoffs). B: an "Owner rulings" section appended to
  the project's instructions (no schema, but free text again and editable by `project_update`).
- **D2 Pre-handoff history in the successor.** A: not drawn, one line on the note card links to the
  previous coordinator (recommended). B: drawn folded under one expandable row at the head.
- **D3 Opening read.** A: server digest in the opening (recommended: deterministic, about 4k
  tokens, no tool calls). B: keep the two reads and add a `brief` mode to `project_get`.

## Phases (cheapest first)

1. Swap moves all pending work, and the preview lists it (server + the confirm dialog on three
   clients).
2. Clean start rule in web, iOS/macOS, Android.
3. Opening digest (server).
4. `project_ruling` + `project_ruling_record` + auto-rulings from `ask_owner` + note prompt change +
   the project page's list.
