# Codex Support in the Swift Clients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the macOS/iOS clients from sending a Claude model id to a Codex runner, and let a Codex session be configured from the app.

**Architecture:** Mirror web's `src/web/src/lib/agentDefaults.ts` into `OrbitKit/App/AgentDefaults.swift` as the single source of provider-aware truth — pure constants and functions, unit-tested. The two SwiftUI views and `ConsoleModel` become thin consumers. `OrbitApp` has no test target, so all testable logic must live in `OrbitKit`.

**Tech Stack:** Swift 5.9+, SwiftUI, XCTest, Swift Package Manager.

**Spec:** `docs/superpowers/specs/2026-07-09-codex-swift-client-design.md`

## Global Constraints

- Test baseline before any change: `swift test` in `src/macos/OrbitKit` → **263 tests, 0 failures**. Any task that ends with fewer than 263 passing tests has broken something.
- All test commands run from `src/macos/OrbitKit`. There is no test target in `src/macos/OrbitApp` — never add one as part of this work.
- Provider string values are exactly `"claude"` and `"codex"` (matching `AgentProvider` in `src/shared/src/enums.ts`). An unknown provider string always falls back to Claude behavior.
- Codex model ids and labels, verbatim from `src/web/src/lib/agentDefaults.ts`: `gpt-5.5` → `GPT-5.5`, `gpt-5.4` → `GPT-5.4`, `gpt-5.4-mini` → `GPT-5.4 Mini`, `gpt-5.3-codex-spark` → `GPT-5.3 Codex Spark`.
- Legal effort per provider, verbatim from web: Claude = `["", low, medium, high, xhigh, max]`; Codex = `["", minimal, low, medium, high, xhigh]`.
- Do **not** add `max` → `xhigh` normalization anywhere in Swift. `apiserver` (`sessions.service.ts:193,1307,1385`) and `runner-go` (`codex.go:356`) both already do it.
- Do **not** modify `SettingsAdminView.swift`. Its account-default-model picker stays Claude-only, matching web's `SettingsPage.tsx:93`.
- Task 6 (real-device verification) is not optional. `swift test` passing is not sufficient evidence that the bug is fixed — the fixed line lives in an untestable target.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift` | Provider-aware model/effort/provider data. All new pure logic lands here. | 1, 2 |
| `src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift` | New. Covers everything added to `AgentDefaults`. | 1, 2 |
| `src/macos/OrbitKit/Tests/OrbitKitTests/Phase2LogicTests.swift` | Existing. Two assertions pin the old `Effort.allCases` and must be updated. | 2 |
| `src/macos/OrbitKit/Sources/OrbitKit/Models/Agents.swift` | Agent write DTOs. Gains `provider`. | 3 |
| `src/macos/OrbitKit/Tests/OrbitKitTests/AgentWriteCodableTests.swift` | Existing. Gains `provider` encode assertions. | 3 |
| `src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift` | The bug. Seeds `modelID` from the agent. | 4 |
| `src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift` | Model + effort menus, scoped by session provider. | 5 |
| `src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift` | Edit form: Runtime picker + provider-scoped model/effort pickers. | 5 |

Tasks 1–3 are pure `OrbitKit` and fully TDD. Task 4 is the one-line bug fix. Task 5 is view wiring (no unit tests possible). Task 6 is the real-app verification that Tasks 4 and 5 actually work.

---

### Task 1: Provider-aware model data in `AgentDefaults`

Renames `AgentDefaults.models` (which means "Claude models") to `claudeModels`, adds `codexModels`, and adds the three lookup functions. The rename prevents a public `models` sitting next to a new `models(for:)` — a trap for the next reader — and aligns names with web's `CLAUDE_MODEL_OPTIONS` / `CODEX_MODEL_OPTIONS` / `MODEL_OPTIONS_BY_PROVIDER`. No test references `AgentDefaults.models`; the four view call sites are updated here so the package keeps compiling.

**Files:**
- Modify: `src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift`
- Modify (rename call sites only): `src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsAdminView.swift:66`, `src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift:430,433`, `src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift:50,52,217`
- Test: `src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift` (create)

**Interfaces:**
- Consumes: `ModelOption` (existing, in `AgentDefaults.swift`).
- Produces:
  - `AgentDefaults.claudeModels: [ModelOption]`
  - `AgentDefaults.codexModels: [ModelOption]`
  - `AgentDefaults.models(for provider: String) -> [ModelOption]`
  - `AgentDefaults.defaultModel(for provider: String) -> String`
  - `AgentDefaults.providers: [ProviderOption]`
  - `struct ProviderOption: Equatable, Sendable, Identifiable { let id: String; let name: String }`
  - `AgentDefaults.friendlyName(_:)` — unchanged signature, now searches both model lists.

- [ ] **Step 1: Write the failing test**

Create `src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift`:

```swift
import XCTest
@testable import OrbitKit

/// Provider-aware model and effort data, mirrored from web's src/web/src/lib/agentDefaults.ts.
/// An unknown provider string always behaves like "claude" — the server treats anything that
/// isn't exactly "codex" as Claude (see apiserver's agentProvider()).
final class AgentDefaultsTests: XCTestCase {

    func testModelsForProvider() {
        let codex = AgentDefaults.models(for: "codex").map(\.id)
        XCTAssertEqual(codex, ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"])
        XCTAssertFalse(codex.contains("claude-opus-4-8"))

        let claude = AgentDefaults.models(for: "claude").map(\.id)
        XCTAssertEqual(claude, ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"])
        XCTAssertFalse(claude.contains("gpt-5.5"))

        // Unknown provider falls back to Claude, never to an empty menu.
        XCTAssertEqual(AgentDefaults.models(for: "gemini").map(\.id), claude)
    }

    func testDefaultModelForProvider() {
        XCTAssertEqual(AgentDefaults.defaultModel(for: "codex"), "gpt-5.5")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "claude"), "claude-opus-4-8")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "gemini"), AgentDefaults.defaultModelID)
    }

    func testFriendlyNameSpansProviders() {
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.3-codex-spark"), "GPT-5.3 Codex Spark")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-4-8"), "Opus 4.8")
        // Unknown ids still fall back to the raw string (an env-overridden endpoint).
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
    }

    func testProviderOptions() {
        XCTAssertEqual(AgentDefaults.providers.map(\.id), ["claude", "codex"])
        XCTAssertEqual(AgentDefaults.providers.map(\.name), ["Claude", "Codex"])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/macos/OrbitKit && swift test --filter AgentDefaultsTests 2>&1 | tail -20`

Expected: compile FAIL — `type 'AgentDefaults' has no member 'models(for:)'`, `no member 'defaultModel(for:)'`, `no member 'providers'`, `cannot find type 'ProviderOption'`.

- [ ] **Step 3: Write minimal implementation**

In `src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift`, add `ProviderOption` next to `ModelOption`:

```swift
public struct ProviderOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}
```

Then replace the `models` / `defaultModelID` / `friendlyName` block inside `public enum AgentDefaults` with:

```swift
    /// Provider runtimes an agent can target. Mirrors web's PROVIDER_OPTIONS.
    public static let providers: [ProviderOption] = [
        ProviderOption(id: "claude", name: "Claude"),
        ProviderOption(id: "codex", name: "Codex"),
    ]

    public static let claudeModels: [ModelOption] = [
        ModelOption(id: "claude-fable-5", name: "Fable 5"),
        ModelOption(id: "claude-opus-4-8", name: "Opus 4.8"),
        ModelOption(id: "claude-sonnet-5", name: "Sonnet 5"),
        ModelOption(id: "claude-haiku-4-5", name: "Haiku 4.5"),
    ]

    public static let codexModels: [ModelOption] = [
        ModelOption(id: "gpt-5.5", name: "GPT-5.5"),
        ModelOption(id: "gpt-5.4", name: "GPT-5.4"),
        ModelOption(id: "gpt-5.4-mini", name: "GPT-5.4 Mini"),
        ModelOption(id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark"),
    ]

    public static let defaultModelID = "claude-opus-4-8"

    /// The models a provider's pickers offer. Anything that isn't exactly "codex" is Claude —
    /// matching apiserver's `agentProvider()`, so a stale provider string can't empty the menu.
    public static func models(for provider: String) -> [ModelOption] {
        provider == "codex" ? codexModels : claudeModels
    }

    /// Seed model for a provider when the agent has none. Mirrors web's DEFAULT_MODEL_BY_PROVIDER.
    public static func defaultModel(for provider: String) -> String {
        provider == "codex" ? "gpt-5.5" : defaultModelID
    }

    /// Display name for a model id, across providers. Unknown ids (an `ANTHROPIC_MODEL` env
    /// override pointing at a custom endpoint) render as the raw id.
    public static func friendlyName(_ id: String) -> String {
        (claudeModels + codexModels).first { $0.id == id }?.name ?? id
    }
```

- [ ] **Step 4: Update the four view call sites so the app target still compiles**

`SettingsAdminView.swift:66` — the account default stays Claude-only (web parity):

```swift
                    ForEach(AgentDefaults.claudeModels) { Text($0.name).tag($0.id) }
```

`AgentsView.swift:430,433` — leave provider-scoping for Task 5; just fix the name:

```swift
                    if !AgentDefaults.claudeModels.contains(where: { $0.id == model }) {
                        Text(model.isEmpty ? "—" : model).tag(model)
                    }
                    ForEach(AgentDefaults.claudeModels) { Text($0.name).tag($0.id) }
```

`ComposerView.swift:50,52` inside `modelMenuItems`:

```swift
        #if os(iOS)
        Array(AgentDefaults.claudeModels.reversed())
        #else
        AgentDefaults.claudeModels
        #endif
```

`ComposerView.swift:217` — `friendlyName` now does exactly what this inline lookup did:

```swift
                    menuLabel(AgentDefaults.friendlyName(console.modelID))
```

`ConsoleModel.swift:152` also references `AgentDefaults.models`. Leave it referencing `claudeModels` for now — Task 4 deletes the line entirely:

```swift
        self.modelID = AgentDefaults.claudeModels.contains { $0.id == m } ? m : AgentDefaults.defaultModelID
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -6`

Expected: `Executed 267 tests, with 0 failures` (263 baseline + 4 new).

- [ ] **Step 6: Verify the app target still builds**

Run: `cd src/macos/OrbitApp && swift build 2>&1 | tail -6`

Expected: `Build complete`. If it reports `has no member 'models'`, a call site was missed — grep with `grep -rn 'AgentDefaults\.models\b' src/macos/`.

- [ ] **Step 7: Commit**

```bash
git add src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift \
        src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift \
        src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsAdminView.swift \
        src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift \
        src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift \
        src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift
git commit -m "feat(macos): add provider-aware model data to AgentDefaults"
```

---

### Task 2: Provider-aware effort data in `AgentDefaults`

Adds Codex's `minimal` effort and the per-provider legal list. Adding the enum case makes `Effort.allCases` wrong for both providers (Claude rejects `minimal`, Codex rejects `max`), so both menus must move to `efforts(for:)` — that move happens in Task 5. This task updates the one existing test that pins `allCases`.

**Files:**
- Modify: `src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift`
- Modify: `src/macos/OrbitKit/Tests/OrbitKitTests/Phase2LogicTests.swift:182-188`
- Test: `src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift`

**Interfaces:**
- Consumes: `AgentDefaults` (Task 1).
- Produces:
  - `Effort.minimal` (rawValue `"minimal"`, label `"Minimal"`)
  - `AgentDefaults.efforts(for provider: String) -> [Effort]`

- [ ] **Step 1: Write the failing test**

Append to `src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift`, inside the class:

```swift
    func testEffortsForProvider() {
        XCTAssertEqual(AgentDefaults.efforts(for: "claude"),
                       [.default, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "codex"),
                       [.default, .minimal, .low, .medium, .high, .xhigh])

        // The whole point: neither provider is offered a value it rejects.
        XCTAssertFalse(AgentDefaults.efforts(for: "claude").contains(.minimal))
        XCTAssertFalse(AgentDefaults.efforts(for: "codex").contains(.max))

        XCTAssertEqual(AgentDefaults.efforts(for: "gemini"), AgentDefaults.efforts(for: "claude"))
    }

    func testMinimalEffortLabelAndWire() {
        XCTAssertEqual(Effort.minimal.rawValue, "minimal")
        XCTAssertEqual(Effort.minimal.label, "Minimal")
        XCTAssertEqual(Effort.minimal.wire, "minimal")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/macos/OrbitKit && swift test --filter AgentDefaultsTests 2>&1 | tail -20`

Expected: compile FAIL — `type 'Effort' has no member 'minimal'` and `type 'AgentDefaults' has no member 'efforts(for:)'`.

- [ ] **Step 3: Write minimal implementation**

In `AgentDefaults.swift`, add the case to `Effort`. Order mirrors the union of web's two lists, so `minimal` sits between `default` and `low`:

```swift
public enum Effort: String, CaseIterable, Sendable, Identifiable {
    case `default` = ""
    case minimal, low, medium, high, xhigh, max
```

`label` needs no change: its `rawValue.capitalized` default already yields `"Minimal"`.

Then add to `enum AgentDefaults`:

```swift
    /// Reasoning-effort levels a provider accepts. Claude tops out at `max`; Codex's Responses API
    /// tops out at `xhigh` and adds `minimal`. Mirrors web's CLAUDE_/CODEX_EFFORT_OPTIONS. The
    /// server and runner both coerce an illegal value, but a picker should never offer one.
    public static func efforts(for provider: String) -> [Effort] {
        provider == "codex"
            ? [.default, .minimal, .low, .medium, .high, .xhigh]
            : [.default, .low, .medium, .high, .xhigh, .max]
    }
```

- [ ] **Step 4: Run tests — the new ones pass, an old one now fails**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -12`

Expected: `AgentDefaultsTests` passes, and `Phase2LogicTests.testEffortLabelsAndWire` FAILS — it hardcodes `allCases` without `minimal`. This failure is expected and is fixed in the next step.

- [ ] **Step 5: Update the stale assertion**

In `src/macos/OrbitKit/Tests/OrbitKitTests/Phase2LogicTests.swift`, replace `testEffortLabelsAndWire`:

```swift
    func testEffortLabelsAndWire() {
        XCTAssertEqual(Effort.allCases, [.default, .minimal, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(Effort.allCases.map(\.label),
                       ["Default", "Minimal", "Low", "Medium", "High", "xHigh", "Max"])
        XCTAssertNil(Effort.default.wire)              // Default omits --effort
        XCTAssertEqual(Effort.max.wire, "max")
        XCTAssertEqual(Effort.xhigh.rawValue, "xhigh") // wire/raw match the CLI value
    }
```

Note `allCases` is now the *union* across providers and no longer describes any single provider's menu. Pickers must use `AgentDefaults.efforts(for:)`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -6`

Expected: `Executed 269 tests, with 0 failures` (267 + 2 new).

- [ ] **Step 7: Commit**

```bash
git add src/macos/OrbitKit/Sources/OrbitKit/App/AgentDefaults.swift \
        src/macos/OrbitKit/Tests/OrbitKitTests/AgentDefaultsTests.swift \
        src/macos/OrbitKit/Tests/OrbitKitTests/Phase2LogicTests.swift
git commit -m "feat(macos): add Codex minimal effort and per-provider effort lists"
```

---

### Task 3: `provider` on the agent write DTOs

`apiserver`'s `CreateAgentDto` / `UpdateAgentDto` accept `provider` (`agents/dto.ts:22,50`); the Swift mirrors do not. Task 5 needs `UpdateAgentRequest.provider` to PATCH a runtime change.

**Files:**
- Modify: `src/macos/OrbitKit/Sources/OrbitKit/Models/Agents.swift:10-56` (create) and `:60-96` (update)
- Test: `src/macos/OrbitKit/Tests/OrbitKitTests/AgentWriteCodableTests.swift`

**Interfaces:**
- Produces: `CreateAgentRequest.provider: String?` and `UpdateAgentRequest.provider: String?`, both defaulting to `nil` in their initializers. `nil` omits the key (synthesized `encodeIfPresent`), so an unrelated PATCH never rewrites the runtime.

- [ ] **Step 1: Write the failing test**

In `src/macos/OrbitKit/Tests/OrbitKitTests/AgentWriteCodableTests.swift`, add two methods inside the class:

```swift
    func testUpdateEncodesProvider() throws {
        let obj = try jsonObject(UpdateAgentRequest(provider: "codex", model: "gpt-5.5"))
        XCTAssertEqual(obj["provider"] as? String, "codex")
        XCTAssertEqual(obj["model"] as? String, "gpt-5.5")
    }

    /// A PATCH that doesn't touch the runtime must not send `provider` — otherwise every
    /// unrelated edit would rewrite it.
    func testUpdateOmitsProviderWhenNil() throws {
        let obj = try jsonObject(UpdateAgentRequest(name: "new"))
        XCTAssertFalse(obj.keys.contains("provider"))
    }
```

And extend the existing `testCreateEncodes` to pin the create mirror:

```swift
    func testCreateEncodes() throws {
        let obj = try jsonObject(CreateAgentRequest(name: "dev", provider: "codex", model: "gpt-5.5",
                                                    allowedTools: ["Bash"], env: ["K": "V"]))
        XCTAssertEqual(obj["name"] as? String, "dev")
        XCTAssertEqual(obj["provider"] as? String, "codex")
        XCTAssertEqual(obj["model"] as? String, "gpt-5.5")
        XCTAssertEqual(obj["allowedTools"] as? [String], ["Bash"])
        XCTAssertEqual((obj["env"] as? [String: String])?["K"], "V")
        XCTAssertFalse(obj.keys.contains("description"))
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/macos/OrbitKit && swift test --filter AgentWriteCodableTests 2>&1 | tail -20`

Expected: compile FAIL — `extra argument 'provider' in call` for both `UpdateAgentRequest` and `CreateAgentRequest`.

- [ ] **Step 3: Write minimal implementation**

In `src/macos/OrbitKit/Sources/OrbitKit/Models/Agents.swift`, add the stored property to `CreateAgentRequest` directly after `description`:

```swift
    public let description: String?
    public let provider: String?
    public let model: String?
```

Add the parameter to its initializer, in the same position, and assign it:

```swift
    public init(name: String, description: String? = nil, provider: String? = nil,
                model: String? = nil,
                appendSystemPrompt: String? = nil, systemPrompt: String? = nil,
```

```swift
        self.description = description
        self.provider = provider
        self.model = model
```

Repeat for `UpdateAgentRequest` — stored property after `description`:

```swift
    public var description: String?
    public var provider: String?
    public var model: String?
```

initializer parameter in the same position:

```swift
    public init(name: String? = nil, description: String? = nil, provider: String? = nil,
                model: String? = nil,
                appendSystemPrompt: String? = nil, systemPrompt: String? = nil,
```

and the assignment:

```swift
        self.description = description
        self.provider = provider
        self.model = model
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -6`

Expected: `Executed 271 tests, with 0 failures` (269 + 2 new; `testCreateEncodes` was extended, not added).

- [ ] **Step 5: Commit**

```bash
git add src/macos/OrbitKit/Sources/OrbitKit/Models/Agents.swift \
        src/macos/OrbitKit/Tests/OrbitKitTests/AgentWriteCodableTests.swift
git commit -m "feat(macos): carry provider on the agent write DTOs"
```

---

### Task 4: Fix the model-clamp bug in `ConsoleModel`

This is the defect. `init` clamps the seeded model to the Claude list, so a draft session on a Codex agent seeds `claude-opus-4-8` and `createSession` (line 588) sends it. `codex.go:248` then runs `codex -m claude-opus-4-8`.

No unit test can cover this: `ConsoleModel` is in `OrbitApp`, which has no test target. `AgentDefaults.defaultModel(for:)` — the logic the fixed line depends on — is tested in Task 1. Behavioral proof comes in Task 6.

**Files:**
- Modify: `src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift:46` and `:151-152`

**Interfaces:**
- Consumes: `AgentDefaults.defaultModel(for:)` (Task 1).
- Produces: `ConsoleModel.provider` readable from views (was `private`). Task 5 depends on this.

- [ ] **Step 1: Widen `provider` so views can scope their menus**

`ConsoleModel.swift:46` currently reads:

```swift
    private var provider = "claude"
```

Change to:

```swift
    private(set) var provider = "claude"
```

The class is `@MainActor @Observable`, so `ComposerView` observes this correctly. `private(set)` keeps every write inside `ConsoleModel` (lines 150 and 412), so the view can read but not mutate the runtime.

- [ ] **Step 2: Delete the clamp**

`ConsoleModel.swift:151-152` currently reads:

```swift
        let m = agent.model ?? AgentDefaults.defaultModelID
        self.modelID = AgentDefaults.claudeModels.contains { $0.id == m } ? m : AgentDefaults.defaultModelID
```

Replace both lines with:

```swift
        // The agent's configured model is authoritative — it may belong to any provider. Clamping
        // it to the Claude list used to seed a Codex draft with claude-opus-4-8, which the runner
        // then ran as `codex -m claude-opus-4-8`.
        self.modelID = agent.model ?? AgentDefaults.defaultModel(for: provider)
```

`self.provider` is assigned on line 150, immediately above, so it is already correct here.

- [ ] **Step 3: Verify the app target builds**

Run: `cd src/macos/OrbitApp && swift build 2>&1 | tail -6`

Expected: `Build complete`.

- [ ] **Step 4: Verify OrbitKit still passes**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -6`

Expected: `Executed 271 tests, with 0 failures`. Unchanged — this task touches no `OrbitKit` code. If the count moved, something else changed.

- [ ] **Step 5: Commit**

```bash
git add src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift
git commit -m "fix(macos): stop seeding a Codex session with a Claude model

A draft console clamped the agent's model to the Claude list, so a new session
on a Codex agent sent model=claude-opus-4-8. The server stores dto.model
verbatim and the runner ran \`codex -m claude-opus-4-8\`. Trust the agent's
configured model; fall back per provider when it has none."
```

---

### Task 5: Provider-scoped pickers in the two views

Without this, Task 4 only moves the bug: the composer's model menu still lists Claude models on a Codex session, so one tap re-corrupts it.

**Files:**
- Modify: `src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift:48-54` and `:207-235`
- Modify: `src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift:411-447`, `:506-527`, and `save()` at `:539-551`

**Interfaces:**
- Consumes: `AgentDefaults.models(for:)`, `.defaultModel(for:)`, `.efforts(for:)`, `.providers`, `.friendlyName(_:)` (Tasks 1–2); `ConsoleModel.provider` (Task 4); `UpdateAgentRequest.provider` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Scope the composer's model menu**

`ComposerView.swift`, `modelMenuItems` (lines 48-54) — after Task 1 it reads `AgentDefaults.claudeModels`. Replace the computed property body:

```swift
    private var modelMenuItems: [ModelOption] {
        let models = AgentDefaults.models(for: console.provider)
        #if os(iOS)
        return Array(models.reversed())
        #else
        return models
        #endif
    }
```

The `return`s are now required — the body is no longer a single expression.

- [ ] **Step 2: Scope the composer's effort menu**

`ComposerView.swift:222` currently reads `ForEach(Effort.allCases) { e in`. Replace with:

```swift
                    ForEach(AgentDefaults.efforts(for: console.provider)) { e in
```

Nothing else in that `Menu` changes. `AgentDefaults.friendlyName` already replaced the model label in Task 1.

- [ ] **Step 3: Build and check the composer by eye**

Run: `cd src/macos/OrbitApp && swift build 2>&1 | tail -6`

Expected: `Build complete`. Behavior is verified in Task 6 — do not claim it works yet.

- [ ] **Step 4: Add provider state and the Runtime picker to the edit form**

`AgentsView.swift`, in `AgentFormContent`, add the state next to `model` (line ~414):

```swift
    @State private var name = ""
    @State private var provider = "claude"
    @State private var model = ""
```

Insert the Runtime picker directly above the Model picker (line ~427), matching web's `RunnerDetailPage` wording, and make the model/effort pickers provider-scoped:

```swift
                TextField("Name", text: $name, prompt: Text("e.g. tea-cli builder"))

                Picker("Runtime", selection: $provider) {
                    ForEach(AgentDefaults.providers) { Text($0.name).tag($0.id) }
                }
                .onChange(of: provider) { _, new in
                    // A model or effort from the old runtime is meaningless (and rejected) under
                    // the new one — reset to that provider's default rather than PATCH a bad value.
                    model = AgentDefaults.defaultModel(for: new)
                    if !AgentDefaults.efforts(for: new).contains(effort) { effort = .default }
                }

                Picker("Model", selection: $model) {
                    // Surface a non-standard saved model (e.g. an env-overridden endpoint) so the
                    // picker still shows the current value rather than going blank.
                    if !AgentDefaults.models(for: provider).contains(where: { $0.id == model }) {
                        Text(model.isEmpty ? "—" : model).tag(model)
                    }
                    ForEach(AgentDefaults.models(for: provider)) { Text($0.name).tag($0.id) }
                }
```

And the effort picker (line ~445):

```swift
                Picker("Effort", selection: $effort) {
                    ForEach(AgentDefaults.efforts(for: provider)) { Text($0.label).tag($0) }
                }
```

- [ ] **Step 5: Seed, dirty-check, and send `provider`**

`AgentsView.swift`, `prefill()` (line ~506) — seed `provider` before `model`, because the model fallback depends on it:

```swift
    private func prefill() {
        name = agent.name
        provider = agent.provider ?? "claude"
        model = agent.model ?? AgentDefaults.defaultModel(for: provider)
        mode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
        effort = Effort(rawValue: agent.effort ?? "") ?? .default
        instructions = agent.appendSystemPrompt ?? ""
        workDir = agent.workDir ?? ""
        enabled = agent.enabled ?? true
    }
```

`isDirty` (line ~520) — mirror `prefill()` field for field:

```swift
    private var isDirty: Bool {
        name != agent.name
        || provider != (agent.provider ?? "claude")
        || model != (agent.model ?? AgentDefaults.defaultModel(for: agent.provider ?? "claude"))
        || mode != (PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk)
        || effort != (Effort(rawValue: agent.effort ?? "") ?? .default)
        || instructions != (agent.appendSystemPrompt ?? "")
        || workDir != (agent.workDir ?? "")
        || enabled != (agent.enabled ?? true)
    }
```

Finally, `save()` (line ~539) builds the PATCH. Add `provider:` after `name:` — that is where it sits in the DTO's parameter order from Task 3 (`name, description, provider, model, …`), and Swift requires arguments in declaration order:

```swift
    private func save() {
        let req = UpdateAgentRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            provider: provider,
            model: model,
            appendSystemPrompt: instructions.isEmpty ? nil : instructions,
            permissionMode: mode.rawValue,
            // Always send the raw value ("" for Default) so picking Default actually clears a
            // previously-set effort — omitting (nil) would leave the old value unchanged.
            effort: effort.rawValue,
            workDir: workDir.isEmpty ? nil : workDir,
            enabled: enabled
        )
        Task { await agents.save(agent.id, req) }
    }
```

`save()` only runs when `isDirty`, so an untouched form still sends nothing.

- [ ] **Step 6: Build**

Run: `cd src/macos/OrbitApp && swift build 2>&1 | tail -6`

Expected: `Build complete`.

- [ ] **Step 7: Run OrbitKit tests — must be unchanged**

Run: `cd src/macos/OrbitKit && swift test 2>&1 | tail -6`

Expected: `Executed 271 tests, with 0 failures`.

- [ ] **Step 8: Commit**

```bash
git add src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift \
        src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift
git commit -m "feat(macos): scope model and effort pickers by provider

The composer's model menu listed Claude models on a Codex session, so one tap
would switch it to a model the Codex runner can't run. Both menus now follow
the session's provider, and the agent form grows a Runtime picker."
```

---

### Task 6: Verify on the real app

`swift test` proves nothing about Tasks 4 and 5 — the changed code is in a target with no tests. This task is where the bug is actually shown to be fixed. Do not mark the work done without it.

**Files:** none. This is observation only.

- [ ] **Step 1: Load the verify skill**

Invoke the `verify` skill. It knows how this repo launches the macOS app.

- [ ] **Step 2: Prepare a Codex agent**

Either PATCH an existing agent to Codex through the app's own form (which also exercises Task 5), or create one on web with `provider: codex`, `model: gpt-5.5`. A runner with the `codex` CLI installed must be online — check with `orbit doctor` on the runner, or the runner detail page.

- [ ] **Step 3: Observe the wire, not the UI**

Create a new session from that agent in the macOS app and send one message. Confirm the request body carries `"model":"gpt-5.5"`.

Two observation points, both direct:

1. `SELECT provider, model FROM session ORDER BY created_at DESC LIMIT 1;` on the control plane's postgres. The apiserver stores `dto.model` verbatim (`sessions.service.ts:191`), so this row **is** the wire value.
2. Codex's own rollout log on the runner host: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` contains `"model":"gpt-5.5"`.

Do **not** look for `codex -m gpt-5.5` in the runner log. The runner drives Codex over `codex app-server --stdio` and passes the model as a JSON param (`codex_appserver.go:597`) — it never reaches argv, and the runner logs no argv anyway. (`codex.go:248`'s `-m` flag belongs to the `codex exec` path, which this transport does not use.)

Reading the composer's pill is also *not* sufficient: the pill rendered the right thing before this fix too, while the wire carried the wrong model.

- [ ] **Step 4: Check each success criterion from the spec**

1. `cd src/macos/OrbitKit && swift test` → `Executed 271 tests, with 0 failures`.
2. The session above stored `model = gpt-5.5`, and Codex's rollout log confirms it ran with that model.
3. On that Codex session, the composer's model menu lists only the four GPT models; the effort menu offers `Minimal` and does not offer `Max`.
4. Switching Runtime to Codex in the agent form resets the model picker to `GPT-5.5` and PATCHes `provider: "codex"`.
5. Regression check: a **Claude** agent still seeds `Opus 4.8`, its model menu lists only Claude models, and its effort menu offers `Max` but not `Minimal`.

- [ ] **Step 5: Report honestly**

If any criterion fails, say so with the observed output and stop. Do not describe the work as complete on the strength of a green `swift test`.

---

## Notes for the implementer

- `Effort.allCases` is now the union across providers. It is correct for `Codable` round-trips and for `Effort(rawValue:)`, and wrong for any picker. If you find a third menu built from `allCases`, route it through `AgentDefaults.efforts(for:)`.
- The escape hatch in `AgentsView`'s model `Picker` (injecting an out-of-list current value) is load-bearing. An agent can carry a model outside both lists — an `ANTHROPIC_MODEL` env override pointing at a custom endpoint, per `AgentListLogic.effectiveModel`. Removing it makes the picker render blank.
- Resist adding a `max` → `xhigh` normalizer in Swift. `apiserver` and `runner-go` both do it already, and after Task 5 a Codex menu never offers `Max`.
- `SettingsAdminView` intentionally keeps `claudeModels`. Web's `SettingsPage.tsx:93` does the same.
