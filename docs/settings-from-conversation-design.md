# Settings from a conversation: design (v1)

**Status:** **proposed** (2026-11-19), nothing built. Board:
[docs/mocks/settings-from-conversation](./mocks/settings-from-conversation/01-board.html) (parts 1–5, called *board N*
below). The owner settled its three open questions on 2026-11-19: Q1 A, Q2 A, Q3 A (§2).

A person who hits a problem in a conversation can have it fixed there. When the fix is one of their own Settings,
the agent **proposes** the change, Orbit shows the owner a card with each setting's current and new value, and the
server writes the change only when the owner approves it. The agent's credential never writes a preference.

In short:

- one new owner-request kind, `SETTINGS_CHANGE`, filed by a new MCP tool `settings_propose` (CLI
  `orbit settings propose`) and answered by the owner through a new owner-channel route;
- every preference key is in one of three tiers (§3); tier 3 (a change that gives agents more reach) cannot be
  proposed and is refused `403 SETTING_OWNER_ONLY` with a link to the Settings row;
- every change made this way is marked on its Settings row ("Set from <conversation> · 2 min ago · Undo") until the
  owner changes that setting themselves.

## 1. Today

- `PATCH /users/me/preferences` (`src/apiserver/src/users/users.controller.ts`) writes every preference. The
  controller is `@PatForbidden('ACCOUNT')`: no personal access token reaches it, and a terminal credential is
  refused because the route declares no `@TerminalRoute`. Only a signed-in app session writes preferences.
- No MCP tool or CLI command reads or writes preferences (`src/runner-go/operation_catalog.go`).
- So an agent can only give directions ("Open Settings → General → Translation…"), the way `orchestrationOffMsg`
  (`src/runner-go/mcp.go`) does for the orchestration switch. The person leaves the conversation to look for the row
  (board 1, frame ①).
- Provider, agent and merge-check changes already go through a confirmation card, but the **runner** asks
  (`askBeforeCreate` in `provider_cli.go`) and then calls a route the session's credential is allowed to write. That
  shape is what Q1 B proposed and the owner rejected for preferences (§2).
- The shape the owner chose already exists for one case: a `WIKI_CREATE` owner request
  (`src/apiserver/src/owner-requests/`). The agent files it with `request_owner_action`; only the owner's
  `POST /owner-requests/:id/create-wiki` makes the wiki. That route is `@PatForbidden('OWNER_INTERACTIVE')`, is
  listed in `OWNER_INTERACTIVE_ROUTES` (`auth/pat-owner-channel-routes.ts`), and refuses a request that carries an
  acting session (`WIKI_OWNER_CHANNEL_ONLY`). `SETTINGS_CHANGE` copies it.

## 2. Decisions (owner, 2026-11-19)

| Question | Answer | Consequence |
|---|---|---|
| Q1. Who enforces the card? | **A: the server holds the proposal** | A `SETTINGS_CHANGE` owner request; the write happens inside the owner's answer. `@PatForbidden('ACCOUNT')` stays as it is. |
| Q2. May changes that only tighten things go through a card? | **A: yes** | The server decides the direction from the key, the current value and the new value (§3.2). |
| Q3. Do harmless settings skip the card? | **A: no, every change asks** | There is no direct write and no "Always allow" for settings. |

## 3. Tiers

The tier table lives once, in `src/shared/src/settingsTiers.ts`. The apiserver, the runner's tool descriptions
(through the catalog text) and the clients read the same keys. A key that is not in the table cannot be proposed:
adding a preference without placing it in a tier fails a census test (§9).

### 3.1 The table

| Tier | Keys (from `UpdatePreferencesDto`) | In a conversation |
|---|---|---|
| **1. Personal** | `theme`, `translationEnabled`, `translationLanguage`, `translationAgentLanguage`, `translationBilingual`, `notifySessionFinished`, `notifyAgentMessage`, `recaps`, `promptSuggestions`, `promptOptimizer` | Proposed, then a card |
| **2. Defaults for new work** | `defaultModel`, `defaultModels`, `defaultEffort`, `modelRouting` | Proposed, then a card that also says "Applies to new sessions only." |
| **3. Agent reach** | `enableOrchestration`, `defaultPermissionMode`, `subagentBlockedProviders` | Only the narrowing direction (§3.2) can be proposed, then a card. The widening direction is refused `SETTING_OWNER_ONLY` (§6). |
| **Not a preference** | Profile (name, photo), access tokens, sign-in methods, push devices, integrations | Out of scope. `settings_propose` names preference keys only. |

### 3.2 Narrowing in tier 3

The server works out the direction for each proposed key by comparing its current value with the new value:

| Key | Narrowing (may be proposed) | Widening (refused) |
|---|---|---|
| `enableOrchestration` | `true → false` | `false → true` |
| `subagentBlockedProviders` | adds providers and removes none | removes any provider |
| `defaultPermissionMode` | new value is `plan` or `default` | any other new value |

`defaultPermissionMode` is ranked by those two values on purpose, not by a total order of all six modes: whether
`dontAsk` is stricter than `acceptEdits` depends on the engine and the allow-list, so any move that does not land
on `plan` or `default` is treated as widening.

A proposal that mixes keys is judged per key. A proposal with any refused key is refused whole and writes nothing,
so a card never shows half of what the agent asked for.

## 4. Flow

```
agent ──settings_propose{changes, why}──▶ runner ──POST /runner/settings-proposals──▶ apiserver
                                                                                     │ tiers (§3), validate values,
                                                                                     │ capture current values
                                                         403 SETTING_OWNER_ONLY ◀────┤ (tier 3 widening)
                                                                                     ▼
                                                                   OwnerRequest{kind: SETTINGS_CHANGE, PENDING}
                                                                                     │ card in the transcript,
                                                                                     │ Open items, push
owner ──Save changes──▶ client ──POST /owner-requests/:id/apply-settings──▶ apiserver: re-check, write, provenance
                                                                                     │ DONE
agent ◀──── the request's ending, delivered as request_owner_action endings are today ┘
owner ──Chat about this──▶ DECLINED with the reason typed next → the agent reads it as for any declined card
```

`settings_propose` returns at once with the request (`ok: true, outcome: written`, `id`, `status: PENDING`), as
`request_owner_action` does. The agent does not poll: the ending reaches the session the same way an owner request's
ending reaches it today (`owner-request-endings.ts`).

## 5. Server

### 5.1 Filing: `POST /runner/settings-proposals`

A runner route, authenticated as the session's runner and naming the session in the session header (as
`POST /runner/owner-requests` does).

Body:

```json
{
  "changes": { "translationEnabled": true, "translationLanguage": "zh-Hans" },
  "why": "You asked to read replies in Chinese."
}
```

The route:

1. Checks that every key of `changes` is in the tier table. Values are validated with the same rules as
   `UpdatePreferencesDto`. `defaultModels` entries are normalised with `normalizeDefaultModels`, as the PATCH does.
2. Reads the current preferences and records the **current value** of every key next to its new value. A change
   whose new value equals its current value is dropped. If nothing is left the route answers
   `409 SETTINGS_ALREADY_SET`, and no card is filed.
3. Applies §3.2. If any key widens agent reach the route answers `403 SETTING_OWNER_ONLY` (§6), and nothing is filed.
4. Refuses a re-file of something the owner already declined. If this session has a DECLINED `SETTINGS_CHANGE` with
   the same keys and new values, the route answers `409 SETTINGS_CHANGE_DECLINED`, giving the decline's date and
   reason. A declined card is a refusal (Agent Contract), so the agent asks the person instead of filing it again.
5. Allows one pending card per session. A new filing **withdraws** that session's previous PENDING
   `SETTINGS_CHANGE` (`WITHDRAWN`), so the owner never answers a stale card.
6. Files `OwnerRequest{kind: 'SETTINGS_CHANGE'}`. The server writes the card's title: "Change N setting(s)?", for
   example "Change 2 settings?". The `why` text is stored as the request's `why` and shown as the agent's words.
   The payload is `{changes: [{key, from, to, tier}]}`.

### 5.2 Answer: `POST /owner-requests/:id/apply-settings`

- `@PatForbidden('OWNER_INTERACTIVE')`, added to `OWNER_INTERACTIVE_ROUTES` and to `common/db-write-inventory.ts`.
- Refuses a request that carries an acting session with `SETTINGS_OWNER_CHANNEL_ONLY`, as `create-wiki` does. A
  session can never approve its own card, even with the owner's login.
- In one transaction, the route does three things:
  1. Re-reads the preferences. If any key's current value is no longer the `from` value on the card, it answers
     `409 SETTINGS_STALE` and writes nothing. The card then says "This setting changed since it was proposed."
     The request stays PENDING, so the owner can still decline it, and the agent may propose again.
  2. Merges `to` into `User.preferences` the same way the PATCH merges.
  3. Writes the provenance (§5.3) and settles the request DONE.
- Decline uses the existing `POST /owner-requests/:id/decline`.

### 5.3 Provenance and Undo

`User.preferences.changedBy` is a map from a key to `{sessionId, requestId, at, from}`. It is written by the
apply-settings route (§5.2) for every key the route writes.

- `PATCH /users/me/preferences` deletes `changedBy[key]` for every key it writes. Any change the owner makes in the
  app, Undo included, ends the mark. That is board 3, note 9.
- **Undo** is the client sending a normal PATCH with `from`. There is no new route: the owner is pressing a button
  in their own signed-in app.
- `GET /users/me` returns `changedBy` together with the session's title. The Settings row needs the title to name
  the conversation.

The default permission mode also has an append-only audit history. Both a preferences PATCH and a
settings-card approval write changes to `activity` in the same transaction as the preference update.
The row records the account owner, time, previous and new values, and the app when the request identifies it.
An omitted client is recorded as `unknown`.

```sql
SELECT actor_id, created_at, payload
FROM activity
WHERE type = 'preferences.default_permission_mode.changed'
  AND actor_id = $1::uuid
ORDER BY created_at DESC, id DESC;
```

## 6. Tier 3: refusal and the link

The `403 SETTING_OWNER_ONLY` body names each refused key:

```json
{
  "code": "SETTING_OWNER_ONLY",
  "message": "\"Let sessions orchestrate\" gives agents more reach; only you can turn it on, in Settings.",
  "settings": [{ "key": "enableOrchestration", "title": "Let sessions orchestrate",
                 "path": "/settings/general", "link": "orbit-settings:enableOrchestration" }]
}
```

- The titles and paths come from `PERSONAL_SETTINGS` (`src/web/src/pages/settings/settingsIndex.ts`). That table
  moves to `src/shared` so the server can read it, and the web keeps importing it.
- The agent puts the link in its reply: `[Let sessions orchestrate](orbit-settings:enableOrchestration)`. Clients
  draw an `orbit-settings:` link as the link card on board 2, frame ③, with an **Open in Settings** button. The
  button opens Settings, scrolls to the row and flashes it, using the existing `data-setting-anchor` search
  behaviour. On a phone it opens the same row.
- `orchestrationOffMsg` (`mcp.go`) gains the same link, so the orchestration-off refusal points to the row too.

## 7. Runner, MCP and CLI

| Tool | CLI | What it does |
|---|---|---|
| `settings_get` | `orbit settings get [--json]` | Reads the owner's preference keys with their current values and tiers, and the Settings title of each key. Read-only. |
| `settings_propose` | `orbit settings propose --set key=value … --why TEXT [--json]` | Files §5.1. `Mutates: true`, `SessionOnly: true`: a terminal has no conversation to put a card in. |

- Both tools are listed whether or not Session orchestration is on. They are needed to fix ordinary settings, and
  turning orchestration off is itself a valid proposal.
- The catalog description of `settings_propose` states the tiers, the refusal codes (`SETTING_OWNER_ONLY`,
  `SETTINGS_CHANGE_DECLINED`, `SETTINGS_ALREADY_SET`), and the rule that a declined card is not filed again.
- The primer gains one sentence: *When a person's problem is one of their own Settings, call settings_get, then
  settings_propose the change; for a key it refuses, link the row it returns instead of describing where it is.*

## 8. Clients

Copy is English (CLAUDE.md §5). The strings below are the copy to ship.

### 8.1 The card (board 1, frame ②)

- An owner-request card in the transcript, drawn with the existing confirmation-card look (`approval-card`). It also
  appears in Open items and is pushed to the owner's devices, as other owner requests are.
- Heading: `⚙️ Confirm: change 2 settings?`. Below it, the Settings page the keys are on, for example
  `Settings › General › Translation`. When keys come from several pages, each row names its own page.
- One row per key: the title, the `from` value struck through, `→`, and the `to` value. The values are shown as the
  Settings page shows them, for example `Chinese (Simplified)`, not `zh-Hans`.
- Tier 2 keys add `Applies to new sessions only.` under their row.
- The agent's reason, in grey: `The agent says: <why>`. Then the foot: `Only these change. You can change them back in
  Settings.`
- Buttons: **Save changes** (Enter) and **💬 Chat about this**. There is no **Always allow**.
- Once answered, the card folds to one line: `✓ Changed 2 settings · Undo`, or `Declined`, or
  `This setting changed since it was proposed.` when the apply was stale.

### 8.2 The Settings row (board 3)

When `changedBy[key]` is set, the row shows one more line in the description's grey, with no colour and no frame:
`Turned on from <conversation title> · 2 min ago · Undo`, or `Set from …` when the value is not a switch. The title
links to the conversation. Undo sends the PATCH from §5.3.

### 8.3 Platforms

Web first. iOS and macOS then draw the same card and line in OrbitKit. Android follows iOS. The copy-parity tests
that already pair web and native strings cover the new strings.

## 9. Tests

- **Shared:** the tier census. Every `UpdatePreferencesDto` key is in exactly one tier. A new key that is in no tier
  fails the test.
- **Apiserver unit:** the narrowing rules in §3.2, one case per row and direction, including mixed proposals.
- **pg specs:**
  - filing per tier;
  - `SETTING_OWNER_ONLY` with the link body;
  - `SETTINGS_ALREADY_SET`;
  - a re-file after a decline is refused;
  - a second filing withdraws the first;
  - apply writes the preferences and the provenance;
  - a stale apply returns `409` and writes nothing;
  - an apply that carries an acting session is refused;
  - a personal access token on apply is refused (`pat-owner-channel.pg.spec.ts` picks the route up from the list);
  - a PATCH clears the provenance;
  - the new runner route is added to `auth/tenant-isolation-runner-cases.ts`: one account's runner cannot file a
    card on another account.
- **Runner:** catalog and tool tests for both tools, and the request body and receipts against a fake server.
- **Real binary:** one pg spec that drives the built `orbit settings propose` end to end, including the owner's
  apply.
- **Web:** the card body, the folded states, the `orbit-settings:` link card, and the Settings row line with Undo.

## 10. Landing order

1. `src/shared`: the tier table, the narrowing rules, `PERSONAL_SETTINGS` moved, and the census test.
2. Apiserver: the `SETTINGS_CHANGE` kind, `/runner/settings-proposals`, `apply-settings`, the provenance on
   PATCH and `me`, and the refusals.
3. runner-go: `settings_get` and `settings_propose`, the CLI, the catalog, the primer line and the
   `orchestrationOffMsg` link.
4. Web: the card, the `orbit-settings:` link card and the Settings row line.
5. iOS and macOS (OrbitKit), then Android: the same card, link and line.

Steps 1–3 are usable on their own: the card falls back to the generic owner-request card until step 4.

## 11. Not in v1

- Workspace and agent settings. Those already have their own `agent_update` card.
- Changing profile, access tokens, sign-in methods or push devices from a conversation.
- Proposals from a terminal with no session.
- Changing several accounts' settings: a proposal acts on the session owner's account only.
