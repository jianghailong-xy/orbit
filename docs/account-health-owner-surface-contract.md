# Account health: owner-surface contract (push, routes, read shapes)

What the Apple and Android clients build against for §8 of [`routing-account-health-design.md`](./routing-account-health-design.md).
Server and web implement it; all copy is English.

## 1. The push: `account-needs-action`

Sent by `PushService.notifyAccountNeedsAction` (APNs, FCM, and the owner's Feishu card). **When** is decided by the
server, once per state change (`account_health.notified_kind`); a client never decides and never de-duplicates.

| Sent | Not sent |
|---|---|
| A classified refusal (`ACCOUNT_ACTION_REQUIRED`, `CREDENTIAL_REFUSED`, `ACCESS_DENIED`): at its first occurrence | A later trip of the same kind, a refused trial, the daily trial at the cap, different wording in the same kind |
| The breaker (`UNCLASSIFIED_ADMISSION`): at its third consecutive trip | Trips 1, 2 and 4+; a classified streak turning unclassified; cool-downs (usage limit, capacity) |
| A new streak, after a success or **Check again** cleared the row, at its own alert point | The same account on another model once the account has alerted |
| A still-blocked account refused with a **different classified kind** | |

Payload (APNs JSON; FCM carries the same keys as data):

```json
{
  "aps": {
    "alert": {
      "title": "<runner name, or the provider label for a key>",
      "body": "Cursor can't run on this account: \"Add a payment method to continue\". Orbit is using your other accounts and tries this one again from time to time."
    },
    "sound": "default",
    "thread-id": "runner-<runnerId>"
  },
  "kind": "account-needs-action",
  "runnerID": "<runnerId>",
  "accountHealthID": "<public id of the account_health row>",
  "subjectKey": "runner:<runnerId>:<engine>:<account>",
  "failureKind": "ACCOUNT_ACTION_REQUIRED",
  "blockedUntil": "2026-11-22T18:19:00.000Z"
}
```

- Breaker body: `Cursor failed to start 4 runs on this account. Orbit is using your other accounts.`
- No badge, no `sessionID`. A key or pool login has no runner: `runnerID` is absent and `thread-id` is `account-<subjectKey>`.
- **Tap**: open the account row (the machine's Settings page for `runnerID`; Providers for a key). A client that does not
  know the kind must ignore the payload, as for any unknown kind. Android must list `account-needs-action` in its kind table.
- `accountHealthID` is what **Check again** takes. It may already be cleared by the time of the tap: a 404 from the route is
  "nothing to clear", not an error to show.

## 2. Routes (owner only; PAT scopes `workspaces:read` / `workspaces:write`)

### `GET /account-health` → `{ blocks: AccountHealthBlock[] }`

Blocked accounts only (state `BLOCKED`; cool-downs and suspect accounts show nothing). Source:
`src/apiserver/src/providers/account-health.controller.ts`, mirrored in `src/web/src/lib/accountHealth.ts`.

| Field | Meaning |
|---|---|
| `id` | row id; the `:id` of the check route |
| `subjectKey`, `runnerId`, `engine`, `account`, `providerId`, `poolId` | the account; match a runner's sign-in on `runnerId` + `engine` + `account` (`default` for the machine's one login) |
| `scopeModel` | `''` for the whole account; a model id for a one-model block (draw the account row from `''` rows) |
| `kind` | classified `RunFailureKind`, or `UNCLASSIFIED_ADMISSION` |
| `said` | the provider's words; null for the breaker |
| `trips` | consecutive trips |
| `since`, `nextTrialAt` | ISO instants: when the streak began, when the account is tried again |
| `trialRunning` | a trial run is under way now |
| `line` | server-built sentence without times |

The row reads, for a classified block: `Needs action · Cursor said "Add a payment method to continue" · since Nov 22, 17:19 · tried again at 21:19`;
for the breaker: `Not used for now · failed to start 2 runs · since … · tried again at …`. Both carry a **Check again** button.

### `POST /account-health/:id/check` → `{ cleared: number }`

The owner says the account is fixed. Clears the account's live rows (`cleared_by = OWNER`), resets the ladder and drops
any claimed trial. The next routed run uses the account as healthy; a refusal after it is **trip 1** of a new streak
(1 h) and alerts again. `404` when the row is not the owner's or already cleared. After it, re-read `GET /account-health`.

## 3. Held tasks and relaxed runs (the task row and view, project items)

Every client draws these the same way. Web's reference: `src/web/src/components/TaskAccountHold.tsx`.

- **Task read, list items and project task rows**: `accountHold` is served on the task read, on task list items (`GET /tasks`) and on a
  project's task rows. Null unless a hold stands. Shape: `{ kind: 'ACCOUNT_NEEDS_ACTION', reason, until, accounts: [{ provider, engine, line, until }], setting? }`.
- **On a list or project row** the person's own title keeps its normal width and truncation, exactly as on an unheld row. The hold is
  **one quiet line under the title**, in the row's secondary text style (11 px, tertiary colour), with no chip:
  `Held · <accounts[0].line, the provider's words> · Next try <time of until>` then the link **Open account** (web: `/settings/machines`).
  The text truncates; the whole sentence (`… · Open account`) is the line's hover title and its accessible name. With no `accounts`, use `reason`.
  Not drawn while the task is running or queued, or when the sign-in `hold` stands (that one wins). Web: `TaskAccountHoldLine`.
- **On the task view** the fuller block may stand: a **Held** pill, `reason` (the provider's words and `Next try at HH:MM`), **Open account**, and when
  `setting` is present (`orbit-settings:relaxBlockedPins`) **Run elsewhere** to that setting. Web: `TaskAccountHoldNote`.
- **Relaxed runs**: each session on the task read carries `route.relaxedRun`, a sentence or null: which pin, where it ran and why
  (`Pinned to cursor, which can't run now (Cursor said "…"); runs on codex instead, on the same engine, at tier M`). Draw it, as it is,
  under that run's row on the task view.
- **Project open items read**: `accountWait` is `{ taskIds, title: "N tasks wait for an account", detailLine, until } | null`: one Needs you row, like `signIns`.
- **Setting**: `relaxBlockedPins` (account preference, off by default): "Run pinned tasks elsewhere", on Model routing
  (`/settings/providers/routing`, anchor `relaxBlockedPins`; `SETTING_ROWS.relaxBlockedPins`). Providers the owner blocked stay out either way.

## 4. Keys and pool members

Blocks also land on metered keys and pool members. `GET /account-health` returns them with `providerId` (a key, or a Claude pool member,
which is a key) or `poolId` + `account` (a Codex pool login); `engine` and `runnerId` are null. `line` carries the whole lead sentence
(`Needs action · Anthropic said "…"`), because there is no engine to name. Draw it on the key's row (Providers → Keys) and on the pool
member's row, with the same times and **Check again**, calling the same route. Web: `AccountHealthProviderLine`, `AccountHealthLoginLine`.
