# Coordinator handoff: the API the clients build against

"Start a new coordinator" with a handoff note. The spec is board 02
(`docs/mocks/coordinator-context-actions/02-handoff-flow.html`). The server side is
`src/apiserver/src/projects/coordinator-handoff.service.ts`. The types and the board's copy are in
`src/shared/src/coordinator-handoff.ts`, exported from `@orbit/shared`.

## Flow

1. **Hand over** (`POST /projects/:id/coordinator/handoff`). Orbit queues a platform turn in the
   current coordinator. The turn goes through resume, so a coordinator that has ended without being
   completed (recycled while idle, or `FAILED`) is revived to write it. Its key is `coordinator-handoff:v1:<handoffId>:<attempt>` and it is sent as
   `NEXT_TURN`, so it runs after any turn already running. The turn is the platform's
   (`isOrbitAuthoredTurn`), not a message from the owner, so clients do not draw it as one. It asks
   the coordinator first to record every owner ruling not yet recorded (`project_ruling_record`,
   docs/coordinator-handoff-v2-design.md §2), then for a note in exactly four sections: **Where
   things stand / Rulings not yet recorded / Waiting on / Next**. State: `WRITING`.
2. **The turn succeeds.** Its last top-level assistant text becomes the note, and the state moves to
   `HANDING_OVER`. Then the existing replacement runs (`ProjectsService.coordinator(…, 'replace')`,
   the same code behind `POST /projects/:id/coordinator/replace`):
   - the outgoing coordinator is completed;
   - the successor opens with the note appended to its opening, and is told that project_get and
     task_list win over the note;
   - every live wait (ACTIVE **and PAUSED**, a PAUSED one staying paused) moves to the successor, in
     the swap transaction;
   - after the watches, in the same transaction, the outgoing coordinator's pending `schedule_wakeup`
     and its running wakeup loop (with the loop's tick) move to the successor; only `session_id`
     changes, so a loop keeps its schedule;
   - its running `delegate` runs and `bg_run` jobs keep running where they are. When one ends, its
     wake goes to the successor instead of being dropped, following the chain if that one was handed
     over too, and says "Started by the previous coordinator: <description>". A coordinator that
     ended any other way still drops it. A wake that arrives between the outgoing coordinator's
     completion and the swap (handoff still `HANDING_OVER`) is answered 503 and asked again;
   - the handoff becomes `COMPLETED`, also in that transaction.
3. **The turn fails, times out, or the owner stops it.** The state becomes `FAILED` with a reason.
   Nothing else changes: the old coordinator stays current and no wait moves.
   - Timeouts: 10 minutes after the turn was delivered, or 60 minutes while it is still queued.
   - A stop that drops the queued turn, or a conversation that ends, counts as stopped.
   - A revived coordinator that fails again before it answers (its model or provider no longer
     works) is `TURN_FAILED` at the next sweep.
   - A sweep every 30 s catches the endings that never reach turn-complete.

## The successor's model

By default the successor runs on the previous coordinator's engine, provider and model. When that model is
why the owner is handing over (a provider whose sign-in failed, an engine that will not start), the
successor would fail the same way. So **Hand over**, **Skip the note** / **Hand over without a note** and
**Try again** take an optional body, `CoordinatorHandoffRequest`:

```json
{ "successor": { "engine": "claude", "provider": "claude", "model": "claude-opus-5-5" } }
```

Each field is what `POST /sessions` takes, and each is optional. A successor named later in the same handoff
replaces the earlier one; `"successor": null` (the picker's "Same as this one") clears it, back to the
current coordinator's model; a request that leaves `successor` out keeps it. The pick is checked against the session
start's own resolution before anything happens, so a pick that could not open is refused (400/409) and the
current coordinator is not completed. The handoff keeps the pick (migration 1411) and shows it as
`successor` on `coordinatorHandoff` and on every `CoordinatorHandoffView`, so the failure state can show
what was picked.

When the current model is broken, **Hand over** revives the coordinator for its note, and the note turn never
reaches the engine (it is never delivered: the model cannot even start). This conversation will not write a note
however often it is asked, so:

- with a successor picked, the handover goes on **without a note**, on that successor, by itself;
- with none, the handoff is `FAILED` with `COORDINATOR_CANT_RUN` ("The handoff note wasn't written: the model of
  this coordinator could not start. Pick another model and hand over without a note."), and the failure's picker
  and **Hand over without a note** are the way out.

A note turn the engine did take and then failed is the ordinary `TURN_FAILED`, where **Try again** may help.

## Endpoints

All are owner-authenticated and take a public project id. Each POST answers `CoordinatorHandoffView`.

| Route | Board action | Allowed from | Effect |
|---|---|---|---|
| `GET /projects/:id/coordinator/pending-waits` | confirm dialog's "N pending waits move over" | any | `CoordinatorPendingWait[]` (`{ id, kind, label, paused }`), oldest first; `[]` hides the row. `kind` is `WATCH`, `SUBAGENT` (a running run owing a wake), `JOB` (a running `bg_run` job, labelled by its description), `WAKEUP` or `LOOP` |
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
| `failureCode` | `TURN_FAILED` · `TURN_STOPPED` · `TIMED_OUT` · `EMPTY_NOTE` · `REPLACE_FAILED` · `COORDINATOR_CANT_RUN`, or null |
| `failureReason` | the whole sentence, e.g. "The handoff note wasn't written: the turn failed." |
| `handedOverToSessionId` | the successor once `COMPLETED` ("Handed over to a new coordinator. Open it") |
| `successor` | `{ engine, provider, model }` the owner named for the successor, or null (it keeps this coordinator's) |

`coordinatorHandoffReceived: SessionCoordinatorHandoffReceived | null` is set on the **successor**.

| Field | Meaning |
|---|---|
| `handoffFromSessionId` | the previous coordinator; the note card links to it |
| `note` | the note text, or null when it was skipped |
| `handedOverAt` | "Handoff from the previous coordinator · 3:42 PM" |
| `movedWaits` | `CoordinatorPendingWait[]` that moved here ("2 waits moved here"), every kind; one recorded before `kind` existed reads as `WATCH` |

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

## Phones

- **Confirm.** iOS and Android say board 03 iOS 2's words: the title, then one body,
  `coordinatorHandoffPhoneConfirmBody` in `@orbit/shared` (OrbitKit `CoordinatorContextCopy.phoneConfirmBody`,
  Android `CoordinatorHandoffCopy.phoneConfirmBody`). The waits are a count inside the body, none when there are none;
  there is no Handoff note row and no wait names. Each client's copy-parity test reads its body against the shared one.
- **Button order on iOS.** Board 03 ② draws Hand over, bold, above Cancel. The confirm is SwiftUI's system `.alert`,
  which takes no layout axis: with two buttons that fit, UIKit sets them side by side, the `.cancel` role leading. That is
  the accepted reading; Hand over stays the bold default action. Android's `AlertDialog` puts Cancel then Hand over in a row.
- **A refused press.** Every client leads with `refused` ("Couldn't hand over"), as web's "Couldn't compact" does: web
  toasts it with the server's message under it; Apple's status line and Android's toast or confirm read
  "Couldn't hand over: <reason>".
