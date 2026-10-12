import Foundation
import XCTest
@testable import OrbitKit

/// The Wiki home's status line says the web's words for every look of the maintenance run, counts what the
/// web counts, and puts its parts in the web's order (criterion 5, mocks 11 ② and 12 ④).
///
/// Four halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the cases in `src/shared/src/wiki-health.fixture.json`, which the web's `lib/wikiHealth.test.ts` and
///   `components/WikiMaintenanceStatus.test.tsx` read too: each health read's parts, its text, and the whole
///   line under the title;
/// - every `WikiHealthCopy` word looked up as a declaration in `src/web/src/lib/wikiHealth.ts`;
/// - the looks and the notification threshold held to `contracts/wiki.contract.json` `maintenance.health`;
/// - the line's order and links read out of the web page and the native header (`OrbitApp/.../Views`),
///   which nothing else compiles on Linux.
final class WikiHealthCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiHealth.ts"
    private static let status = "src/web/src/components/WikiMaintenanceStatus.tsx"
    private static let page = "src/web/src/pages/WikiPage.tsx"
    private static let fixturePath = "src/shared/src/wiki-health.fixture.json"
    private static let contractPath = "contracts/wiki.contract.json"
    private static let kit = "src/macos/OrbitKit/Sources/OrbitKit/"
    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The status line is one half of a pair; if the other "
                + "half moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    /// A web source with string concatenations joined and every run of whitespace as one space.
    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    /// A Swift source without its comment lines, whitespace kept.
    private func swift(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "\(what): lost \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the fixture

    private struct Fixture: Decodable {
        struct Space: Decodable {
            let id: String
            let slug: String
            let title: String
            let rootCommitSha: String
            let pendingOps: Int
        }
        struct Part: Decodable {
            let text: String
            let tone: String
            let mark: String
            let link: String
            let strong: Bool
        }
        struct Case: Decodable {
            let name: String
            let health: WikiSpaceHealth
            let parts: [Part]
            let text: String
            let line: String
        }
        let now: String
        let space: Space
        let entries: Int
        let cases: [Case]
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    private func now(_ shared: Fixture) throws -> Date {
        try XCTUnwrap(RelativeTime.parse(shared.now), "the fixture's now is an instant")
    }

    /// Each case's parts, text and whole line, as `WikiHealthLogic` and `WikiHomeContent` say them.
    func testEveryLookSaysTheFixturesWords() throws {
        let shared = try fixture()
        let now = try now(shared)
        XCTAssertFalse(shared.cases.isEmpty)
        let space = WikiSpace(id: shared.space.id, slug: shared.space.slug, title: shared.space.title,
                              rootCommitSha: shared.space.rootCommitSha, pendingOps: shared.space.pendingOps)
        for one in shared.cases {
            // The whole maintenance part: the look's parts, and — while the server runs the wiki — its reason (P9).
            let parts = WikiHealthLogic.parts(one.health, now: now)
            if !one.health.serverExecutes {
                XCTAssertEqual(parts, WikiHealthLogic.parts(one.health.maintenance, now: now), "\(one.name): runner says the look alone")
            }
            XCTAssertEqual(parts.map(\.text), one.parts.map(\.text), one.name)
            XCTAssertEqual(parts.map(\.tone.rawValue), one.parts.map(\.tone), "\(one.name): tones")
            XCTAssertEqual(parts.map(\.mark.rawValue), one.parts.map(\.mark), "\(one.name): marks")
            XCTAssertEqual(parts.map(\.link.rawValue), one.parts.map(\.link), "\(one.name): links")
            XCTAssertEqual(parts.map(\.strong), one.parts.map(\.strong), "\(one.name): weight")
            XCTAssertEqual(WikiHealthLogic.text(parts), one.text, one.name)
            // The whole line under the title: every active entry the read counts — not the entries the
            // home read, which stop at 200 — the anchors, then the maintenance part.
            let home = WikiHomeContent(space: space, spaces: [space], entries: [], timeline: [], health: one.health)
            XCTAssertEqual(home.statusLine(now: now), one.line, "\(one.name): the line under the title")
            XCTAssertEqual(one.health.entries, shared.entries)
        }
    }

    /// Every look the contract names is in the fixture, and none is left without words.
    func testTheFixtureCoversEveryLook() throws {
        let looks = Set(try fixture().cases.map(\.health.maintenance.look))
        XCTAssertEqual(looks, Set(WikiMaintenanceLook.contractOrder))
    }

    /// Without a health read the line says what it said before criterion 5, and a look this build does not
    /// know draws no maintenance part at all rather than a wrong one.
    func testNoHealthReadAndAnUnknownLookDrawNothingOfMaintenance() throws {
        let shared = try fixture()
        let now = try now(shared)
        let space = WikiSpace(id: shared.space.id, slug: shared.space.slug, rootCommitSha: shared.space.rootCommitSha)
        let bare = WikiHomeContent(space: space, spaces: [space], entries: [], timeline: [])
        XCTAssertEqual(bare.statusLine(now: now), "0 entries · Anchors verified at 1588c3b")
        let data = Data(#"{"spaceId":"s","entries":3,"maintenance":{"look":"paused","enabled":true}}"#.utf8)
        let later = try JSONDecoder().decode(WikiSpaceHealth.self, from: data)
        XCTAssertEqual(later.maintenance.look, .unknown)
        XCTAssertEqual(later.maintenance.backlog, 0, "a key a server one release apart left out reads as its default")
        XCTAssertEqual(WikiHealthLogic.parts(later.maintenance, now: now), [])
        let home = WikiHomeContent(space: space, spaces: [space], entries: [], timeline: [], health: later)
        XCTAssertEqual(home.statusLine(now: now), "3 entries · Anchors verified at 1588c3b")
    }

    /// The line's times, as the web's `wikiAgo` and `wikiLag` read them (`lib/wikiHealth.test.ts`).
    func testTheTimesReadAsTheWebReadsThem() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-09-28T12:00:00.000Z"))
        let at = { (minutes: Double) in ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutes * 60)) }
        XCTAssertEqual(WikiHealthLogic.ago(at(0.5), now: now), "just now")
        XCTAssertEqual(WikiHealthLogic.ago(at(4), now: now), "4m ago")
        XCTAssertEqual(WikiHealthLogic.ago(at(125), now: now), "2h ago")
        XCTAssertEqual(WikiHealthLogic.ago(at(25 * 60), now: now), "1d ago")
        XCTAssertEqual(WikiHealthLogic.ago(at(15 * 24 * 60), now: now), "2w ago")
        XCTAssertEqual(WikiHealthLogic.ago(at(-3), now: now), "just now")
        XCTAssertEqual(WikiHealthLogic.ago("", now: now), "just now")
        XCTAssertEqual(WikiHealthLogic.lag(40 * 60), "40m")
        XCTAssertEqual(WikiHealthLogic.lag(26 * 3600), "26h")
        XCTAssertEqual(WikiHealthLogic.lag(71 * 3600 + 59 * 60), "71h")
        XCTAssertEqual(WikiHealthLogic.lag(72 * 3600), "3d")
        XCTAssertEqual(WikiHealthLogic.lag(14 * 86_400), "14d")
    }

    // MARK: the web's declarations

    /// Every word the line says is the web's own declaration, looked up where `lib/wikiHealth.ts` makes it.
    func testEveryWordIsTheWebsDeclaration() throws {
        let lib = try web(Self.lib)
        let constants: [(String, String)] = [
            ("WIKI_MAINTENANCE_OFF", WikiHealthCopy.maintenanceOff),
            ("WIKI_MAINTENANCE_SET_UP", WikiHealthCopy.setUp),
            ("WIKI_MAINTENANCE_ON", WikiHealthCopy.maintenanceOn),
            ("WIKI_MAINTENANCE_BEHIND", WikiHealthCopy.maintenanceBehind),
            ("WIKI_DAILY_LIMIT_REACHED", WikiHealthCopy.dailyLimitReached),
            ("WIKI_REVIEW_QUEUE_FULL", WikiHealthCopy.reviewQueueFull),
        ]
        for (name, value) in constants {
            XCTAssertTrue(lib.contains("export const \(name) = '\(value)';"),
                          "\(name) drifted: \(Self.lib) no longer declares it as \(value.debugDescription)")
        }
        // The templates, each the web's arrow with its argument where Swift interpolates it.
        let templates: [(String, String, String)] = [
            ("wikiMaintained", "(ago: string): string => `Maintained ${ago}`", WikiHealthCopy.maintained("{}")),
            ("wikiMaintainingNow", "(ago: string): string => `Maintaining now · started ${ago}`", WikiHealthCopy.maintainingNow("{}")),
            ("wikiToCatchUp", "(count: number): string => `${wikiCount(count)} to catch up`", WikiHealthCopy.toCatchUp(1_234)),
            ("wikiBehindBy", "(count: number, lag: string): string => `${wikiCount(count)} to catch up, oldest ${lag}`",
             WikiHealthCopy.behindBy(1_234, lag: "{}")),
            ("wikiLastRun", "(ago: string): string => `last run ${ago}`", WikiHealthCopy.lastRun("{}")),
            ("wikiLastSuccess", "(ago: string): string => `last success ${ago}`", WikiHealthCopy.lastSuccess("{}")),
        ]
        for (name, arrow, said) in templates {
            XCTAssertTrue(lib.contains("export const \(name) = \(arrow);"), "\(name) drifted in \(Self.lib)")
            let body = arrow.components(separatedBy: "=> `").last!.dropLast()
            let expected = body
                .replacingOccurrences(of: "${ago}", with: "{}")
                .replacingOccurrences(of: "${lag}", with: "{}")
                .replacingOccurrences(of: "${wikiCount(count)}", with: "1,234")
            XCTAssertEqual(said, expected, "\(name) says what the web says")
        }
        XCTAssertTrue(lib.contains("count === 1 ? 'Maintenance failed' : `Maintenance failed ${count} times`"))
        XCTAssertEqual(WikiHealthCopy.failed(1), "Maintenance failed")
        XCTAssertEqual(WikiHealthCopy.failed(3), "Maintenance failed 3 times")
        // View run is the run page's own word, already the web's (`WIKI_VIEW_RUN`).
        XCTAssertTrue(lib.contains("import { WIKI_VIEW_RUN } from './wikiReviewMode';"))
        XCTAssertEqual(WikiModeCopy.viewRun, "View run")
    }

    // MARK: the contract

    private func contract() throws -> [String: Any] {
        let data = try Data(contentsOf: find(Self.contractPath))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The looks, their order, the fields the read carries and the threshold are the contract's.
    func testTheLooksAndTheThresholdAreTheContracts() throws {
        let maintenance = try XCTUnwrap(try contract()["maintenance"] as? [String: Any])
        let health = try XCTUnwrap(maintenance["health"] as? [String: Any], "contract has no maintenance.health")
        XCTAssertEqual(health["looks"] as? [String], WikiMaintenanceLook.contractOrder.map(\.rawValue))
        XCTAssertEqual(Set(WikiMaintenanceLook.allCases.map(\.rawValue)).subtracting(["unknown"]),
                       Set(WikiMaintenanceLook.contractOrder.map(\.rawValue)))
        let notify = try XCTUnwrap(health["notify"] as? [String: Any])
        XCTAssertEqual(notify["afterFailures"] as? Int, WikiHealthRules.notifyAfterFailures)
        XCTAssertEqual(health["route"] as? String, "GET /api/wiki/spaces/:id/health")
        let fields = try XCTUnwrap(health["maintenance"] as? [String: Any])
        XCTAssertEqual(Set(fields.keys), [
            "enabled", "look", "lastOkAt", "lastRunAt", "consecutiveFailures", "backlog", "oldestPendingAt",
            "lagSeconds", "dailyLimitReached", "held", "running", "lastRun", "lastFailure",
        ])
        // Every field the contract names round-trips through the model.
        let full = WikiMaintenanceHealth(
            look: .failing, enabled: true, lastOkAt: "a", lastRunAt: "b", consecutiveFailures: 3, backlog: 57,
            oldestPendingAt: "c", lagSeconds: 9, dailyLimitReached: true,
            held: WikiMaintenanceHeld(reason: .reviewQueueFull, at: "d"),
            running: WikiMaintenanceHealth.Running(sessionId: "e", startedAt: "f"),
            lastRun: WikiMaintenanceHealth.LastRun(sessionId: "g", outcome: "failed", endedAt: "h"),
            lastFailure: WikiMaintenanceHealth.LastFailure(kind: "infra", reason: "i", at: "j", sessionId: "k"))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(full)) as? [String: Any])
        XCTAssertEqual(Set(encoded.keys), Set(fields.keys))
        XCTAssertEqual(try JSONDecoder().decode(WikiMaintenanceHealth.self, from: JSONEncoder().encode(full)), full)
    }

    // MARK: the pages

    /// The web's row and the native line put the same parts in the same order, and lead Set up and View run
    /// to the same places: the space's Wiki settings, and the session of the run that ended last — or, for a
    /// run the server's job made, which has no session, that run's call log on Activity.
    func testBothPagesDrawTheLineInOneOrderWithTheSameLinks() throws {
        let page = try web(Self.page)
        let row = try slice(page, from: "className=\"project-integration wk-status-row\"", to: "</div> </div> )}")
        assertOrder(row, ["WIKI_ENTRY_NOUN(count)", "wk-status-review", "wikiAnchorsVerified(",
                          "<WikiMaintenanceStatus health={health.data}"], "the web's status row")
        XCTAssertTrue(page.contains("const count = health.data?.entries ?? entries.data?.length ?? 0;"),
                      "the web counts what the health read counts")
        let status = try web(Self.status)
        XCTAssertTrue(status.contains("wikiStatusParts(health, now)"))
        XCTAssertTrue(status.contains("to={wikiSettingsPath(spaceSlug)}"), "Set up opens the space's Wiki settings")
        assertOrder(status, ["if (part.link === 'run' && lastRun?.jobId) {", "to={wikiActivityRunPath(spaceSlug, lastRun.jobId)}",
                             "if (part.link === 'run' && lastRun?.sessionId) {",
                             "to={`/sessions/${encodeURIComponent(lastRun.sessionId)}`}"],
                    "View run opens a server run's log, else the run's session")

        let logic = try swift(Self.kit + "App/WikiLogic.swift")
        let parts = try slice(logic, from: "public func statusParts(now: Date) -> [WikiStatusPart] {", to: "return parts")
        assertOrder(parts, ["let count = health?.entries ?? entries.count", "WikiCopy.entryNoun(count)",
                            "WikiCopy.anchorsVerified(", "WikiHealthLogic.parts(health, now: now)"],
                    "the native line's parts")

        // The line is Activity's now (design §12.3.2): the home says what the space holds instead.
        let activity = try swift(Self.app + "Views/WikiActivityView.swift")
        let line = try slice(activity, from: "private var statusLine: some View {", to: "private struct WikiActivityBannerRow: View {")
        XCTAssertTrue(line.contains("Text(wikiStatusText(content.statusParts(now: now)))"))
        assertOrder(line, ["case wikiStatusSettingsURL:", "actions.openSettings()", "case wikiStatusRunURL:",
                           "content.health?.maintenance.lastRun?.jobId", "actions.openJob(job)",
                           "content.health?.maintenance.lastRun?.sessionId", "actions.openSession(session)"],
                    "the native line's links")
        let view = try swift(Self.app + "Views/WikiView.swift")
        let text = try slice(view, from: "func wikiStatusText(_ parts: [WikiStatusPart]) -> AttributedString {",
                             to: "private func wikiStatusColour(")
        for piece in ["AttributedString(\" · \")", "AttributedString(\"●\\u{00A0}\")", "AttributedString(\"\\u{00A0}✓\")",
                      "words.link = wikiStatusSettingsURL", "words.link = wikiStatusRunURL"] {
            XCTAssertTrue(text.contains(piece), "the native line lost \(piece)")
        }
        let colours = try slice(view, from: "private func wikiStatusColour(", to: "}\n}")
        XCTAssertTrue(colours.contains("case .warn: return Color.orange"), "amber while a run waits")
        XCTAssertTrue(colours.contains("case .error: return Color.red"), "red when it broke")

        XCTAssertTrue(activity.contains("openSession: { id in model.openFromConversation(.session(PublicID.toPublic(id)), overConsole: false) }"))
        XCTAssertTrue(activity.contains("openJob: { id in model.push(.wikiJob(jobID: id)) }"), "a server run opens its own page")
        let model = try swift(Self.app + "WikiModel.swift")
        XCTAssertTrue(model.contains("let healthRead = Task { try await api.wikiHealth(spaceID: space.id) }"))
        XCTAssertTrue(model.contains("health: health)"), "Activity is drawn with the health it read")
    }
}
