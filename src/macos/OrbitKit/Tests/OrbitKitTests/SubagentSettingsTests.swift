import XCTest
@testable import OrbitKit

/// SubAgents settings and the Model tiers table (docs/subagent-design.md §7): the wire shapes, the workspace
/// fields' defaults, and the words each cell and button draws.
final class SubagentSettingsTests: XCTestCase {

    private let tiersJSON = """
    {"providers":[
      {"slug":"deepseek","label":"DeepSeek","kind":"key","providerId":"p1","billing":"key",
       "models":[{"model":"deepseek-chat","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":0.6}]},
      {"slug":"claude","label":"Claude","kind":"builtin","providerId":null,"billing":"subscription",
       "models":[{"model":"claude-sonnet-5-5","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":null},
                 {"model":"claude-opus-5-5","levels":["L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null}]},
      {"slug":"codex","label":"Codex","kind":"builtin","providerId":null,"billing":"subscription",
       "models":[{"model":"gpt-5.6-sol","levels":["S","M","L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null}]},
      {"slug":"my-endpoint","label":"My endpoint","kind":"key","providerId":"p2","billing":"key",
       "models":[{"model":"qwen-coder","levels":[],"source":null,"editable":true,"outputPricePerMTok":null}]},
      {"slug":"team-pool","label":"Team pool","kind":"pool","providerId":null,"billing":"subscription","models":[]}
    ]}
    """

    private func tiers() throws -> SubagentTiersResponse {
        try JSONDecoder().decode(SubagentTiersResponse.self, from: Data(tiersJSON.utf8))
    }

    func testTiersResponseDecodes() throws {
        let r = try tiers()
        XCTAssertEqual(r.providers.map(\.slug), ["deepseek", "claude", "codex", "my-endpoint", "team-pool"])
        XCTAssertEqual(r.providers[0].providerId, "p1")
        XCTAssertNil(r.providers[1].providerId)
        XCTAssertEqual(r.providers[1].billing, "subscription")
        XCTAssertEqual(r.providers[0].models[0].outputPricePerMTok, 0.6)
        XCTAssertEqual(r.providers[3].models[0].levels, [])
        XCTAssertNil(r.providers[3].models[0].source)
        XCTAssertTrue(r.providers[3].models[0].editable)
        XCTAssertEqual(r.providers[4].kind, "pool")
    }

    func testTableSkipsProvidersWithoutModels() throws {
        XCTAssertEqual(SubagentSettings.tableProviders(try tiers().providers).map(\.slug),
                       ["deepseek", "claude", "codex", "my-endpoint"])
    }

    func testTierText() {
        XCTAssertEqual(SubagentSettings.tierText([]), "Not set")
        XCTAssertTrue(SubagentSettings.tierIsUnset([]))
        XCTAssertEqual(SubagentSettings.tierText(["S", "M", "L", "XL"]), "S–XL by effort")
        XCTAssertEqual(SubagentSettings.tierText(["L", "XL"]), "L · XL")
        XCTAssertEqual(SubagentSettings.tierText(["M"]), "M")
        XCTAssertFalse(SubagentSettings.tierIsUnset(["M"]))
        XCTAssertFalse(SubagentSettings.menuOffersClear([]))
        XCTAssertTrue(SubagentSettings.menuOffersClear(["S"]))
    }

    func testPriceText() {
        XCTAssertEqual(SubagentSettings.priceText(ProviderModelTier(model: "a", levels: [], outputPricePerMTok: 0.6),
                                                  billing: "key"), "$0.60")
        XCTAssertEqual(SubagentSettings.priceText(ProviderModelTier(model: "a", levels: [], outputPricePerMTok: 15),
                                                  billing: "subscription"), "$15.00")
        XCTAssertEqual(SubagentSettings.priceText(ProviderModelTier(model: "a", levels: []), billing: "subscription"),
                       "Subscription")
        XCTAssertEqual(SubagentSettings.priceText(ProviderModelTier(model: "a", levels: []), billing: "key"), "—")
    }

    func testProvidersButtonCountsEveryProviderListed() throws {
        let providers = try tiers().providers
        XCTAssertEqual(SubagentSettings.providersButton(providers, blocked: []), "5 of 5 · Edit")
        XCTAssertEqual(SubagentSettings.providersButton(providers, blocked: ["codex"]), "4 of 5 · Edit")
        // A slug no longer listed blocks nothing that is counted.
        XCTAssertEqual(SubagentSettings.allowedCount(providers, blocked: ["codex", "gone"]), 4)
    }

    func testBlockedListMoves() {
        XCTAssertEqual(SubagentSettings.blocked([], slug: "codex", allowed: false), ["codex"])
        XCTAssertEqual(SubagentSettings.blocked(["codex"], slug: "codex", allowed: false), ["codex"])
        XCTAssertEqual(SubagentSettings.blocked(["a", "codex"], slug: "codex", allowed: true), ["a"])
    }

    func testTierUpdateSendsNullToClear() throws {
        let clear = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ProviderModelTierUpdate(model: "qwen-coder", tier: nil))) as? [String: Any]
        XCTAssertEqual(clear?["model"] as? String, "qwen-coder")
        XCTAssertTrue(clear?.keys.contains("tier") == true)
        XCTAssertTrue(clear?["tier"] is NSNull)
        let set = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ProviderModelTierUpdate(model: "qwen-coder", tier: "L"))) as? [String: Any]
        XCTAssertEqual(set?["tier"] as? String, "L")
    }

    func testWorkspaceFieldsDecodeAndDefault() throws {
        let set = try JSONDecoder().decode(Agent.self, from: Data("""
        {"id":"a1","name":"orbit","modelRoutingOptimizeFor":"intelligence","subagentsEnabled":false,"subagentsMaxRunning":7}
        """.utf8))
        XCTAssertEqual(SubagentSettings.OptimizeFor(stored: set.modelRoutingOptimizeFor), .intelligence)
        XCTAssertEqual(set.subagentsEnabled, false)
        XCTAssertEqual(SubagentSettings.maxRunning(set.subagentsMaxRunning), 7)

        let absent = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"orbit"}"#.utf8))
        XCTAssertNil(absent.subagentsEnabled)
        XCTAssertEqual(absent.subagentsEnabled ?? true, true)
        XCTAssertEqual(SubagentSettings.OptimizeFor(stored: absent.modelRoutingOptimizeFor), .cost)
        XCTAssertEqual(SubagentSettings.maxRunning(absent.subagentsMaxRunning), 4)
        XCTAssertEqual(SubagentSettings.OptimizeFor(stored: "fastest"), .cost)
        XCTAssertEqual(SubagentSettings.maxRunning(99), 16)
        XCTAssertEqual(SubagentSettings.maxRunning(0), 1)
    }

    func testWorkspaceUpdateSendsOnlyWhatMoved() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdateAgentRequest(modelRoutingOptimizeFor: "balance", subagentsEnabled: false, subagentsMaxRunning: 6)))
            as? [String: Any]
        XCTAssertEqual(body?["modelRoutingOptimizeFor"] as? String, "balance")
        XCTAssertEqual(body?["subagentsEnabled"] as? Bool, false)
        XCTAssertEqual(body?["subagentsMaxRunning"] as? Int, 6)
        let none = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UpdateAgentRequest())) as? [String: Any]
        XCTAssertEqual(none?.isEmpty, true)
    }

    func testBlockedProvidersPreference() throws {
        let u = try JSONDecoder().decode(User.self, from: Data("""
        {"id":"u1","email":"a@b.com","preferences":{"subagentBlockedProviders":["codex"]}}
        """.utf8))
        XCTAssertEqual(u.preferences?.subagentBlockedProviders, ["codex"])
        let none = try JSONDecoder().decode(User.self, from: Data(#"{"id":"u1","email":"a@b.com","preferences":{}}"#.utf8))
        XCTAssertNil(none.preferences?.subagentBlockedProviders)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdatePreferencesRequest(subagentBlockedProviders: []))) as? [String: Any]
        XCTAssertEqual(body?["subagentBlockedProviders"] as? [String], [])
        // The sheet's write is the whole list and nothing else.
        let codex = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdatePreferencesRequest(subagentBlockedProviders: ["codex"]))) as? [String: Any]
        XCTAssertEqual(codex?.count, 1)
        XCTAssertEqual(codex?["subagentBlockedProviders"] as? [String], ["codex"])
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(UpdatePreferencesRequest(subagentBlockedProviders: ["codex"])),
                              as: UTF8.self), #"{"subagentBlockedProviders":["codex"]}"#)
    }
}
