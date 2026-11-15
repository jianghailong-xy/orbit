# Setting up a managed runner from an existing account (design, 2026-11-14)

Status: proposed, waiting for the owner's decisions D1–D5. Design only: no product code is changed.
Board: [docs/mocks/managed-runner-existing-account-entry/board.html](mocks/managed-runner-existing-account-entry/board.html)
(rendered as `board-1.png` … `board-5.png` beside it).

## The ask

The production rollout of managed runners (task 34w2jFjODmvhRLHEaXgjA, 2026-11-14) found that only an account with
no runner and no workspace can ask for its managed runner in the UI. Every other account, the owner's included, has
no way in: the owner called `POST /api/managed-runner/ensure` from the browser console. That route is session-only
(`@PatForbidden RUNNER_CONTROL`), so neither a PAT nor the CLI is a way round it either, and should not become one.

## Today

The server already lets any account set one up. `managedRunnerStatus` gives `actions.canEnsure` to an account with
no mapping when the switch is on, the environment is available, the account is not disabled and the eligibility rule
says yes (`src/apiserver/src/managed-runners/managed-runner-status.ts`); the rule today is `EVERY_ACCOUNT`. Nothing
on the server looks at how many runners the account has.

The clients gate the entry on the local runner count instead:

| Client | Where the managed runner is shown | Gate | What an existing account sees |
| --- | --- | --- | --- |
| Web | Default landing (`ManagedRunnerLanding`), and above the composer of the managed workspace (`ManagedRunnerNotice`) | `App.tsx` `DefaultLanding`: `useManagedRunner(listed && !first && runnerList.length === 0)` | Nothing. Settings → Machines lists its machines and "Register a machine" |
| iPhone / Mac | Above Machines & models' list (`ManagedRunnerBanner`, `ManagedRunnerAboveList`) | `ManagedRunnerLogic.onboarding(display, runnerCount:)` returns the display only for `runnerCount == 0` | Nothing |
| Android | The new account's welcome card (`WelcomeCard.kt`) | A new account's first draft | Nothing; Machines & models has no managed section |

## Proposal

One rule on every client: **the entry follows the server's `display.ensure`, and it lives in the machine list.**

1. **No mapping, and the server offers one** (`kind: setup`, `ensure: true`): the machine list gets a first entry,
   "Managed runner · Set up", however many machines the account already has.
   - Web: a row at the top of Settings' Machines group, opening `/settings/machines/managed`, a page holding the
     existing `ManagedRunnerNotice` and one sentence: "Your own machines are not changed. Setting it up adds one
     machine and its workspace to this list." Register a machine (`/settings/machines/new`) gets a line, "Or let
     Orbit run one for you", linking to that page.
   - iPhone and Mac: the existing banner, with `onboarding` changed to `runnerCount == 0 || display.ensure`.
   - Android (follows iPhone): a new "Managed runner" `FormSection` in Machines & models, after Needs you and before
     Machines, drawn from the existing `ManagedRunner.display()`.
2. **Set up** asks first, on an existing account only (D3): "Set up a managed runner?" / "Orbit will start a runner
   for you on this server and add a workspace for it. Your own machines and workspaces stay as they are." /
   Cancel · Set up. Then `POST /managed-runner/ensure` with one idempotency key, exactly as `useManagedRunnerActions`
   does today; a refusal is the server's own sentence in a toast. The new-account landing stays one click.
3. **The answer** (REQUESTED) already carries `runnerId` and `workspaceId`. Web replaces the route with
   `/settings/machines/<runnerId>`; the native clients push that machine's page. From here on the entry row is gone:
   the managed runner is one machine in the list (D4).
4. **With a mapping**, the managed runner's row shows the shared display's state as a short label rather than the
   heartbeat's Online/Offline, and its machine page carries `ManagedRunnerNotice` / `ManagedRunnerBanner` at the top
   (Retry and "Open Machines & models" live there, as today in the workspace console).
5. **Feature off** (capability missing, `enabled: false`, a contract this client does not know, a malformed body, or
   a status with `MANAGED_RUNNER_DISABLED`): no entry, no `GET /managed-runner` read, every page as it is today.

### Copy

All words come from `MANAGED_RUNNER_COPY` (`src/shared/src/managedRunnerDisplay.ts`) except:

- the confirmation's title, body and buttons above;
- the Web page's one sentence and Register a machine's "Or let Orbit run one for you";
- the row's subtitle on iPhone/Android, "Orbit runs a runner for you on this server.";
- a short label per kind for list rows (D4), proposed as `MANAGED_RUNNER_COPY.short` and added to
  `managed-runner-states.fixture.json` so the web, OrbitKit and Android fixture tests hold all three to it:
  `setup` "Set up", `preparing` "Preparing", `waking` "Waking", `modelUnavailable` "Needs a model",
  `waitingCapacity` "Waiting for capacity", `available` "Ready", `unresponsive` "Not responding",
  `stopping` "Going to sleep", `sleeping` "Asleep", `waitingOperator` "Waiting for an operator", `failed` "Failed",
  `removing` "Removing", `removed` "Removed". `notOffered` has no row (D2), so no label.

## Every state

States as named in `src/shared/src/managed-runner-states.fixture.json`; titles and details from
`managedRunnerDisplay()`.

| State | `display.kind` | List row | Its page / banner | What the owner can do |
| --- | --- | --- | --- | --- |
| Feature off: capability 404, no member, `enabled: false`, unknown contract, malformed; or `MANAGED_RUNNER_DISABLED` with a mapping left | none | No row | No managed read; a leftover managed runner shows by heartbeat as today | As today |
| none: no mapping, offered | `setup` | + Managed runner · Set up | "Set up a managed runner" + detail + Set up | Set up → confirm → ensure |
| no mapping, account not eligible | `notOffered` | No row (D2) | — | Nothing; own runners unaffected |
| no mapping, environment unavailable | `notOffered` | No row | — | Nothing |
| disabled account, no mapping (`ACCOUNT_DISABLED`) | `notOffered` | No row | — | Nothing; the server refuses its ensure 403 anyway |
| provisioning: requested / provisioning / starting | `preparing` | spinner · Preparing | "Preparing your managed runner" | Wait (read every 5 s) |
| waiting for capacity | `waitingCapacity` | spinner · Waiting for capacity | Title + the server's reason | Wait |
| model unavailable | `modelUnavailable` | orange · Needs a model | Title + "Open Machines & models" | Sign a runtime in, or add a key |
| READY, available | `available` | green · Ready | No banner | Use it |
| READY, unresponsive | `unresponsive` | spinner · Not responding | "Managed runner not responding" | Messages wait for it |
| stopping (DRAINING) | `stopping` | spinner · Going to sleep | "Managed runner going to sleep" | A message wakes it |
| sleeping | `sleeping` | grey · Asleep | "Managed runner asleep" | A message wakes it |
| waking | `waking` | spinner · Waking | "Waking your managed runner" | Messages wait for it |
| asleep, its account disabled (`canWake: false`) | `sleeping` | grey · Asleep | Title + "This Orbit account is disabled, …" | Nothing (`acceptsWork: false`) |
| failed, retryable | `failed` | orange · Failed | Title + reason + Retry | Retry with the read revision |
| failed, needs an operator / unknown reason | `failed` | orange · Failed | Title + reason, no button | Wait for an operator |
| waiting for an operator (FENCING) | `waitingOperator` | orange · Waiting for an operator | Title + detail | Wait for an operator |
| removing / removed | `removing` / `removed` | spinner · Removing / grey · Removed | Title + detail | Nothing: the server offers no ensure after removal |

Dot and spinner follow what `ManagedRunnerNotice` already does: a spinner while `display.moving`, orange for the
kinds in its `ATTENTION` set.

## Decisions

| | A | B | Recommendation |
| --- | --- | --- | --- |
| **D1** Where the entry lives | In the machine list (Web Settings → Machines; Machines & models on iPhone, Mac, Android), gated on `display.ensure`; Register a machine links to it | Only on Register a machine ("Or let Orbit run one for you"); list unchanged | **A.** Once set up it is a machine in that list, so the entry and its state are in one place; B is found only by someone already thinking of registering a machine. The runner picker and the new-workspace flow are not proposed: setting up brings its own default workspace, so offering it while creating another workspace is ambiguous, and the picker is seen only while creating one. |
| **D2** When the server does not give one (not eligible, environment unavailable, account disabled) | Existing accounts see nothing managed | A grey "No managed runner" row with the reason | **A.** There is nothing to do, and the account already has its own machines. An account with no runner keeps today's landing and banner, reason included. |
| **D3** Pressing Set up on an existing account | Confirm first, saying it adds a runner and a workspace | Set up at once, as the new-account landing does | **A.** A workspace appears in an established sidebar, and no client can remove a managed runner (`actions.canDelete` is always false). The new-account landing keeps one click. |
| **D4** The managed runner in the list once mapped | One ordinary machine row, its state the shared short label; the banner only on its machine page | Machine row by heartbeat as today (Offline when asleep), plus a permanent "Managed runner" row | **A.** One runner appears once, and it fixes the "asleep shown as Offline" gap recorded in `docs/mocks/managed-runner-status/README.md`. |
| **D5** Android | Follow iPhone: a Managed runner section in Machines & models | Only the new-session welcome card | **A**, the default rule. |

## Not in this design

- A UI to delete a managed runner (the server offers no `canDelete`).
- Setting one up with a PAT or the CLI: `ensure` stays session-only.
- Any server change: `canEnsure` already answers the question this entry asks.

## Implementation outline (after the decisions)

1. `@orbit/shared`: `MANAGED_RUNNER_COPY.short` and its fixture entries; Web, OrbitKit and Android fixture tests read it.
2. Web: `SettingsLayout` Machines group reads `useManagedRunner()`; the `/settings/machines/managed` page; the
   confirmation in front of `ensure` when the account has a runner or a workspace; the managed runner's row label and
   the notice on its machine page; the line on Register a machine.
3. OrbitKit: `ManagedRunnerLogic.onboarding` → `runnerCount == 0 || display.ensure`; confirmation; row label; banner on
   the managed runner's machine page.
4. Android: the Managed runner section, confirmation, row label and banner.
5. Feature-off parity: each client's test that with the capability off it never reads `GET /managed-runner` and the
   Machines list is unchanged.
