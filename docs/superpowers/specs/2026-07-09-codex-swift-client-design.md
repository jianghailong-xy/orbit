# Codex support in the Swift clients

**Date:** 2026-07-09
**Status:** Approved, pending implementation

## Problem

Codex is already a first-class provider everywhere except the macOS/iOS clients:

- `runner-go` has `codex.go`, `codex_appserver.go`, `codex_artifacts.go` and their tests.
- `apiserver` has the `AgentProvider` enum, DTO validation, migration `0051_codex_effort_xhigh`,
  and provider branching in queue / reaper / runtime-init.
- `web` has a provider picker (`RunnerDetailPage.tsx:361`), per-provider model and effort lists
  (`AgentView.tsx:2261,3273`), and Codex quota display.

The Swift clients are half-ported. They already read `provider` off the DTOs, render Codex quota
(`Runners.swift`), and know that gpt-5.x has a 400K context window. But `AgentDefaults` has no
provider concept: `models` lists only the four Claude models, and the `Effort` enum always offers
`max` while lacking Codex's `minimal`.

### The bug

`ConsoleModel.swift:152` clamps the seeded model to the Claude list:

```swift
let m = agent.model ?? AgentDefaults.defaultModelID
self.modelID = AgentDefaults.models.contains { $0.id == m } ? m : AgentDefaults.defaultModelID
```

For a Codex agent (`model == "gpt-5.5"`) this silently yields `claude-opus-4-8`, which
`createSession` (`ConsoleModel.swift:588`) then sends as `model:`. The server stores `dto.model`
verbatim (`sessions.service.ts:191`, no provider validation) and `codex.go:248` passes it straight
through as `codex -m claude-opus-4-8`. Nothing downstream rescues it.

The trigger is narrow: `loadContext` (`ConsoleModel.swift:413`) does *not* clamp, so an existing
session restores its true model. Only **creating a new session from a Codex agent** goes through
the `init` path and corrupts the model.

### What is NOT a bug

Sending `effort: "max"` from Swift is safe. `apiserver` normalizes `max` → `xhigh` at all three
write sites (`sessions.service.ts:193,1307,1385`) and `runner-go`'s `normalizeCodexReasoningEffort`
(`codex.go:356`) does it again, downgrading unrecognized values to the model default. No Swift-side
normalization will be added — that would be defending against an impossible scenario.

The only residual effort problem is cosmetic and disappears once the menus are provider-scoped:
picking `Max` on a Codex session currently persists as `xhigh`, so the pill reads `xHigh` after a
reload.

## Scope

Fixing the seed alone is not enough. The composer's model menu would still list only Claude models,
so one tap would switch a Codex session to `codex -m claude-opus-4-8`. That moves the bug from
"always on session create" to "on menu tap" rather than removing it. Provider-scoped menus are
therefore part of the fix, not an enhancement.

**In scope**

1. Provider-aware model and effort data in `OrbitKit/AgentDefaults`.
2. The `ConsoleModel` seed fix.
3. Provider-scoped model and effort menus in `ComposerView`.
4. A "Runtime" (provider) picker in `AgentsView`'s edit form, so an existing agent can be switched
   to Codex.

Note on (4): the Swift app has **no create-agent UI**. `AgentsModel` exposes only `save` (PATCH) and
`delete`; `APIClient.createAgent` has no call site outside a codable test. Web's
`RunnerDetailPage.tsx:290` uses one form for both (`editing ? PATCH : POST`) and sends `provider` on
each; Swift ported only the edit half. Adding the picker therefore enables *switching* an agent's
runtime, not creating one. Building a create form is a separate, larger piece of work.

**Out of scope**

- `SettingsAdminView`'s account-default-model picker stays Claude-only. Web's `SettingsPage.tsx:93`
  feeds it `CLAUDE_MODEL_OPTIONS`; broadening it in Swift would introduce behavior web does not have.
- Swift-side `max` → `xhigh` normalization (see "What is NOT a bug").
- `contextWindow(for:)` already covers gpt-5.x. Unchanged.

## Architecture

Mirror web's `src/web/src/lib/agentDefaults.ts` into `OrbitKit/App/AgentDefaults.swift` as the
single source of provider-aware truth. Everything there is a pure function or constant, unit-tested
in `OrbitKitTests`. The two view files become thin consumers.

This boundary already exists in the codebase — `AgentListLogic` and `ComposerLogic` follow the same
pattern — and it is forced by the build: `OrbitApp` has no test target (`OrbitApp/Package.swift`
declares none), so logic placed there cannot be tested.

## Components

### `OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift`

Add `minimal` to the `Effort` enum. Case order mirrors the union of web's two lists:

```swift
case `default` = ""
case minimal, low, medium, high, xhigh, max
```

`label` needs no change — its `rawValue.capitalized` default already yields `"Minimal"`.

Adding the case makes `Effort.allCases` wrong for both providers (Claude rejects `minimal`, Codex
rejects `max`), so add `AgentDefaults.efforts(for provider: String) -> [Effort]` returning the legal
list, and route both menus through it:

- `claude`: `[.default, .low, .medium, .high, .xhigh, .max]`
- `codex`: `[.default, .minimal, .low, .medium, .high, .xhigh]`

Symmetrically for models. Rename the existing `models` to `claudeModels` and add `codexModels`,
`models(for provider:)`, `defaultModel(for provider:)`, and `providers`. The rename is deliberate:
leaving a public `models` that means "Claude models" next to a new `models(for:)` is a trap for the
next reader, and it aligns the names with web's `CLAUDE_MODEL_OPTIONS` / `CODEX_MODEL_OPTIONS` /
`MODEL_OPTIONS_BY_PROVIDER`. No test references `AgentDefaults.models`, so the blast radius is the
four view files.

```swift
public static let codexModels: [ModelOption] = [
    ModelOption(id: "gpt-5.5", name: "GPT-5.5"),
    ModelOption(id: "gpt-5.4", name: "GPT-5.4"),
    ModelOption(id: "gpt-5.4-mini", name: "GPT-5.4 Mini"),
    ModelOption(id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark"),
]

public static func models(for provider: String) -> [ModelOption]
public static func defaultModel(for provider: String) -> String   // codex → "gpt-5.5", else defaultModelID
public static func efforts(for provider: String) -> [Effort]
public static let providers: [ProviderOption]                     // Claude, Codex
```

`ProviderOption` is a small `Identifiable` struct (`id`, `name`) alongside `ModelOption`; a tuple
array would not satisfy the `ForEach` in `AgentsView`'s picker.

`defaultModel(for:)` mirrors web's `DEFAULT_MODEL_BY_PROVIDER`, including its fallback: an unknown
provider yields the Claude default.

`friendlyName(_:)` currently searches `models` only, so `AgentsView:34` renders a Codex agent's model
as the bare id `gpt-5.5`. Widen it to search both lists. Its raw-string fallback for unknown ids is
preserved (`Phase2LogicTests:312` asserts it).

### `OrbitApp/ConsoleModel.swift`

Line 152 — delete the clamp; the agent's configured model is authoritative:

```swift
self.modelID = agent.model ?? AgentDefaults.defaultModel(for: provider)
```

`provider` is assigned on line 150, before this. No wrapper helper is introduced: a single-use
`seedModel(agentModel:provider:)` would be less clear than the inline `??`, and `defaultModel(for:)`
carries the tested logic.

Line 46 — widen `private var provider` to `private(set) var provider` so `ComposerView` can scope its
menus. The class is `@Observable`, so the views update correctly.

### `OrbitApp/Views/ComposerView.swift`

- `modelMenuItems` (line 50-52): source from `AgentDefaults.models(for: console.provider)`, keeping
  the existing iOS reversal.
- Menu label (line 217): use `AgentDefaults.friendlyName(console.modelID)`.
- Effort menu (line 222): `AgentDefaults.efforts(for: console.provider)` instead of `Effort.allCases`.

### `OrbitApp/Views/AgentsView.swift` (`AgentFormContent`, the edit form)

- Add a "Runtime" `Picker` bound to a new `provider` state, matching web's wording.
- On provider change: reset `model` to `AgentDefaults.defaultModel(for: provider)`, and if the current
  `effort` is not in `efforts(for: provider)`, fall back to `.default`. Otherwise the form can persist a
  value the new provider rejects.
- Model picker (line 430-433) and effort picker (line 445): scope both by provider. Keep the existing
  escape hatch that injects an out-of-list current value so the `Picker` does not render blank.
- Include `provider` in `prefill()` (line 508) and `isDirty` (line 520), and send it in the PATCH.

### `OrbitKit/Sources/OrbitKit/Models/Agents.swift`

`CreateAgentRequest` (line 10) and `UpdateAgentRequest` (line 60) carry no `provider` field, though
`apiserver`'s `CreateAgentDto` / `UpdateAgentDto` accept one (`agents/dto.ts:22,50`). Add
`provider: String?` to both.

Only `UpdateAgentRequest.provider` gets a call site (the app cannot create agents). Adding it to
`CreateAgentRequest` too is not speculative: the file's stated job is to mirror `agents/dto.ts`, and it
already carries fields the app never sends (`targetLabels`, `autoInitGit`). Matching that convention.

## Data flow

Running a Codex session from the app:

1. `AgentFormContent` PATCHes an existing agent to `provider: "codex"`, `model: "gpt-5.5"` — or the
   agent was already created that way on web.
2. Opening it builds a draft `ConsoleModel`; `init` reads `agent.provider` → `"codex"` and seeds
   `modelID = "gpt-5.5"` (no clamp).
3. `ComposerView` scopes its menus to `models(for: "codex")` and `efforts(for: "codex")`, so no Claude
   model or `max` is reachable.
4. `createSession` sends `model: "gpt-5.5"`; `sessions.service.ts` stores it; `codex.go:248` runs
   `codex -m gpt-5.5`.

## Error handling

There is no new failure mode. An agent configured with a model outside its provider's list (possible
via web, or a stale id after a model is retired) flows through unchanged: `friendlyName` falls back to
the raw id, `AgentsView`'s picker injects it as a one-off option, and the server decides whether to
reject it. That is the current behavior for Claude and it stays the behavior for both providers.

## Testing

New `OrbitKitTests/AgentDefaultsTests.swift`:

- `defaultModel(for:)` for `"codex"`, `"claude"`, and an unknown provider.
- `models(for: "codex")` contains `gpt-5.5` and no Claude model; the converse for `"claude"`.
- `efforts(for: "codex")` contains `.minimal` and excludes `.max`; the converse for `"claude"`.
- `friendlyName("gpt-5.5") == "GPT-5.5"`, and the raw-id fallback still holds.

Modified `OrbitKitTests/Phase2LogicTests.swift:183-184`: `testEffortLabelsAndWire` hardcodes the full
`allCases` list and its labels. Update both for the new `minimal` case.

Modified `OrbitKitTests/AgentWriteCodableTests.swift`: assert `provider` encodes into the create and
update request bodies.

### Verification

`swift test` in `src/macos/OrbitKit` covers everything above.

It does **not** cover the fixed line. `ConsoleModel` lives in `OrbitApp`, which has no test target, so
no unit test can observe the seed. Confirming the bug is actually fixed requires running the app,
creating a session from a Codex agent, and checking the model on the wire. That verification runs
before the work is called done; a green `swift test` is not sufficient evidence.

## Success criteria

1. `swift test` passes in `src/macos/OrbitKit` (baseline before this work: 263 tests, 0 failures).
2. Creating a session from a Codex agent in the macOS app sends `model: "gpt-5.5"`, not
   `claude-opus-4-8`. Observed on the wire or in the runner log, not inferred.
3. The composer's model menu on a Codex session lists only Codex models; its effort menu offers
   `Minimal` and does not offer `Max`.
4. Switching an agent's Runtime to Codex in `AgentFormContent` PATCHes `provider: "codex"` and resets
   the model picker to `gpt-5.5`.
