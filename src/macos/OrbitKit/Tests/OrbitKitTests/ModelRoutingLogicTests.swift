import Foundation
import XCTest
@testable import OrbitKit

/// Smart model selection on the native clients (docs/model-routing-design.md §9): the tier
/// suggested for a task, what each run was routed to and why, the Agent's switch, and the composer's
/// ✦ — the payloads they read and the rules `TaskDetailLogic` / `ComposerLogic` draw them by. The
/// detail below is shaped like `GET /tasks/34ZI8zFsQpNIaGbCoAq0D` answered on 2026-10-03.
final class ModelRoutingLogicTests: XCTestCase {

    private func task(_ json: String) throws -> TaskItem {
        try JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
    }

    /// ICU puts a narrow no-break space before AM/PM; the words are what is compared.
    private func plain(_ s: String) -> String { s.replacingOccurrences(of: "\u{202F}", with: " ") }

    private let options = [
        ModelHintOption(level: "S", provider: "claude", model: "claude-sonnet-5-5", label: "Sonnet 5.5", effort: "low"),
        ModelHintOption(level: "M", provider: "claude", model: "claude-sonnet-5-5", label: "Sonnet 5.5", effort: "medium"),
        ModelHintOption(level: "L", provider: "claude", model: "claude-opus-5-5", label: "Opus 5.5", effort: "high"),
        ModelHintOption(level: "XL", provider: "claude", model: "claude-opus-5-5", label: "Opus 5.5", effort: "max"),
    ]

    private lazy var detail: TaskItem = try! task("""
    {"id":"34ZI8zFsQpNIaGbCoAq0D","title":"P4 · macOS/iOS 界面","status":"OPEN","provider":"claude","model":null,
     "modelHint":"M","modelHintReason":"照 Web 同一套改动做 macOS/iOS 界面，文案有 parity 测试约束，规格清楚。",
     "modelHintOptions":[
       {"level":"S","provider":"claude","model":"claude-sonnet-5-5","label":"Sonnet 5.5","effort":"low"},
       {"level":"M","provider":"claude","model":"claude-sonnet-5-5","label":"Sonnet 5.5","effort":"medium"},
       {"level":"L","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","effort":"high"},
       {"level":"XL","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","effort":"max"}],
     "sessions":[
       {"id":"54rhVELzAzAWEamF9ysIek","title":"执行任务","status":"RUNNING","runState":"RUNNING",
        "createdAt":"2026-10-03T16:21:53.017Z","model":"claude-opus-5-5","effort":"ultra",
        "agent":{"name":"orbit-develop"},
        "route":{"level":"M","provider":"claude","model":"claude-sonnet-5-5","effort":"medium","applied":false,
                 "escalated":false,
                 "reasons":["Tier M: suggested by the coordinator — 照 Web 同一套改动做 macOS/iOS 界面",
                            "Engine claude: pinned on the task"],
                 "policyVersion":1,"decidedAt":"2026-10-03T16:21:52.941Z"}},
       {"id":"6zxEzQBFPXQarUPtOMTFoX","title":"执行任务","status":"CANCELLED","runState":"ENDED",
        "createdAt":"2026-10-03T06:45:17.414Z","model":null,"effort":"max","agent":{"name":"orbit"},
        "route":{"level":null,"provider":"claude","model":null,"effort":"max","applied":false,"escalated":false,
                 "reasons":["No suggestion — keeps the agent's model, as today"],
                 "policyVersion":1,"decidedAt":"2026-10-03T06:45:17.335Z"}}]}
    """)

    // MARK: payloads

    func testTheTaskDetailCarriesItsTierItsReasonAndEachTiersModel() {
        XCTAssertEqual(detail.modelHint, "M")
        XCTAssertEqual(detail.modelHintReason, "照 Web 同一套改动做 macOS/iOS 界面，文案有 parity 测试约束，规格清楚。")
        XCTAssertEqual(detail.modelHintOptions, options)
        let run = detail.sessions?.first
        XCTAssertEqual(run?.model, "claude-opus-5-5")
        XCTAssertEqual(run?.effort, "ultra")
        XCTAssertEqual(run?.route?.level, "M")
        XCTAssertEqual(run?.route?.applied, false)
        XCTAssertEqual(run?.route?.reasons.count, 2)
        XCTAssertEqual(run?.route?.policyVersion, 1)
        XCTAssertEqual(run?.route?.decidedAt, "2026-10-03T16:21:52.941Z")
        XCTAssertNil(detail.sessions?[1].model)
    }

    func testAnOlderServerAndAThinDecisionStillDecode() throws {
        let old = try task(#"{"id":"T","title":"t","status":"OPEN","sessions":[{"id":"s1","status":"SUCCEEDED"}]}"#)
        XCTAssertNil(old.modelHint)
        XCTAssertNil(old.modelHintReason)
        XCTAssertNil(old.modelHintOptions)
        XCTAssertNil(old.sessions?.first?.route)
        XCTAssertNil(old.sessions?.first?.model)
        // A decision missing what this build reads costs its detail, never the page it sits on.
        let thin = try JSONDecoder().decode(TaskRunRoute.self, from: Data(#"{"level":"L"}"#.utf8))
        XCTAssertEqual(thin, TaskRunRoute(level: "L", provider: "", model: nil, effort: nil, applied: false,
                                          escalated: false, reasons: [], policyVersion: 0, decidedAt: ""))
    }

    func testTheSessionDetailCarriesItsRoute() throws {
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data("""
        {"id":"s1","route":{"level":"L","provider":"claude","model":"claude-opus-5-5","effort":"high",
          "applied":true,"escalated":true,"reasons":["Tier L: one above run 1 (M), because run 1 failed"],
          "policyVersion":1,"decidedAt":"2026-10-03T02:24:00.000Z"}}
        """.utf8))
        XCTAssertEqual(detail.route?.level, "L")
        XCTAssertEqual(detail.route?.escalated, true)
        XCTAssertEqual(detail.route?.reasons.first, "Tier L: one above run 1 (M), because run 1 failed")
        XCTAssertNil(try JSONDecoder().decode(SessionDetail.self, from: Data(#"{"id":"s2","route":null}"#.utf8)).route)
        XCTAssertNil(SessionDetail(id: "s3").route)
    }

    // MARK: Suggested

    func testEachTierIsNamedByTheModelAndEffortTheServerResolvedItTo() {
        XCTAssertEqual(TaskDetailLogic.modelHintLabel("M", options: options), "M · Sonnet 5.5 · medium")
        XCTAssertEqual(TaskDetailLogic.modelHintLabel("XL", options: options), "XL · Opus 5.5 · max")
        // No tier table here: a tier the server could not resolve is the bare tier.
        XCTAssertEqual(TaskDetailLogic.modelHintLabel("L", options: nil), "L")
        XCTAssertEqual(TaskDetailLogic.modelHintLabel("L", options: [ModelHintOption(level: "L", provider: "kimi")]), "L")
    }

    func testThePickerOffersNoSuggestionThenTheFourTiersWithTheWorkEachIsFor() {
        let picks = TaskDetailLogic.modelHintPicks(options)
        XCTAssertEqual(picks.map(\.value), [nil, "S", "M", "L", "XL"])
        XCTAssertEqual(picks.map(\.label), ["No suggestion", "S · Sonnet 5.5 · low", "M · Sonnet 5.5 · medium",
                                            "L · Opus 5.5 · high", "XL · Opus 5.5 · max"])
        XCTAssertEqual(picks.map(\.detail), [
            "Keeps the agent's model, as today",
            "Rename, copy change, version bump, mechanical edits",
            "A clear feature or fix with a known shape",
            "Unknown root cause, concurrency, cross-module, migrations, the dispatch path",
            "Architecture, design, long unattended work",
        ])
        XCTAssertEqual(Set(picks.map(\.id)).count, picks.count, "every row has its own identity")
    }

    func testATiersNameInTheMenuBreaksOnlyAfterADot() {
        let nbsp = "\u{00A0}"
        XCTAssertEqual(TaskDetailLogic.menuTitle("M · Sonnet 5.5 · medium"),
                       "M\(nbsp)· Sonnet\(nbsp)5.5\(nbsp)· medium")
        XCTAssertEqual(TaskDetailLogic.menuTitle("No suggestion"), "No\(nbsp)suggestion")
        XCTAssertEqual(TaskDetailLogic.menuTitle("L"), "L")
        // The same words, only the spaces differ.
        XCTAssertEqual(TaskDetailLogic.menuTitle("XL · Opus 5.5 · max").replacingOccurrences(of: nbsp, with: " "),
                       "XL · Opus 5.5 · max")
    }

    func testTheCoordinatorsReasonReadsUnderTheTierItArguesFor() throws {
        XCTAssertEqual(TaskDetailLogic.modelHintNote(detail),
                       "Coordinator: 照 Web 同一套改动做 macOS/iOS 界面，文案有 parity 测试约束，规格清楚。")
        let reasonWithoutTier = try task(#"{"id":"T","title":"t","status":"OPEN","modelHintReason":"why"}"#)
        XCTAssertNil(TaskDetailLogic.modelHintNote(reasonWithoutTier))
        let tierWithoutReason = try task(#"{"id":"T","title":"t","status":"OPEN","modelHint":"S"}"#)
        XCTAssertNil(TaskDetailLogic.modelHintNote(tierWithoutReason))
    }

    func testAPickByHandClearsTheReasonAndNoSuggestionClearsBoth() throws {
        let picked = try json(TaskDetailLogic.modelHintRequest("L"))
        XCTAssertEqual(picked["modelHint"] as? String, "L")
        XCTAssertTrue(picked["modelHintReason"] is NSNull, "the reason was written for the tier being replaced")
        XCTAssertEqual(picked.count, 2)
        let cleared = try json(TaskDetailLogic.modelHintRequest(nil))
        XCTAssertTrue(cleared["modelHint"] is NSNull)
        XCTAssertTrue(cleared["modelHintReason"] is NSNull)
        XCTAssertEqual(cleared.count, 2)
        // Three states: a request that names neither leaves both alone.
        let other = try json(UpdateTaskRequest(model: .set("claude-opus-5-5")))
        XCTAssertNil(other["modelHint"])
        XCTAssertNil(other["modelHintReason"])
    }

    // MARK: runs

    private let modelName: (String) -> String = { id in
        ["claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5"][id] ?? id
    }

    private func session(model: String? = nil, effort: String? = nil, route: TaskRunRoute?) throws -> SessionRef {
        var object: [String: Any] = ["id": "s1", "status": "SUCCEEDED"]
        if let model { object["model"] = model }
        if let effort { object["effort"] = effort }
        if let route {
            object["route"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(route))
        }
        return try JSONDecoder().decode(SessionRef.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func route(level: String? = "M", model: String? = "claude-sonnet-5-5", effort: String? = "medium",
                       applied: Bool = true, escalated: Bool = false) -> TaskRunRoute {
        TaskRunRoute(level: level, provider: "claude", model: model, effort: effort, applied: applied,
                     escalated: escalated, reasons: ["Tier M: suggested by the coordinator"], policyVersion: 1,
                     decidedAt: "2026-10-03T01:12:00.000Z")
    }

    func testOnlyADecisionThatNamedATierIsShownBesideItsRun() throws {
        XCTAssertNotNil(TaskDetailLogic.runRoute(detail.sessions![0], smartSelection: true))
        XCTAssertNil(TaskDetailLogic.runRoute(detail.sessions![1], smartSelection: true), "No suggestion routed nothing")
        XCTAssertNil(TaskDetailLogic.runRoute(try session(route: nil), smartSelection: true), "a run with no decision at all")
    }

    func testARunSaysWhatItRanOn() throws {
        // Its own row first: a shadow run kept the Agent's model, whatever the pick was.
        let shadow = try session(model: "claude-opus-5-5", effort: "ultra", route: route(applied: false))
        XCTAssertEqual(TaskDetailLogic.runModelLine(shadow, smartSelection: true, modelLabel: modelName), "Opus 5.5 · ultra")
        // An applied run not claimed yet is on the pick.
        let unclaimed = try session(route: route(model: "claude-opus-5-5", effort: "high"))
        XCTAssertEqual(TaskDetailLogic.runModelLine(unclaimed, smartSelection: true, modelLabel: modelName), "Opus 5.5 · high")
        // A shadow run not claimed yet says nothing of a model it may not run on.
        XCTAssertNil(TaskDetailLogic.runModelLine(try session(route: route(applied: false)), smartSelection: true, modelLabel: modelName))
        // No effort of its own is the model's default.
        let noEffort = try session(model: "claude-sonnet-5-5", route: nil)
        XCTAssertEqual(TaskDetailLogic.runModelLine(noEffort, smartSelection: true, modelLabel: modelName), "Sonnet 5.5 · default effort")
        XCTAssertNil(TaskDetailLogic.runModelLine(try session(route: nil), smartSelection: true, modelLabel: modelName))
    }

    func testTheTierTagThePickAndTheWhy() {
        XCTAssertEqual(TaskDetailLogic.routeTierTag(route()), "✦ M")
        XCTAssertEqual(TaskDetailLogic.routeTierTag(route(level: "L", escalated: true)), "✦ L ↑")
        XCTAssertEqual(TaskDetailLogic.routePick(route(), modelLabel: modelName), "Sonnet 5.5 · medium")
        // Where the engine has no tier table the pick is the engine.
        XCTAssertEqual(TaskDetailLogic.routePick(route(model: nil, effort: nil), modelLabel: modelName), "claude")
        XCTAssertEqual(TaskDetailCopy.why(TaskDetailLogic.routePick(route(model: "claude-opus-5-5", effort: "high"),
                                                                    modelLabel: modelName)),
                       "Why Opus 5.5 · high")
        XCTAssertEqual(TaskDetailCopy.wouldHavePicked("Sonnet 5.5 · medium", level: "M"),
                       "✦ Smart selection would have picked Sonnet 5.5 · medium (M)")
        let utc = TimeZone(identifier: "UTC")!
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(plain(TaskDetailLogic.routeWhyFooter(route(), timeZone: utc, locale: us)),
                       "Policy v1 · decided Oct 3, 1:12 AM")
        XCTAssertEqual(plain(TaskDetailLogic.routeWhyFooter(route(escalated: true), timeZone: utc, locale: us)),
                       "Policy v1 · decided Oct 3, 1:12 AM · a failure from a usage limit would not have moved the tier")
    }

    func testARunsModelIsNamedByThePickersTiersThenAnyRunnersCatalogue() throws {
        XCTAssertEqual(TaskDetailLogic.modelLabel("claude-opus-5-5", options: options, catalogs: [], configured: nil),
                       "Opus 5.5")
        XCTAssertEqual(TaskDetailLogic.modelLabel("some-new-model", options: options, catalogs: [], configured: nil),
                       "some-new-model")
        // A run outlives its assignee: with no tiers resolved, any runner's catalogue still names it,
        // the first that does winning — and before a configured provider's own list.
        let elsewhere = RunnerModelCatalog(codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6 Sol")])
        let own = RunnerModelCatalog(claude: [RunnerModelInfo(value: "claude-opus-5-5", label: "Opus 5.5")])
        XCTAssertEqual(TaskDetailLogic.modelLabel("gpt-5.6-sol", options: nil, catalogs: [own, elsewhere],
                                                  configured: nil), "GPT-5.6 Sol")
        let configured = try JSONDecoder().decode([ConfiguredProvider].self, from: Data("""
        [{"slug":"anthropic-key","label":"Anthropic","runtime":"claude",
          "models":[{"value":"claude-opus-5-5","label":"Claude Opus 5.5"}]}]
        """.utf8))
        XCTAssertEqual(TaskDetailLogic.modelLabel("claude-opus-5-5", options: nil, catalogs: [own],
                                                  configured: configured), "Opus 5.5")
        XCTAssertEqual(TaskDetailLogic.modelLabel("claude-opus-5-5", options: nil, catalogs: [],
                                                  configured: configured), "Claude Opus 5.5")
    }

    func testAMacMenuShowsALongSentenceAsTheLinesOfAParagraph() {
        let note = TaskDetailCopy.modelChangeAppliesToThisRun
        let lines = ComposerLogic.menuLines(note)
        XCTAssertEqual(lines, ["Changing the model here applies to this run only. To fix the",
                               "model for every run, set it on the task."])
        XCTAssertEqual(lines.joined(separator: " "), note, "every word, in order")
        XCTAssertTrue(lines.allSatisfy { $0.count <= 64 })
        XCTAssertEqual(ComposerLogic.menuLines("Tier M"), ["Tier M"])
        // An iOS menu item stops at three lines: the note is shown a sentence an item.
        XCTAssertEqual(ComposerLogic.sentences(note), ["Changing the model here applies to this run only.",
                                                       "To fix the model for every run, set it on the task."])
        XCTAssertEqual(ComposerLogic.sentences(note).joined(separator: " "), note)
        XCTAssertEqual(ComposerLogic.sentences("One sentence."), ["One sentence."])
        // A run with no space breaks where it fills the line; CJK characters count double.
        let cjk = String(repeating: "规", count: 40)
        XCTAssertEqual(ComposerLogic.menuLines(cjk).map(\.count), [32, 8])
        // Past four lines the fourth ends on an ellipsis: the whole of it is in the task's Why.
        let long = Array(repeating: "word", count: 80).joined(separator: " ")
        let capped = ComposerLogic.menuLines(long)
        XCTAssertEqual(capped.count, 4)
        XCTAssertTrue(capped[3].hasSuffix("…"))
    }

    // MARK: the Agent's switch

    func testTheAgentCarriesItsSwitchAndTheFormWritesItOnlyWhenMoved() throws {
        let on = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"orbit","modelRouting":true}"#.utf8))
        XCTAssertEqual(on.modelRouting, true)
        let older = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a1","name":"orbit"}"#.utf8))
        XCTAssertNil(older.modelRouting)
        XCTAssertEqual(try json(UpdateAgentRequest(modelRouting: true))["modelRouting"] as? Bool, true)
        XCTAssertEqual(try json(UpdateAgentRequest(modelRouting: false))["modelRouting"] as? Bool, false)
        XCTAssertNil(try json(UpdateAgentRequest(name: "orbit"))["modelRouting"], "nil omits the key")
    }

    // MARK: the composer

    func testTheChipIsMarkedOnlyWhileATaskRunIsOnItsPick() {
        let picked = route(model: "claude-opus-5-5", effort: "high")
        XCTAssertEqual(ComposerLogic.smartRoute(taskID: "T", route: picked, modelID: "claude-opus-5-5", smartSelection: true), picked)
        XCTAssertNil(ComposerLogic.smartRoute(taskID: "T", route: picked, modelID: "claude-sonnet-5-5", smartSelection: true),
                     "a model changed here is this run's own")
        XCTAssertNil(ComposerLogic.smartRoute(taskID: nil, route: picked, modelID: "claude-opus-5-5", smartSelection: true),
                     "a session opened by hand")
        XCTAssertNil(ComposerLogic.smartRoute(taskID: "T", route: route(model: "claude-opus-5-5", applied: false),
                                              modelID: "claude-opus-5-5", smartSelection: true), "a shadow-only run")
        XCTAssertNil(ComposerLogic.smartRoute(taskID: "T", route: route(level: nil, model: "claude-opus-5-5"),
                                              modelID: "claude-opus-5-5", smartSelection: true), "a decision that named no tier")
        XCTAssertNil(ComposerLogic.smartRoute(taskID: "T", route: nil, modelID: "claude-opus-5-5", smartSelection: true))
    }

    // MARK: the account's switch (preferences.modelRouting, off by default)

    /// Off, every run reads as it did before routing — no tier, no shadow line, no Why — and its
    /// model line is its own row alone (web parity: `route` in TaskDetailPanel.tsx is null).
    func testWithTheAccountSwitchOffNoRunShowsADecision() throws {
        XCTAssertNil(TaskDetailLogic.runRoute(detail.sessions![0], smartSelection: false))
        let shadow = try session(model: "claude-opus-5-5", effort: "ultra", route: route(applied: false))
        XCTAssertNil(TaskDetailLogic.runRoute(shadow, smartSelection: false), "no purple line, no Why")
        XCTAssertEqual(TaskDetailLogic.runModelLine(shadow, smartSelection: false, modelLabel: modelName),
                       "Opus 5.5 · ultra", "what it ran on is still said")
        let unclaimed = try session(route: route(model: "claude-opus-5-5", effort: "high"))
        XCTAssertNil(TaskDetailLogic.runModelLine(unclaimed, smartSelection: false, modelLabel: modelName),
                     "not the pick of a decision that is not drawn")
    }

    func testWithTheAccountSwitchOffTheChipIsNeverMarked() {
        let picked = route(model: "claude-opus-5-5", effort: "high")
        XCTAssertNil(ComposerLogic.smartRoute(taskID: "T", route: picked, modelID: "claude-opus-5-5",
                                              smartSelection: false))
    }
}
