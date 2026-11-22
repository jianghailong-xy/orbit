import Foundation
import XCTest
@testable import OrbitKit

/// Settings → Providers → Model routing on the Apple clients: the report's payload, the tier list and the report
/// joined into the web page's sections (`routingSections` in `src/web/src/lib/routingReport.ts`), the figures and the
/// flag a run outside its model's tier gets — and, in `testTheWordsAreTheWebs`, every word read back out of the web.
final class ModelRoutingPageTests: XCTestCase {

    private let providers = [
        ProviderTierRow(slug: "claude", label: "Claude", kind: "builtin", billing: "subscription", models: [
            ProviderModelTier(model: "claude-opus-5-5", levels: ["L", "XL"], source: "catalogue"),
            ProviderModelTier(model: "claude-sonnet-5-5", levels: ["S", "M"], source: "catalogue"),
            ProviderModelTier(model: "claude-haiku-5-5", levels: []),
        ]),
        ProviderTierRow(slug: "deepseek", label: "DeepSeek", providerId: "p1", models: [
            ProviderModelTier(model: "deepseek-flash", levels: [], editable: true, outputPricePerMTok: 0.4),
            ProviderModelTier(model: "deepseek-pro", levels: [], editable: true),
        ]),
    ]

    private func group(_ tier: String, _ provider: String?, _ model: String?, runs: Int, ended: Int = 0, done: Int = 0,
                       cost: Double = 0) -> SubagentReportGroup {
        SubagentReportGroup(tier: tier, provider: provider, providerLabel: provider, model: model, modelLabel: model,
                            runs: runs, ended: ended, done: done, costUsd: cost)
    }

    func testTheReportDecodesLenientlyAndIgnoresWorkflows() throws {
        let json = #"""
        {"subagents":[{"tier":"M","provider":"claude","providerLabel":"Claude","model":"claude-sonnet-5-5",
          "modelLabel":"Sonnet 5.5","runs":3,"workflowCalls":1,"ended":2,"done":1,"costUsd":0.25,"movedOn":0,"noSize":1},
          {"tier":"named","provider":null,"providerLabel":null,"model":null,"modelLabel":null,"runs":"x"}],
         "workflows":[{"name":"w","runs":1}]}
        """#
        let report = try JSONDecoder().decode(SubagentRoutingReport.self, from: Data(json.utf8))
        XCTAssertEqual(report.subagents.count, 2)
        XCTAssertEqual(report.subagents[0].modelLabel, "Sonnet 5.5")
        XCTAssertEqual(report.subagents[0].costUsd, 0.25)
        XCTAssertEqual(report.subagents[1].runs, 0, "a figure this build cannot read counts as 0")
        XCTAssertNil(report.subagents[1].provider)
    }

    func testThePeriodIsTheWebs() throws {
        XCTAssertEqual(ModelRoutingPeriod.allCases.map(\.label), ["Last 7 days", "Last 30 days", "All time"])
        XCTAssertEqual(ModelRoutingPeriod.default, .last30)
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-22T10:00:00Z"))
        XCTAssertEqual(ModelRoutingPeriod.last7.since(now: now), "2026-11-15T10:00:00.000Z")
        XCTAssertEqual(ModelRoutingPeriod.last30.since(now: now), "2026-10-23T10:00:00.000Z")
        XCTAssertNil(ModelRoutingPeriod.all.since(now: now))
        XCTAssertEqual(ModelRouting.nothingRan(.last30), "No SubAgents ran in the last 30 days.")
        XCTAssertEqual(ModelRouting.nothingRan(.all), "No SubAgents ran yet.")
    }

    /// Every tiered model, and every model routed at a tier, under Routed by tier — most runs first, then the tier
    /// list's order; named and unrouted runs in sections of their own; a model with no tier and no runs folded away.
    func testTheSectionsAreTheWebs() {
        let sections = ModelRouting.sections(providers, [
            group("L", "claude", "claude-opus-5-5", runs: 2, ended: 2, done: 1, cost: 1.5),
            group("XL", "claude", "claude-opus-5-5", runs: 1, ended: 1, done: 1, cost: 0.5),
            group("S", "claude", "claude-opus-5-5", runs: 1),
            group("M", "deepseek", "deepseek-flash", runs: 2, ended: 2, done: 2, cost: 0.1),
            group("named", "claude", "claude-haiku-5-5", runs: 4),
            group("not-routed", "claude", "claude-sonnet-5-5", runs: 1),
            group("M", "gone", "removed-model", runs: 1),
        ])
        XCTAssertEqual(sections.tiered.map(\.modelLabel),
                       ["claude-opus-5-5", "deepseek-flash", "removed-model", "claude-sonnet-5-5"])
        XCTAssertEqual(sections.named.map(\.modelLabel), ["claude-haiku-5-5"])
        XCTAssertEqual(sections.notRouted.map(\.modelLabel), ["claude-sonnet-5-5"])
        XCTAssertEqual(sections.idle.map(\.modelLabel), ["deepseek-pro"], "haiku ran by name, so it is not idle")

        let opus = sections.tiered[0]
        XCTAssertEqual(opus.figures.runs, 4)
        XCTAssertEqual(opus.tiers.map(\.tier), ["S", "L", "XL"], "S to XL")
        XCTAssertEqual(opus.tiers.map(\.outside), [true, false, false])
        XCTAssertEqual(opus.outsideRuns, 1)
        XCTAssertEqual(ModelRouting.ranAtText(opus), "S 1 · L 2 · XL 1")
        XCTAssertEqual(ModelRouting.flag(opus), "1 run at S, outside L · XL")
        XCTAssertEqual(ModelRouting.doneText(opus.figures), "67%")
        XCTAssertEqual(ModelRouting.rowCostText(opus.figures), "$2.00")

        let flash = sections.tiered[1]
        XCTAssertEqual(ModelRouting.flag(flash), "No tier set, but routed 2 times")
        XCTAssertEqual(flash.providerLabel, "DeepSeek", "the tier list's name for the provider")

        let removed = sections.tiered[2]
        XCTAssertNil(removed.model)
        XCTAssertEqual(removed.outsideRuns, 0, "a model the list no longer has is not outside its tier")
        XCTAssertNil(ModelRouting.flag(removed))

        let sonnet = sections.tiered[3]
        XCTAssertEqual(ModelRouting.ranAtText(sonnet), "No runs")
        XCTAssertEqual(ModelRouting.doneText(sonnet.figures), "—")
        XCTAssertEqual(ModelRouting.rowCostText(sonnet.figures), "—")
        XCTAssertEqual(ModelRouting.noTierNoRuns(sections.idle.count, open: false), "▸ No tier, no runs · 1 model")
        XCTAssertEqual(ModelRouting.noTierNoRuns(3, open: true), "▾ No tier, no runs · 3 models")
    }

    func testNothingListedAndNothingRanIsEmpty() {
        XCTAssertTrue(ModelRouting.sections([], []).isEmpty)
    }

    func testTheRowValueSaysHowRoutingRunsNow() throws {
        func prefs(_ json: String) throws -> UserPreferences {
            try JSONDecoder().decode(UserPreferences.self, from: Data(json.utf8))
        }
        XCTAssertEqual(ModelRouting.rowValue(nil), "Balance")
        XCTAssertEqual(ModelRouting.rowValue(try prefs("{}")), "Balance")
        XCTAssertEqual(ModelRouting.rowValue(try prefs(#"{"optimizeFor":"cost"}"#)), "Cost")
        XCTAssertEqual(ModelRouting.rowValue(try prefs(#"{"modelRouting":false,"optimizeFor":"cost"}"#)), "Off")
    }

    func testFigures() {
        XCTAssertEqual(ModelRouting.percent(1, 2), 50)
        XCTAssertEqual(ModelRouting.percent(1, 8), 13, "half up, as Math.round")
        XCTAssertNil(ModelRouting.percent(1, 0))
        XCTAssertEqual(ModelRouting.costText(0), "$0.00")
        XCTAssertEqual(ModelRouting.plural(1, "run"), "1 run")
        XCTAssertEqual(ModelRouting.plural(2, "run"), "2 runs")
    }

    // MARK: the web's words

    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file; if the web half moved, move this check with it")
        throw CocoaError(.fileNoSuchFile)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testTheWordsAreTheWebs() throws {
        let pagePath = "src/web/src/pages/settings/ModelRoutingPage.tsx"
        let page = try web(pagePath)
        assertSays(page, "title=\"\(ModelRouting.title)\" description=\"\(ModelRouting.description)\"", in: pagePath)
        assertSays(page, "<SettingsSection title=\"\(ModelRouting.routingHeader)\">", in: pagePath)
        assertSays(page, "title=\"\(ModelRouting.modelsHeader)\"", in: pagePath)
        assertSays(page, "aria-label=\"\(ModelRouting.period)\"", in: pagePath)
        assertSays(page, "<SectionRow title=\"\(ModelRouting.routedByTier)\" />", in: pagePath)
        assertSays(page, "<SectionRow title=\"\(ModelRouting.calledByName)\" note=\"\(ModelRouting.calledByNameNote)\" />", in: pagePath)
        assertSays(page, "<SectionRow title=\"\(ModelRouting.notRouted)\" />", in: pagePath)
        assertSays(page, "ranAt=\"\(ModelRouting.named)\"", in: pagePath)
        assertSays(page, "ranAt=\"\(ModelRouting.notRouted)\"", in: pagePath)
        assertSays(page, ">\(ModelRouting.noRuns)</span>", in: pagePath)
        assertSays(page, "<th>\(ModelRouting.ranAt)</th>", in: pagePath)
        for column in [ModelRouting.columnRuns, ModelRouting.columnDone, ModelRouting.columnCost] {
            assertSays(page, "<th className=\"is-num\">\(column)</th>", in: pagePath)
        }
        assertSays(page, "{showIdle ? '▾' : '▸'} No tier, no runs · {plural(sections.idle.length, 'model')}", in: pagePath)
        assertSays(page, "`No tier set, but routed ${plural(row.outsideRuns, 'time')}`", in: pagePath)
        assertSays(page, "`${plural(row.outsideRuns, 'run')} at ${outsideTiers.join(' · ')}, outside ${tierText(row.model?.levels ?? [])}`",
                   in: pagePath)
        assertSays(page, "No SubAgents ran {periodPhrase(period)}.", in: pagePath)
        assertSays(page, "Couldn’t load the report: {", in: pagePath)
        assertSays(page, ">\(ModelRouting.outsideItsTier)</span>", in: pagePath)
        assertSays(page, "{prefs.modelRouting !== false && (", in: pagePath)

        let logicPath = "src/web/src/lib/routingReport.ts"
        let logic = try web(logicPath)
        for period in ModelRoutingPeriod.allCases {
            assertSays(logic, "{ value: '\(period.rawValue)', label: '\(period.label)' }", in: logicPath)
        }
        assertSays(logic, "DEFAULT_REPORT_PERIOD: ReportPeriod = '\(ModelRoutingPeriod.default.rawValue)'", in: logicPath)
        assertSays(logic, "period === 'all' ? 'yet' : `in the last ${PERIOD_DAYS[period]} days`", in: logicPath)
        // The foot is several literals joined with `+`; joined back up, it is the native sentence byte for byte.
        let joined = logic.replacingOccurrences(of: "' + '", with: "").replacingOccurrences(of: "\" + '", with: "")
            .replacingOccurrences(of: "' + \"", with: "")
        assertSays(joined, "SUBAGENTS_FOOT = '\(ModelRouting.subagentsFoot)';", in: logicPath)
        assertSays(logic, "if (tier === 'named') return 'Named';", in: logicPath)
        assertSays(logic, "if (tier === 'not-routed') return 'Not routed';", in: logicPath)
        assertSays(logic, "modelLabel: first?.modelLabel ?? entry?.model.model ?? 'No model'", in: logicPath)

        let index = try web("src/web/src/pages/settings/settingsIndex.ts")
        assertSays(index, "label: '\(SettingsPage.modelRouting.title)'", in: "settingsIndex.ts")
        let menu = try web("src/web/src/components/TasksSidePanel.tsx")
        assertSays(menu, "=== false ? '\(ModelRouting.off)' : OPTIMIZE_LABELS[me.data?.preferences?.optimizeFor ?? 'balance']",
                   in: "TasksSidePanel.tsx")
    }
}
