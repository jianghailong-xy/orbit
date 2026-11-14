# Coordinator handoff: the API the clients build against

"Start a new coordinator" with a handoff note. The spec is board 02
(`docs/mocks/coordinator-context-actions/02-handoff-flow.html`). The server side is
`src/apiserver/src/projects/coordinator-handoff.service.ts`. The types and the board's copy are in
`src/shared/src/coordinator-handoff.ts`, exported from `@orbit/shared`.

## Flow

1. **Hand over** (`POST /projects/:id/coordinator/handoff`). Orbit queues a platform turn in the
   current coordinator. Its key is `coordinator-handoff:v1:<handoffId>:<attempt>` and it is sent as
   `NEXT_TURN`, so it runs after any turn already running. The turn is the platform's
   (`isOrbitAuthoredTurn`), not a message from the owner, so clients do not draw it as one. It asks
   for a note in exactly four sections: **Where things stand / Agreed with the owner / Waiting on /
   Next**. State: `WRITING`.
2. **The turn succeeds.** Its last top-level assistant text becomes the note, and the state moves to
   `HANDING_OVER`. Then the existing replacement runs (`ProjectsService.coordinator(…, 'replace')`,
   the same code behind `POST /projects/:id/coordinator/replace`):
   - the outgoing coordinator is completed;
   - the successor opens with the note appended to its opening, and is told that project_get and
     task_list win over the note;
   - every live wait (ACTIVE **and PAUSED**, a PAUSED one staying paused) moves to the successor, in
     the swap transaction;
   - the handoff becomes `COMPLETED`, also in that transaction.
3. **The turn fails, times out, or the owner stops it.** The state becomes `FAILED` with a reason.
   Nothing else changes: the old coordinator stays current and no wait moves.
   - Timeouts: 10 minutes after the turn was delivered, or 60 minutes while it is still queued.
   - A stop that drops the queued turn, or a conversation that ends, counts as stopped.
   - A sweep every 30 s catches the endings that never reach turn-complete.

## Endpoints

All are owner-authenticated and take a public project id. Each POST answers `CoordinatorHandoffView`.

| Route | Board action | Allowed from | Effect |
|---|---|---|---|
| `GET /projects/:id/coordinator/pending-waits` | confirm dialog's "N pending waits move over" | any | `CoordinatorPendingWait[]` (`{ id, label, paused }`), oldest first; `[]` hides the row |
| `POST /projects/:id/coordinator/handoff` | **Hand over** | open coordinator, no live handoff | queues the note turn → `WRITING`. A live handoff is answered as it stands; a `FAILED` one is retried |
| `POST /projects/:id/coordinator/handoff/skip` | **Skip the note** / **Hand over without a note** | `WRITING`, `FAILED`, or no handoff | the replacement right away with no note → `COMPLETED` |
| `POST /projects/:id/coordinator/handoff/cancel` | **Cancel handover** / **Keep this coordinator** | `WRITING`, `FAILED` | `CANCELLED`; the note turn is withdrawn if queued, stopped if running; nothing else changes |
| `POST /projects/:id/coordinator/handoff/retry` | **Try again** | `FAILED` | a new attempt: a new note turn → `WRITING` |

A 409 means the action does not fit the current state. Examples: cancelling while `HANDING_OVER`,
or a project whose coordinator is already completed (for that one, use skip or `/replace`). A
replacement that throws leaves the handoff `FAILED` with `REPLACE_FAILED`, and the error is
returned.

## State on sessions

`GET /sessions/:id` and the realtime `session.updated` summary (`ControlSessionSummary`) carry two
keys. Each is `null` when there is nothing to show. Every transition publishes `session.updated` for
the outgoing session, and for the successor once there is one.

`coordinatorHandoff: SessionCoordinatorHandoff | null` is set on the **outgoing** coordinator.

| Field | Meaning |
|---|---|
| `state` | `WRITING` · `HANDING_OVER` · `FAILED` · `COMPLETED` (a cancelled handoff shows as `null`) |
| `startedAt` | when the current note turn was asked for; the "Writing the handoff note 0:24" timer counts from it |
| `failureCode` | `TURN_FAILED` · `TURN_STOPPED` · `TIMED_OUT` · `EMPTY_NOTE` · `REPLACE_FAILED`, or null |
| `failureReason` | the whole sentence, e.g. "The handoff note wasn't written: the turn failed." |
| `handedOverToSessionId` | the successor once `COMPLETED` ("Handed over to a new coordinator. Open it") |

`coordinatorHandoffReceived: SessionCoordinatorHandoffReceived | null` is set on the **successor**.

| Field | Meaning |
|---|---|
| `handoffFromSessionId` | the previous coordinator; the note card links to it |
| `note` | the note text, or null when it was skipped |
| `handedOverAt` | "Handoff from the previous coordinator · 3:42 PM" |
| `movedWaits` | `CoordinatorPendingWait[]` that moved here ("2 waits moved here") |

## Board 02 states → API

| Board | What the client reads |
|---|---|
| ① Confirm (idle / turn running) | `pending-waits`; body copy `confirmBody` or, while the session is running, `confirmBodyWhileRunning` |
| ② Writing the handoff note + timer, Skip the note, Cancel handover; composer disabled | `coordinatorHandoff.state === 'WRITING'`, `startedAt` |
| ② "Handing over to a new coordinator…" | `coordinatorHandoff.state === 'HANDING_OVER'` |
| ② "Compacting…" | the session's ordinary compaction phase while `WRITING`; the timer keeps running |
| ③ Successor: note card, sections, "N waits moved here" | `coordinatorHandoffReceived` (`note`, `handedOverAt`, `movedWaits`, `handoffFromSessionId`) |
| ④ Outgoing completed: banner with Open it | `coordinatorHandoff.state === 'COMPLETED'`, `handedOverToSessionId` |
| ⑤ Failure: reason, Try again, Hand over without a note, Keep this coordinator | `coordinatorHandoff.state === 'FAILED'`, `failureReason` → `retry` / `skip` / `cancel` |

The board's copy, word for word, is `COORDINATOR_HANDOFF_COPY` in `@orbit/shared`.
