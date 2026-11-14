import Foundation
import XCTest
@testable import OrbitKit

/// A runner-scoped Ollama as the native pickers read it: the new provider fields decode beside the
/// old shape, and the row is offered, named and gated the way the rule every server door applies
/// says (docs/ollama-local-provider-contract.md §3.2 and §7).
final class LocalProviderChoiceTests: XCTestCase {
    /// A minute after the probe below: fresh.
    private var now: Date { LocalProviders.parseDate("2026-11-14T00:01:00Z")! }

    private func instance() -> [LocalInstanceModel] {
        [LocalInstanceModel(value: "qwen3.8:27b", label: "Qwen3.8 27B", contextWindow: 65_536, tools: true),
         LocalInstanceModel(value: "qwen3-coder:30b", label: "Qwen3 Coder 30B", contextWindow: 65_536, tools: true)]
    }

    private func local(probeState: String? = "READY", probedAt: String? = "2026-11-14T00:00:30Z",
                       models: [LocalInstanceModel]? = nil, version: String? = "0.40.16")
        -> LocalProviderStatus {
        LocalProviderStatus(state: probeState ?? "UNKNOWN", capability: "SUPPORTED", probedAt: probedAt,
                            version: version, latencyMs: 12, models: models ?? instance())
    }

    private func ollama(scope: String? = "runner", runnerId: String? = "runner-a",
                        local status: LocalProviderStatus? = nil,
                        defaultModel: String? = "qwen3.8:27b",
                        models: [ConfiguredProviderModel]? = nil) -> ConfiguredProvider {
        ConfiguredProvider(
            slug: "ollama", label: "Ollama", runtime: "claude",
            models: models ?? [
                ConfiguredProviderModel(value: "qwen3.8:27b", label: "Qwen3.8 27B", contextWindow: 32_768,
                                        reasoningLevels: ["low", "medium", "xhigh"]),
                ConfiguredProviderModel(value: "qwen3-coder:30b", label: "Qwen3 Coder 30B",
                                        contextWindow: 65_536),
            ],
            defaultModel: defaultModel, presetSlug: "ollama", engines: ["claude"],
            scope: scope, authMode: scope == "runner" ? "none" : "bearer",
            runnerId: runnerId, local: status ?? local())
    }

    private func sources(_ configured: [ConfiguredProvider], runnerID: String? = "runner-a",
                         capabilities: [String]? = ["ollama-probe/v1", "ollama-run/v1"],
                         model: String? = nil) -> ChoiceSources {
        ChoiceSources(configured: configured, now: now, runnerID: runnerID, runnerName: "studio-mac",
                      runnerCapabilities: capabilities, sessionModel: model)
    }

    // MARK: the wire

    func testDecodesTheNewProviderFieldsAndAnOlderServersRow() throws {
        let new = try JSONDecoder().decode(ConfiguredProvider.self, from: Data("""
        { "id": "p1", "slug": "ollama", "label": "Ollama", "runtime": "claude",
          "models": [{ "value": "qwen3.8:27b", "label": "Qwen3.8 27B", "contextWindow": 65536,
                       "reasoningLevels": ["low", "medium", "xhigh"] }],
          "defaultModel": "qwen3.8:27b", "presetSlug": "ollama", "engines": ["claude"],
          "scope": "runner", "authMode": "none", "runnerId": "runner-a",
          "local": { "state": "READY", "capability": "SUPPORTED",
                     "probedAt": "2026-11-14T00:00:30Z", "version": "0.40.16", "latencyMs": 12,
                     "models": [{ "value": "qwen3.8:27b", "label": "Qwen3.8 27B",
                                  "contextWindow": 65536, "tools": true, "parameterSize": "27.3B",
                                  "quantization": "Q4_K_M" }] } }
        """.utf8))
        XCTAssertEqual(new.providerID, "p1")
        XCTAssertTrue(new.isRunnerScoped)
        XCTAssertEqual(new.authMode, "none")
        XCTAssertEqual(new.runnerId, "runner-a")
        XCTAssertEqual(new.local?.state, "READY")
        XCTAssertEqual(new.local?.capability, "SUPPORTED")
        XCTAssertEqual(new.local?.version, "0.40.16")
        XCTAssertEqual(new.local?.latencyMs, 12)
        XCTAssertEqual(new.local?.models?.first?.tools, true)
        XCTAssertEqual(new.local?.models?.first?.contextWindow, 65_536)
        XCTAssertEqual(new.local?.models?.first?.parameterSize, "27.3B")

        // The shape before migration 0646: no scope, no local block, a stored key. It reads as an
        // ordinary account-scoped key, exactly as it did before this release.
        let old = try JSONDecoder().decode(ConfiguredProvider.self, from: Data("""
        { "slug": "deepseek", "label": "DeepSeek", "runtime": "claude",
          "models": [{ "value": "deepseek-v4-pro", "label": "DeepSeek V4 Pro" }],
          "defaultModel": "deepseek-v4-pro", "presetSlug": "deepseek", "engines": ["claude", "opencode"] }
        """.utf8))
        XCTAssertEqual(old.scope, nil)
        XCTAssertNil(old.local)
        XCTAssertNil(old.runnerId)
        XCTAssertFalse(old.isRunnerScoped)
        XCTAssertEqual(old.models.first?.value, "deepseek-v4-pro")
    }

    func testALocalRowWithNoCapabilityFieldsStillDecodes() throws {
        // An older runner reports names and windows only; a model with no `tools` is not healthy,
        // but the row itself must still decode.
        let row = try JSONDecoder().decode(ConfiguredProvider.self, from: Data("""
        { "slug": "ollama", "label": "Ollama", "runtime": "claude", "models": [], "engines": ["claude"],
          "scope": "runner", "authMode": "none", "runnerId": "runner-a",
          "local": { "state": "READY", "capability": "SUPPORTED", "probedAt": null, "version": null,
                     "latencyMs": null, "models": [{ "value": "llama3" }] } }
        """.utf8))
        XCTAssertEqual(row.local?.models?.first?.value, "llama3")
        XCTAssertNil(row.local?.models?.first?.tools)
        XCTAssertNil(row.local?.probedAt)
    }

    // MARK: the picker

    func testAReadyOllamaIsOfferedUnderClaudeCodeWithItsBrandAndStatus() {
        let choices = SessionProviderChoices.providers(for: "claude", sources: sources([ollama()]))
        let row = choices.first { $0.slug == "ollama" }
        let choice = row
        XCTAssertNotNil(choice)
        XCTAssertEqual(choice?.brandKey, "ollama", "the Ollama preset's own mark, not the neutral tile")
        XCTAssertNil(choice?.unavailable)
        XCTAssertEqual(choice?.local?.state, .ready)
        XCTAssertEqual(choice?.local?.summary, "Ready · 0.40.16")
        XCTAssertEqual(choice?.local?.model, "qwen3.8:27b")
        XCTAssertEqual(choice?.local?.runnerID, "runner-a", "the bound runner, for a runner-page remedy")
        XCTAssertEqual(choice?.modelLabel, "Qwen3.8 27B")
        XCTAssertNil(choice?.fixProvider)
        // A local server is its own menu group, not an API key.
        let groups = SessionProviderChoices.menuGroups(choices, listed: true, runnerName: "studio-mac")
        XCTAssertEqual(groups.first { $0.id == "local" }?.title, "Local models")
        XCTAssertEqual(groups.first { $0.id == "local" }?.choices.map(\.slug), ["ollama"])
        XCTAssertEqual(groups.first { $0.id == "keys" }?.choices.map(\.slug) ?? [], [])
    }

    func testAnotherRunnerMeansTheSessionCannotUseIt() {
        let choices = SessionProviderChoices.providers(
            for: "claude", sources: sources([ollama()], runnerID: "runner-b"))
        let choice = choices.first { $0.slug == "ollama" }
        XCTAssertEqual(choice?.local?.refusal?.code, .elsewhere)
        XCTAssertEqual(choice?.unavailable,
                       "Local provider \"ollama\" runs only on the runner it is bound to; start this session on that runner")
        XCTAssertEqual(choice?.local?.remedy, .runnerPage)
        XCTAssertNil(choice?.fixProvider, "the fix is its runner's page, not the provider's")
        XCTAssertNil(choice?.fixEngine, "never a sign-in on the engine")
    }

    func testAnOfflineInstanceOrAMissingModelFailsClosed() {
        let offline = SessionProviderChoices.providers(
            for: "claude",
            sources: sources([ollama(local: local(probeState: "UNREACHABLE"))]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(offline?.local?.refusal?.code, .unreachable)
        XCTAssertNotNil(offline?.unavailable)

        let olderRunner = SessionProviderChoices.providers(
            for: "claude", sources: sources([ollama()], capabilities: ["ollama-probe/v1"]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(olderRunner?.local?.refusal?.code, .runnerOutdated)

        // The owner removed the default model from the instance since it was saved.
        let removed = SessionProviderChoices.providers(
            for: "claude",
            sources: sources([ollama(local: local(models: [LocalInstanceModel(value: "qwen3.5:4b",
                                                                             contextWindow: 32_768,
                                                                             tools: true)]))]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(removed?.local?.refusal?.code, .modelMissing)
        XCTAssertEqual(removed?.fixProvider, "ollama", "Manage — the provider page where its models are fixed")
        XCTAssertEqual(removed?.local?.remedy, .manageProvider)

        // No model named and none discovered: no choice, and no borrowed Claude default.
        let empty = SessionProviderChoices.providers(
            for: "claude",
            sources: sources([ollama(local: local(models: []), defaultModel: "", models: [])]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(empty?.local?.refusal?.code, .modelMissing)
        XCTAssertEqual(empty?.modelLabel, "Managed by the provider")
        XCTAssertTrue(AgentDefaults.models(engine: "claude", provider: "ollama", catalog: nil,
                                           configured: [ollama(local: local(models: []), defaultModel: "",
                                                               models: [])]).isEmpty)
    }

    func testTheModelMenuOffersTheLiveCatalogueAndNamesTheOneItRetired() {
        let row = ollama()
        XCTAssertEqual(AgentDefaults.models(engine: "claude", provider: "ollama", catalog: nil,
                                            configured: [row]).map(\.id),
                       ["qwen3.8:27b", "qwen3-coder:30b"])
        // A model only the instance's catalogue names is still offered.
        let discovered = ollama(local: local(models: instance() + [
            LocalInstanceModel(value: "gemma3:12b", label: "Gemma3 12B", contextWindow: 131_072, tools: true)
        ]))
        XCTAssertEqual(AgentDefaults.models(engine: "claude", provider: "ollama", catalog: nil,
                                            configured: [discovered]).map(\.id),
                       ["qwen3.8:27b", "qwen3-coder:30b", "gemma3:12b"])
        // The instance's measured window beats the row's saved copy.
        XCTAssertEqual(AgentDefaults.contextWindow(for: "qwen3.8:27b", catalog: nil,
                                                   configured: [row], provider: "ollama"), 65_536)
        // A model it no longer serves is not a live pin; the caller then re-resolves the default.
        XCTAssertNil(AgentDefaults.livePin("qwen3.5:4b", engine: "claude", provider: "ollama",
                                           catalog: nil, configured: [row], runtimeDefaults: nil))
        XCTAssertEqual(AgentDefaults.livePin("qwen3.8:27b", engine: "claude", provider: "ollama",
                                             catalog: nil, configured: [row], runtimeDefaults: nil),
                       "qwen3.8:27b")
    }

    func testAStateTheServerDerivedReadsBackAsTheSameState() {
        // The provider payload serves a derived `state` (never the stored probe column), so a
        // picker reads STALE back in — and a disabled row stays disabled even without `enabled`.
        let stale = LocalProviderStatus(state: "STALE", capability: "SUPPORTED",
                                        probedAt: "2026-11-13T23:00:00Z", version: "0.40.16",
                                        latencyMs: 12, models: instance())
        let staleRow = ollama(local: stale)
        let staleChoice = SessionProviderChoices.providers(for: "claude", sources: sources([staleRow]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(staleChoice?.local?.state, .stale)
        XCTAssertEqual(staleChoice?.local?.refusal?.code, .stale)
        XCTAssertEqual(staleChoice?.local?.remedy, .runnerPage)

        let off = LocalProviderStatus(state: "DISABLED", capability: "SUPPORTED", probedAt: nil,
                                      version: nil, latencyMs: nil, models: instance())
        let offChoice = SessionProviderChoices.providers(for: "claude", sources: sources([ollama(local: off)]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(offChoice?.local?.state, .disabled)
        XCTAssertEqual(offChoice?.local?.refusal?.code, .disabled)
        XCTAssertEqual(offChoice?.fixProvider, "ollama")
    }

    /// The runner a runner-page remedy opens is the provider's own, never the session's or the
    /// task assignee's. ELSEWHERE is the case that separates the two; a same-runner refusal must
    /// still name the bound runner (and therefore coincides with the session's).
    func testARunnerRemedyTargetsTheProvidersOwnRunner() {
        let elsewhereRow = ollama()
        let elsewhere = SessionProviderChoices.providers(
            for: "claude", sources: sources([elsewhereRow], runnerID: "runner-b"))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(elsewhere?.local?.refusal?.code, .elsewhere)
        XCTAssertEqual(elsewhere?.local?.runnerID, "runner-a")
        XCTAssertEqual(elsewhere.flatMap(SessionProviderChoices.localFixTarget), .runner(id: "runner-a"),
                       "the bound runner, not the session's runner-b")
        XCTAssertNotEqual(elsewhere.flatMap(SessionProviderChoices.localFixTarget), .runner(id: "runner-b"))

        // A same-runner state: the machine is right here, and the row still names it.
        let offline = SessionProviderChoices.providers(
            for: "claude", sources: sources([ollama(local: local(probeState: "UNREACHABLE"))]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(offline?.local?.refusal?.code, .unreachable)
        XCTAssertEqual(offline.flatMap(SessionProviderChoices.localFixTarget), .runner(id: "runner-a"))

        // A runner too old to run it: its own page is where it updates.
        let old = SessionProviderChoices.providers(
            for: "claude", sources: sources([ollama()], capabilities: ["ollama-probe/v1"]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(old?.local?.refusal?.code, .runnerOutdated)
        XCTAssertEqual(old.flatMap(SessionProviderChoices.localFixTarget), .runner(id: "runner-a"))

        // A provider-side refusal names the provider page instead.
        let removed = SessionProviderChoices.providers(
            for: "claude", sources: sources([ollama(local: local(models: []))]))
            .first { $0.slug == "ollama" }
        XCTAssertEqual(removed.flatMap(SessionProviderChoices.localFixTarget), .providerPage(slug: "ollama"))
    }

    /// The production path (`providers` → `localChoice`) must not read a missing capability report
    /// as a missing runner. The row names its runner; the runner simply has not said what it can do,
    /// which the server, the Web picker and the shared fixture all call UNKNOWN / runner-outdated.
    func testAMissingCapabilityReportIsNotAMissingRunner() throws {
        let choices = SessionProviderChoices.providers(
            for: "claude",
            sources: sources([ollama()], runnerID: "runner-a", capabilities: nil))
        let choice = try XCTUnwrap(choices.first { $0.slug == "ollama" })
        XCTAssertEqual(choice.local?.state, .unknown, "a runner that has not reported is unknown, not absent")
        XCTAssertNotEqual(choice.local?.state, .noRunner)
        XCTAssertEqual(choice.local?.runnerID, "runner-a")
        XCTAssertEqual(choice.local?.refusal?.code, .runnerOutdated)
        XCTAssertEqual(SessionProviderChoices.localFixTarget(choice), .runner(id: "runner-a"))

        // The same answer the shared fixture gives the Web for this shape.
        let expected = try fixtureRefusal(case: "old-runner")
        XCTAssertEqual(choice.local?.refusal?.code, expected.code)
        XCTAssertEqual(choice.local?.refusal?.message, expected.message)
    }

    /// One case's expected refusal from `contracts/ollama-provider.fixtures.json`, so this test
    /// compares against the Web reading rather than a second copy of its sentence.
    private func fixtureRefusal(case name: String) throws -> (code: LocalProviderRefusalCode,
                                                              message: String) {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = root.appendingPathComponent("contracts/ollama-provider.fixtures.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let cases = json?["cases"] as? [[String: Any]]
                let one = cases?.first { $0["name"] as? String == name }
                let expect = one?["expect"] as? [String: Any]
                let refusal = expect?["refusal"] as? [String: Any]
                let code = try XCTUnwrap((refusal?["code"] as? String)
                    .flatMap(LocalProviderRefusalCode.init(rawValue:)))
                let message = try XCTUnwrap(refusal?["message"] as? String)
                return (code, message)
            }
            root.deleteLastPathComponent()
        }
        throw CocoaError(.fileReadNoSuchFile)
    }

    func testAnAccountScopedKeyIsUnchanged() {
        let key = ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude",
                                     models: [ConfiguredProviderModel(value: "deepseek-v4-pro",
                                                                      label: "DeepSeek V4 Pro")],
                                     defaultModel: "deepseek-v4-pro", presetSlug: "deepseek",
                                     engines: ["claude", "opencode"])
        let choice = SessionProviderChoices.providers(for: "claude", sources: sources([key]))
            .first { $0.slug == "deepseek" }
        XCTAssertNil(choice?.local)
        XCTAssertNil(choice?.unavailable)
        XCTAssertNil(choice?.fixProvider)
        XCTAssertEqual(choice?.modelLabel, "DeepSeek V4 Pro")
    }
}
