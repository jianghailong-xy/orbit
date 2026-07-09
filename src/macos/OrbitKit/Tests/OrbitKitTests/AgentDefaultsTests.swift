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
}
