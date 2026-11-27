# Owner request changes: an agent proposes a setting, the owner applies it with one press

> Status: approved by the owner on 2026-11-14 with all three recommendations in §8. Nothing here is built yet.
> Code baseline: main `87c394579`. Line numbers refer to that commit.
> Mockups: `docs/mocks/owner-request-change/board.html` (web, macOS, iPhone, Android).

## 0. Summary

Today an agent that sees an overloaded runner can only tell the owner to lower its concurrency by hand: open the
runner page, find Capacity › Max Concurrent, type a number. The agent cannot do it itself, and that is correct: the
door is `PATCH /runners/:id`, closed to every token but the owner's own sign-in (`@PatForbidden('RUNNER_CONTROL')`,
`src/apiserver/src/runners/runners.controller.ts:91`).

**Recommendation.** A fifth owner request kind, `CHANGE`. The agent files the exact change it wants
(`wikova: Max Concurrent → 6`) with `request_owner_action`. The owner sees a card with the live current value, the
proposed one and an **Apply** button. Apply is a new owner-only door that writes the setting and ends the request DONE
in one transaction. The agent gets the outcome as a turn, the same as every other owner request.

The agent still never writes the setting. What changes is that the owner's part shrinks from "go and find it" to
"read one line and press Apply".

**Three decisions, ruled by the owner on 2026-11-14 (§8): all three as recommended.**

1. The owner can edit the number on the card before applying. Recommended: yes.
2. v1 covers one setting only, a runner's Max Concurrent. Recommended: yes, with a typed allow-list that later
   settings join one at a time.
3. When the setting has changed since the agent asked, Apply still writes the requested value, and the card says
   what it is now. Recommended: yes, no refusal.

## 1. Constraints from the code today

| Fact | Where | Consequence |
|---|---|---|
| Max Concurrent is written only by `PATCH /runners/:id`, owner sign-in only | `runners.controller.ts:91`, `runners.service.ts:505` | Agents cannot write it, and this design keeps it that way. |
| A new value takes effect at the next claim; running turns are not stopped | `runners.service.ts:517` | Lowering is safe to apply at any time. The card has to say that nothing running stops. |
| `maxConcurrent` has a floor of 1 and no ceiling | `src/apiserver/src/runners/dto.ts:24` | The filing applies the same rule. |
| Agents already read `maxConcurrent` from `runner_list` | `src/runner-go/mcp.go:5315` | An agent can name the current value; the server records it anyway. |
| Owner requests have four kinds, enforced by a CHECK | `prisma/migrations/0503_owner_request/migration.sql:57` | `CHANGE` needs a migration. |
| Every ending enqueues exactly one turn to the asker, in the ending's transaction | `owner-requests/owner-request-endings.ts:15` | Apply reuses this, so the agent is told without new plumbing. |
| SECRET already pairs a typed spec (`secret_spec`) with a door of its own (`/:id/secret`) | `owner-requests.controller.ts:60` | `CHANGE` follows the same shape: `change_spec` and `/:id/apply`. |
| The runner list reports `activeSessions` per runner | `runners.service.ts:273` | The card can show "8 running now" without a new query. |

## 2. Filing

`request_owner_action` gains `kind: "CHANGE"` and one field, `change`:

```json
{
  "kind": "CHANGE",
  "title": "Lower wikova to 6 concurrent sessions",
  "why": "wikova has run at 12/12 for 40 minutes; the cutover rehearsal needs headroom.",
  "change": { "runnerId": "<wikova>", "maxConcurrent": 6 },
  "blocksTaskIds": ["<rehearsal task>"]
}
```

Rules, checked by the server when the request is filed:

- `change` is required for `CHANGE` and refused for every other kind. `options`, `steps` and `secretSpec` are refused
  for `CHANGE`, the same as the existing kind/field rules (`owner-request.ts#normalizeOwnerRequest`).
- `change` names exactly one setting. v1 allows one: `maxConcurrent`, an integer of at least 1.
- `runnerId` must be a runner of the asking session's owner. Any other id is refused as not found, the same answer
  `GET /runners/:id` gives.
- The value must differ from the current one. Asking for the value already set is refused with
  `OWNER_REQUEST_CHANGE_NOOP`, so no card is ever shown that would change nothing.
- The server stores `change_spec = { runnerId, field: "maxConcurrent", requested: 6, before: 12 }`. `before` is read
  by the server when the request is filed, never taken from the caller.
- **One pending change per runner setting.** A new filing for the same `(owner, runnerId, field)` ends the older one
  WITHDRAWN with the note `Replaced by a newer request`, in the same transaction. That ending reaches the older asker
  as a turn like any other. The rule is enforced by a partial unique index, so two filings that race cannot both stay
  pending.

CLI parity: `orbit owner-request --kind CHANGE --runner <id|name> --max-concurrent 6 --title … --why …`
(`cli_mcp_parity_test.go` covers it).

## 3. The card

The card is the existing owner request card (`src/web/src/components/OwnerRequestCard.tsx`) with one new body section,
in the conversation that asked and in Waiting on you, on all four clients.

```
● Waiting on you                       Asked 2m ago
Lower wikova to 6 concurrent sessions          SETTING
<why, as markdown>

  wikova · Max Concurrent
  12  →  [ 6 ]            8 running now
  Nothing running stops. New sessions wait until fewer than 6 run.

Holding up   Rehearse the cutover on 10.66.0.4

[ Apply ]  Decline…  Remind me later
```

- **Kind tag** `SETTING`. **Primary button** `Apply`.
- **Live current value.** The left number is the runner's value now, read from the runner list, not `before`. When the
  two differ, a line under it says `Was 12 when asked.`
- **Number field**, pre-filled with the requested value, integer ≥ 1 (decision 1). If the owner changes it, the button
  stays `Apply` and the result names the applied value.
- **Consequence line**, worded for the direction:
  - lower: `Nothing running stops. New sessions wait until fewer than N run.`
  - higher: `Up to N sessions can run at once on this machine.`
- **Offline runner.** The value is stored on the server and read at each claim, so it applies whether the machine is
  online or not. The card adds no offline warning.
- **Push notification body**: the title, as for every owner request.

Ended card, one line as today: `Applied: wikova Max Concurrent 12 → 6 · by you · 12:58 · iPhone`. When the owner
changed the number, the line ends `(asked for 6)`.

## 4. Applying

New door: `POST /owner-requests/:id/apply` with body `{ "maxConcurrent": 6 }`.

- Guarded like `PATCH /runners/:id`: the owner's sign-in only, `@PatForbidden('RUNNER_CONTROL')`. No runner token,
  orchestration token or PAT can apply a change, including the agent's own.
- One transaction:
  1. Lock the request `FOR UPDATE`; refuse with `OWNER_REQUEST_NOT_PENDING` or `OWNER_REQUEST_EXPIRED` as the other
     doors do.
  2. Lock the runner row; refuse with 404 if it is gone (the owner can still Decline).
  3. Read `actualBefore`, write `runner.max_concurrent`.
  4. End the request DONE with `answer = { applied: 6, actualBefore: 12 }`, then `enqueueResolutions`.
- The write goes through the same service method the runner page uses (`RunnersService.updateRunner`), so there is
  one place that writes the setting and both paths share its rules.
- `POST /:id/done` is refused for `CHANGE`. The only way to DONE is Apply, so a DONE change request always means the
  setting was written.

## 5. What the agent receives

The existing resolution turn (`owner-request.ts#ownerRequestResolutionTurn`), whose JSON payload gains:

```json
"change": { "runnerId": "…", "field": "maxConcurrent", "requested": 6, "applied": 6, "before": 12, "actualBefore": 12 }
```

DECLINED, EXPIRED and WITHDRAWN carry the same `change` without `applied`. The tool description tells the agent to
read `applied`, not `requested`: the owner may have chosen a different number.

## 6. Data

Migration `06xx_owner_request_change`:

- `owner_request_kind_chk` gains `'CHANGE'`.
- `owner_request.change_spec JSONB`, with CHECK `("kind" = 'CHANGE') = ("change_spec" IS NOT NULL)`.
- Partial unique index on `(owner_id, (change_spec->>'runnerId'), (change_spec->>'field')) WHERE state = 'PENDING'
  AND kind = 'CHANGE'`.
- `db-write-inventory.ts` gains the apply door's entry: locks request (owner_request) then runner, in that order.

No audit table is added: the request row already records who applied what, from which value, when and from which
device.

## 7. Work

| # | Part | Where |
|---|---|---|
| 1 | Migration, kind rules, filing validation, supersede | `prisma/migrations`, `owner-requests/owner-request.ts`, `owner-requests.service.ts` |
| 2 | Apply door, payload `change` | `owner-requests.controller.ts`, `owner-requests.service.ts`, `owner-request.ts` |
| 3 | MCP and CLI `change` | `src/runner-go/mcp.go`, CLI, `cli_mcp_parity_test.go` |
| 4 | Web card | `OwnerRequestCard.tsx`, `lib/ownerRequests.ts` |
| 5 | macOS / iOS card | `OrbitKit/App/OwnerRequests.swift`, `Models/OwnerRequestModels.swift` |
| 6 | Android card | `app/.../cards/OwnerRequestViews.kt`, `core/.../cards/OwnerRequests.kt` |

Tests (pg specs): file → apply → runner written, DONE, one turn enqueued; owner edits the value; decline; supersede
by a second filing; two racing filings; another owner's runner refused; no-op refused; `/done` refused for CHANGE; a
PAT refused at `/apply`; runner deleted while pending.

## 8. Decisions (ruled 2026-11-14: as recommended)

1. **Editable number on the card.** Recommended: yes. An owner who agrees the machine is overloaded but wants 8
   rather than 6 would otherwise have to decline and wait for a new request. Against: the agent's plan may assume
   exactly 6, which is why the turn reports `applied`.
2. **v1 scope: Max Concurrent only.** Recommended: yes. `change` stays a typed allow-list. Keep Free
   (`minFreeDiskMb`) is the obvious next entry; a project's "tasks at a time" already has its own start request. A
   generic "set any field" request is not offered.
3. **Changed since asked.** Recommended: apply anyway and show `Was 12 when asked.` The owner is looking at the live
   value when pressing Apply, so a refusal would only make them file the request again. The turn reports
   `actualBefore` so the agent can see that the value had moved.
