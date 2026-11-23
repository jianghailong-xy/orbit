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

    /// The Quality column (docs/subagent-design.md §7.1, board docs/mocks/model-quality/01-board.png): decoded from the
    /// tiers response, absent read as no runs, and drawn as the two lines web draws.
    func testQualityDecodesAndAbsentIsNoRuns() throws {
        let json = """
        {"providers":[{"slug":"claude","label":"Claude","kind":"builtin","billing":"subscription","models":[
          {"model":"claude-opus-5-5","levels":["L"],"quality":{
            "subagent":{"averageRating":4.4,"ratedCount":23,"runCount":41,"raters":[
              {"engine":"claude","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","count":15},
              {"engine":"claude","provider":"claude","model":"claude-sonnet-5-5","label":"Sonnet 5.5","count":8}]},
            "tasks":{"firstPassRate":0.86,"firstPassTaskCount":45,"completedTaskCount":52}}},
          {"model":"claude-haiku-5-5","levels":["S"]}]}]}
        """
        let models = try JSONDecoder().decode(SubagentTiersResponse.self, from: Data(json.utf8)).providers[0].models
        XCTAssertEqual(models[0].quality.subagent.raters.map(\.count), [15, 8])
        XCTAssertEqual(models[1].quality, .none)

        let rated = SubagentSettings.qualityLines(models[0].quality)
        XCTAssertFalse(rated.empty)
        XCTAssertEqual(rated.subagents, QualityLine(text: "4.4 · 23 rated of 41", muted: false))
        XCTAssertEqual(rated.tasks, QualityLine(text: "86% first pass · 52 tasks", muted: false))
        XCTAssertEqual(rated.raters, "Rated by Opus 5.5 (15) · Sonnet 5.5 (8)")
        XCTAssertTrue(SubagentSettings.qualityLines(models[1].quality).empty)
    }

    func testQualityBelowTheMinimumsSaysWhy() {
        let sparse = SubagentSettings.qualityLines(ModelQuality(
            subagent: ModelSubagentQuality(ratedCount: 3, runCount: 12,
                                           raters: [ModelQualityRater(provider: "codex", count: 3)]),
            tasks: ModelTaskQuality(firstPassTaskCount: 6, completedTaskCount: 6)))
        XCTAssertFalse(sparse.empty, "some runs: both lines, not No runs yet")
        XCTAssertEqual(sparse.subagents, QualityLine(text: "Not enough ratings", muted: true))
        XCTAssertEqual(sparse.tasks, QualityLine(text: "Not enough tasks", muted: true))
        XCTAssertNil(sparse.raters, "no tooltip without an average")
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
        let older = ProviderModelTier(model: "claude-opus-5", levels: [], supersededBy: "claude-opus-5-5")
        XCTAssertEqual(SubagentSettings.modelTierText(older), "Older · uses claude-opus-5-5")
        XCTAssertTrue(SubagentSettings.tierIsOlder(older))
        let tiered = ProviderModelTier(model: "claude-opus-5", levels: ["M"], supersededBy: "claude-opus-5-5")
        XCTAssertEqual(SubagentSettings.modelTierText(tiered), "M")
        XCTAssertEqual(SubagentSettings.modelTierText(ProviderModelTier(model: "grok", levels: [])), "Not set")
        XCTAssertFalse(SubagentSettings.tierIsUnset(["M"]))
    }

    /// The tier write's door, Clear and the Yours tag (board 2026-11-20): a built-in engine's every model is the owner's
    /// to tier through providers/builtin/:slug/model-tier; Clear only where the owner set it; a key keeps its own door.
    func testBuiltinTierDoorClearAndYours() {
        let cursor = ProviderTierRow(slug: "cursor", label: "Cursor", kind: "builtin", billing: "subscription")
        let key = ProviderTierRow(slug: "my-endpoint", label: "My endpoint", kind: "key", providerId: "p2")
        let shared = ProviderTierRow(slug: "shared", label: "Shared", kind: "key")
        let family = ProviderModelTier(model: "claude-opus-5-6", levels: ["L", "XL"], source: "catalogue", editable: true)
        let owned = ProviderModelTier(model: "grok-4.7", levels: ["L"], source: "owner", editable: true)
        let unset = ProviderModelTier(model: "kimi-k3", levels: [], source: nil, editable: true)
        let preset = ProviderModelTier(model: "deepseek-chat", levels: ["S"], source: "catalogue", editable: false)

        XCTAssertEqual(SubagentSettings.tierPath(cursor, family), "providers/builtin/cursor/model-tier")
        XCTAssertEqual(SubagentSettings.tierPath(cursor, unset), "providers/builtin/cursor/model-tier")
        XCTAssertEqual(SubagentSettings.tierPath(key, unset), "providers/mine/p2/model-tier")
        XCTAssertNil(SubagentSettings.tierPath(key, preset), "the catalogue's tier on a key is not the owner's")
        XCTAssertNil(SubagentSettings.tierPath(shared, unset), "a key not the owner's own has no door")

        XCTAssertFalse(SubagentSettings.menuOffersClear(cursor, family), "a catalogue tier has nothing to clear")
        XCTAssertFalse(SubagentSettings.menuOffersClear(cursor, unset))
        XCTAssertTrue(SubagentSettings.menuOffersClear(cursor, owned))
        XCTAssertFalse(SubagentSettings.menuOffersClear(key, unset))
        XCTAssertTrue(SubagentSettings.menuOffersClear(key, ProviderModelTier(model: "q", levels: ["M"], source: "owner", editable: true)))

        XCTAssertTrue(SubagentSettings.showsYours(owned))
        XCTAssertFalse(SubagentSettings.showsYours(family))
        XCTAssertFalse(SubagentSettings.showsYours(unset))
        XCTAssertEqual(SubagentSettings.yours, "Yours")
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
        {"id":"a1","name":"orbit","subagentsEnabled":false,"subagentsMaxRunning":7,"workflowsEnabled":false}
        """.utf8))
        XCTAssertEqual(set.subagentsEnabled, false)
        XCTAssertEqual(SubagentSettings.maxRunning(set.subagentsMaxRunning), 7)
        XCTAssertEqual(set.workflowsEnabled, false)

        let absent = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"orbit"}"#.utf8))
        XCTAssertNil(absent.subagentsEnabled)
        XCTAssertEqual(absent.subagentsEnabled ?? true, true)
        XCTAssertNil(absent.workflowsEnabled)
        XCTAssertEqual(absent.workflowsEnabled ?? true, true, "Workflows is on unless the Agent says otherwise")
        XCTAssertEqual(SubagentSettings.maxRunning(absent.subagentsMaxRunning), 4)
        XCTAssertEqual(SubagentSettings.maxRunning(99), 16)
        XCTAssertEqual(SubagentSettings.maxRunning(0), 1)
    }

    func testWorkspaceUpdateSendsOnlyWhatMoved() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            UpdateAgentRequest(subagentsEnabled: false, subagentsMaxRunning: 6, workflowsEnabled: false)))
            as? [String: Any]
        XCTAssertEqual(body?["subagentsEnabled"] as? Bool, false)
        XCTAssertEqual(body?["subagentsMaxRunning"] as? Int, 6)
        XCTAssertEqual(body?["workflowsEnabled"] as? Bool, false)
        // Optimize For is the account's now (Settings → General): no Agent write can name it.
        XCTAssertFalse(body?.keys.contains("modelRoutingOptimizeFor") ?? false)
        let none = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UpdateAgentRequest())) as? [String: Any]
        XCTAssertEqual(none?.isEmpty, true)
    }

    /// Board docs/mocks/subagent-workflow part 5: the Workflows row's words, and the switch following SubAgents.
    func testWorkflowsRowFollowsSubAgents() {
        XCTAssertEqual(SubagentSettings.workflowsTitle, "Workflows")
        XCTAssertEqual(SubagentSettings.workflowsDetail, "Let this agent run a script that starts many SubAgents and wakes it once")
        XCTAssertEqual(SubagentSettings.runningAtOnceDetail, "Per session: delegated SubAgents and workflow calls together")
        XCTAssertTrue(SubagentSettings.workflowsOn(subagentsEnabled: true, workflowsEnabled: true))
        XCTAssertFalse(SubagentSettings.workflowsOn(subagentsEnabled: true, workflowsEnabled: false))
        XCTAssertFalse(SubagentSettings.workflowsOn(subagentsEnabled: false, workflowsEnabled: true), "off with SubAgents")
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

    /// One model on several providers is one block: its rows together, the first naming it, the others pooled with it.
    func testTableRowsDrawOneBlockPerModel() throws {
        let json = """
        {"providers":[
          {"slug":"kimi","label":"Kimi Code","kind":"builtin","providerId":null,"billing":"subscription",
           "models":[{"model":"kimi-code/k3","levels":["S"],"identity":{"key":"k3","name":"Kimi K3"}}]},
          {"slug":"claude","label":"Claude Code","kind":"builtin","providerId":null,"billing":"subscription",
           "models":[{"model":"claude-sonnet-5-5","levels":["S","M"],"identity":{"key":"claude-sonnet-5-5","name":"Claude Sonnet 5.5"}}]},
          {"slug":"moonshot","label":"Kimi (Moonshot)","kind":"key","providerId":"p3","billing":"key",
           "models":[{"model":"kimi-k3","levels":["S"],"identity":{"key":"k3","name":"Kimi K3"}},
                     {"model":"old-model","levels":[]}]}
        ]}
        """
        let providers = try JSONDecoder().decode(SubagentTiersResponse.self, from: Data(json.utf8)).providers
        let rows = SubagentSettings.tableRows(providers)
        XCTAssertEqual(rows.map { "\($0.provider.slug) \($0.name)" },
                       ["kimi Kimi K3", "moonshot Kimi K3", "claude Claude Sonnet 5.5", "moonshot old-model"])
        XCTAssertEqual(rows.map(\.continues), [false, true, false, false])
        XCTAssertEqual(rows.map(\.continued), [true, false, false, false])
        XCTAssertEqual(rows[0].pooledWith, ["Kimi (Moonshot)"])
        XCTAssertEqual(rows[2].pooledWith, [])
        XCTAssertEqual(rows[3].model.identity, nil, "an older server sends none: the row is its own block")
    }

    /// "Pooled across N providers" only where there is a figure to explain.
    func testPooledLineOnlyWithAFigure() {
        let rated = ModelQuality(tasks: ModelTaskQuality(firstPassRate: 0.8, firstPassTaskCount: 8, completedTaskCount: 10))
        let unrated = ModelQuality(subagent: ModelSubagentQuality(runCount: 3), tasks: ModelTaskQuality(completedTaskCount: 2))
        XCTAssertEqual(SubagentSettings.pooledText(SubagentSettings.qualityLines(rated), pooledWith: ["Codex Pool"]),
                       "Pooled across 2 providers")
        XCTAssertNil(SubagentSettings.pooledText(SubagentSettings.qualityLines(unrated), pooledWith: ["Codex Pool"]))
        XCTAssertNil(SubagentSettings.pooledText(SubagentSettings.qualityLines(rated), pooledWith: []))
        XCTAssertEqual(SubagentSettings.pooledTip(["Cursor CLI", "Codex Pool"]), "Runs on Cursor CLI, Codex Pool are counted too")
    }
}
