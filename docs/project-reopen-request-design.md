# Asking to reopen a settled project: design (v1)

Status: approved by the owner 2026-11-24 (Q1 A, Q2 A). Board: `docs/mocks/project-reopen-request/`.

An agent whose write lands on a project that is DONE or CANCELLED is refused today, and the refusal ends with
"only the owner can reopen it". The agent has no way to ask. It can only tell the person in prose, and the person
then has to find the project, press Reopen and come back to say so. This design gives the agent a tool for that,
`project_request_reopen`. The owner gets a card with the agent's reason and the work it wants to add, and answers
**Reopen** or **Chat about this** on it.

The owner's Reopen press stays the only write that reopens a project. The request grants nothing. It is the same
press as `PATCH /projects/:id {status: OPEN}`, made from a card.

## 1. Today

- The refusals. Four sites refuse work on a settled project and name a reopen as the way through:
  - `R8_SETTLED_PROJECT` / `R8B_SETTLED_CRITERION_SERVED` → `REOPEN_PROJECT_FIRST`
    (`src/apiserver/src/projects/project-scope-contract.ts:484`, prose in `project-scope-admission.ts:249`);
  - the task-move check in `src/apiserver/src/tasks/tasks.service.ts:7001`;
  - the handoff check in `src/apiserver/src/projects/project-handoff.service.ts:632`;
  - criterion moves in `src/apiserver/src/projects/criterion-move.ts:145-150`.
- The press. Only the owner's signed-in credential can reopen: `PATCH /projects/:id {status: OPEN}`, recorded by
  `ProjectsService.reopenRecord` → `reopenRecordOfPress` (`project-done-derived.ts:831`, migration 0469). A session or
  a token is refused this write whole (`docs/human-only-authority.md`, "Reopen project").
- The doors that already exist. A coordinator asks the owner to start (`project_request_start`, `START_REQUEST`) or to
  record done (`project_request_done`, `DONE_REQUEST`). Any session asks for a Settings change (`settings_propose`,
  owner request `SETTINGS_CHANGE`, `docs/settings-from-conversation-design.md`). Nothing asks for a reopen.

## 2. Decisions (owner, 2026-11-23)

| # | Question | Answer |
|---|----------|--------|
| D1 | Who may ask | **Any session** of the account whose write was refused. The card names the session and says why. |
| D2 | What the request carries, and what approval does | **The reason and the planned work, as text.** Approval only reopens. The agent then retries its own write. |
| D3 | Process | Design doc and board first, then an Orbit project. |
| Q1 | Where the request lives (2026-11-24) | **A: an owner request `PROJECT_REOPEN`**, as `SETTINGS_CHANGE`. |
| Q2 | How many cards (2026-11-24) | **A: one per project**; later askers join it. |

## 3. Flow

```
agent ─write─▶ apiserver: 409 PROJECT_REOPEN_REQUIRED (REOPEN_PROJECT_FIRST)
        │      next step named: project_request_reopen {projectId, why, plannedWork}
        ▼
agent ──project_request_reopen──▶ runner ──POST /runner/projects/:id/reopen-requests──▶ apiserver
                                                                     │ project is DONE or CANCELLED?
                                       409 PROJECT_ALREADY_OPEN ◀────┤ (nothing to ask)
                                       409 REOPEN_REQUEST_DECLINED ◀─┤ (this session asked the same, owner said no)
                                                                     ▼
                                          OwnerRequest{kind: PROJECT_REOPEN, PENDING}
                                                                     │ card in the asking transcript,
                                                                     │ Needs you, project page row, push
owner ──Reopen──▶ client ──POST /owner-requests/:id/reopen-project──▶ apiserver, one transaction:
                                                                     │ status OPEN + reopenRecordOfPress,
                                                                     │ every PENDING PROJECT_REOPEN of the project → DONE
agent ◀── the request's ending, delivered as owner-request endings are today (owner-request-endings.ts)
coordinator ◀── tellCoordinatorProjectReopened, as for a press on the project page (if it is not the asker)
owner ──Chat about this──▶ DECLINED with the reason typed next → the agent reads it as for any declined card
```

`project_request_reopen` returns at once (`ok: true, outcome: written`, the request `id`, `status: PENDING`). The agent
does not poll. When the ending arrives it retries the write that was refused.

## 4. Server

### 4.1 Filing: `POST /runner/projects/:id/reopen-requests`

A runner route. It is authenticated as the session's runner and names the session in `X-Orbit-Session-Id`, as
`POST /runner/owner-requests` does. A missing session header is a 400: the request is always some session's.

Body:

```json
{
  "why": "The release checklist found the Android share sheet still opens the old screen.",
  "plannedWork": "Add a criterion for the Android share target and one task to fix it."
}
```

The route:

1. Reads the project under the owner (404 otherwise). If it is OPEN, answers `409 PROJECT_ALREADY_OPEN` and files
   nothing: the agent retries its write.
2. Requires `why` and `plannedWork`, each trimmed, non-empty, at most 2,000 characters.
3. Refuses a re-file of something the owner already declined. If this session has a DECLINED `PROJECT_REOPEN` for this
   project since the project was last settled, the route answers `409 REOPEN_REQUEST_DECLINED` with the decline's date
   and reason. A declined card is a refusal (Agent Contract), so the agent asks the person instead of filing again.
4. Keeps one pending card per project (Q2 A). A second session asking while one is PENDING gets the
   PENDING request back with `alreadyOpen: true` and is added to its `askers`, so its ending reaches it too. The card
   shows "Also asked by …".
5. Files `OwnerRequest{kind: 'PROJECT_REOPEN'}`. The server writes the title, "Reopen project “<title>”?". `why`
   is the request's `why`. The payload is `{projectId, statusAtAsk: 'DONE' | 'CANCELLED', settledAt, plannedWork}`.
6. The card goes through owner-card translation (`sessions/card-translation.ts`) like the other owner cards, so the
   owner reads `why` and `plannedWork` in their language.

`PROJECT_REOPEN` is filed only by this route, as `SETTINGS_CHANGE` is filed only by `POST /runner/settings-proposals`.
It is added to `FiledOwnerRequestKind`, not to `OWNER_REQUEST_KINDS` (`owner-request.ts:13`), so
`request_owner_action` cannot file one with a free-form payload.

### 4.2 Answer: `POST /owner-requests/:id/reopen-project`

- `@PatForbidden('OWNER_INTERACTIVE')`, added to `OWNER_INTERACTIVE_ROUTES` and to `common/db-write-inventory.ts`.
- Refuses a call that carries an acting session (`REOPEN_OWNER_CHANNEL_ONLY`), as `apply-settings` does. A session
  can never approve its own card, even with the owner's login.
- In one transaction:
  1. Locks the project row. If it is OPEN already (the owner pressed Reopen on the project page meanwhile), the request
     settles DONE with the note "Already reopened", and the route answers 200 with no second press.
  2. Otherwise writes `status: OPEN` plus `ProjectsService.reopenRecord`'s record: exactly the page's press, so the
     projection treats it as the owner's Reopen (it stands until the owner records done, the seal moves or a task
     serving a criterion changes).
  3. Settles every PENDING `PROJECT_REOPEN` of the project DONE.
- After commit: the coordinator is told by `tellCoordinatorProjectReopened`, unless the coordinator is an asker
  (it gets the ending instead, so it is not told twice). The project's list attention and SSE frames move as for the
  page's press.
- Decline uses the existing `POST /owner-requests/:id/decline`.

### 4.3 The project page's press settles the cards too

A Reopen pressed on the project page (`PATCH /projects/:id`) settles every PENDING `PROJECT_REOPEN` of the project DONE
in the same transaction ("Reopened from the project page"), so no card stays up for a project that is already open.
A project deleted with a PENDING request withdraws it (`WITHDRAWN`, "The project was deleted").

### 4.4 The refusals name the tool

Each of the four refusals in §1 keeps its code and adds the next step, in English:

> Project “Share to Orbit” is DONE and takes no new work until the account owner reopens it. To ask them, call
> project_request_reopen with the project id, why, and the work you plan to add, then retry this write once the
> request is answered. A finding that changes no acceptance criterion belongs in a new project instead.

`ACCEPTANCE_FINDING_ROUTING` stays: a reopen is for work that changes the settled project's criteria. The structured
refusal also gains `nextTool: "project_request_reopen"`, read by `refusal-recovery.ts`.

## 5. Runner, MCP and CLI

- MCP tool `project_request_reopen {projectId, why, plannedWork}` in `src/runner-go/` beside `project_request_done`.
  It is session-only and mutating, and is listed in `operation_catalog.go`, `docs/operation-catalog.md` and the
  generated agent tools guide (`AgentToolsGuide.generated.swift`, `docs/agent-tools-guide.md`).
- CLI `orbit project request-reopen PROJECT_ID --why TEXT --planned-work TEXT [--json]`.
- `withdraw_owner_request` works on it unchanged. A session that no longer needs the reopen withdraws its ask. The
  request is WITHDRAWN when its last asker withdraws.
- The tool description says: "Ask the account owner to reopen a DONE or CANCELLED project. Run it when a write was
  refused with PROJECT_REOPEN_REQUIRED and the work changes that project's acceptance criteria. It returns at once.
  When the owner answers you are told: on Reopen, retry your write; on a decline, do not ask again; tell the person."

## 6. Clients

### 6.1 The card (board 1 ②, board 2)

Drawn with the existing owner-request card, as `SETTINGS_CHANGE` is. Nothing new in look.

- Title: ↺ **Reopen project “<title>”?**
- A line under the title: **DONE since Nov 18** (or **Cancelled since …**), linking to the project.
- **Why**: the agent's reason, in the agent's voice: "The agent says: …".
- **Planned work**: the `plannedWork` text, under its own small label.
- Asker: "Asked by <session title>" when the card is shown outside that session. "Also asked by …" when there are
  more askers.
- Buttons: **Reopen** (⏎) / **💬 Chat about this**. There is no Always allow: every reopen asks.
- After the answer, the card collapses to one line: "Reopened · Nov 23 14:02" or "Declined: <reason>".

### 6.2 Where it shows

- In the asking session's transcript, at the tool call (as every owner request).
- In Needs you (web `WaitingOnYouPage`, macOS/iOS, Android), with the project name.
- On the project page, above the DONE header: one row "An agent asked to reopen this project" with the same two
  buttons (board 2 ③). The card is not drawn twice in one view.
- A push: "<session> asks to reopen “<project>”".

### 6.3 Platforms

Web, Apple (OrbitKit + OrbitApp, iOS and macOS), Android. Each platform adds the kind to its owner-request model
(`ownerRequests.ts`, `OwnerRequestModels.swift`, `OwnerRequests.kt`), renders the card from the shared fields, and calls
`reopen-project`. Each platform task first checks how today's build draws an owner-request kind it does not know,
because shipped clients will meet `PROJECT_REOPEN` before they are updated. The owner must still be able to answer on
the project page.

## 7. Authority

`docs/human-only-authority.md` gains one row: **Ask to reopen a project**, any session, filing only. The **Reopen
project** row is unchanged. Its press can now also be made from the card, through the owner REST row, and it is
refused to a session and to a token.

## 8. Tests

- pg spec `project-reopen-request.pg.spec.ts`:
  1. Filing on a DONE project and on a CANCELLED project files one PENDING card with the payload. Filing on an OPEN
     project → `409 PROJECT_ALREADY_OPEN`, nothing filed.
  2. A second session asking → same request, `alreadyOpen: true`, both askers. Both get the ending.
  3. A re-file after a decline → `409 REOPEN_REQUEST_DECLINED`. After the project is reopened and settled again, the
     same session may ask again.
  4. Answer: status OPEN, `reopened_at`/`reopened_facts` equal to what the page's press writes, every PENDING card
     DONE, the coordinator told once (not twice when it is the asker).
  5. Answer with an acting session header → `403 REOPEN_OWNER_CHANNEL_ONLY`. With a PAT → refused
     (`OWNER_INTERACTIVE`).
  6. The page's press and a project delete settle the cards (§4.3).
  7. The projection does not write DONE back over the answered request while nothing moved (the 0469 rule, through
     the new door).
- Refusal prose: each of the four sites names `project_request_reopen` (unit, plus the census in
  `refusal-recovery`).
- runner-go: the tool's schema, the CLI argv, the catalog entry, the guide regenerated.
- Each client: card render and answer, unit or snapshot tests in each platform's existing style.

## 9. Landing order

1. Server: kind, filing route, answer route, page-press settlement, refusal prose (pg spec above).
2. Runner: MCP tool, CLI, catalog, guides.
3. Web card + Needs you + project page row.
4. Apple (OrbitKit models and card, OrbitApp views).
5. Android, following iOS.

Steps 3–5 depend on 1; 2 depends on 1. Steps 3, 4 and 5 can run side by side.

## 10. Options the owner chose between (board 3; A and A chosen 2026-11-24)

- **Q1: where the request lives.**
  - **A (recommended): an owner request `PROJECT_REOPEN`**, as `SETTINGS_CHANGE` is. Any session can ask, and the
    ending reaches the asker through the existing owner-request delivery.
  - **B: a project open item `REOPEN_REQUEST`**, as `DONE_REQUEST` is. It sits naturally on the project page, but
    open items are delivered to the coordinator, so a non-coordinator asker needs new routing.
- **Q2: how many cards.**
  - **A (recommended): one per project.** Later askers join it, so the owner answers once.
  - **B: one per asking session.** Each card carries its own reason, but the owner presses Reopen on the first and the
    rest settle by themselves.

## 11. Not in v1

- Applying the refused write on approval (D2 chose text only).
- Reopening for a session's own retry automatically. The agent retries; Orbit does not replay the write.
- An agent asking to **cancel** or to **un-cancel into a new epoch** with different criteria; that is a criteria edit
  after the reopen, through the existing doors.
