import Foundation
import XCTest
@testable import OrbitKit

/// A refused Auto correction and a claim's substitution, as a real apiserver answered them to an iPhone
/// (contracts/permission-mode-refused, captured with a real runner on PostgreSQL; README there): the files web and
/// Android test against. The board is docs/mocks/permission-mode-actual (A1, B1).
final class PermissionModeRefusedFixtureTests: XCTestCase {
    private struct FixtureMissing: Error {}

    private func data(_ name: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/permission-mode-refused/\(name)")
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir.deleteLastPathComponent()
        }
        throw FixtureMissing()
    }

    private let words = "Cannot set permission mode to auto: auto mode unavailable for this model"

    func testRefusedCorrectionReadsAsALastingGapWithTheCLIWordsAndItsLineFollowsTheReport() throws {
        let detail = try JSONDecoder().decode(Session.self, from: data("session-refused.ios.json"))
        let page = try JSONDecoder().decode(EventPage.self, from: data("session-refused.events.json"))
        let changes = try XCTUnwrap(detail.permissionModeChanges)
        XCTAssertEqual(changes.map(\.cause), ["CLAIM", "ENGINE_REPORT"])
        let refusal = try XCTUnwrap(page.events.compactMap(PermissionModeRefusal.init(event:)).last)
        XCTAssertEqual(refusal.reason, words)

        let shown = SessionModeDisplay(intent: .auto, actual: detail.actualPermissionMode, beforeStart: false,
                                       latestChange: changes.last, refusal: refusal)
        XCTAssertEqual(shown.label, "Default")
        XCTAssertFalse(shown.isCorrecting, "a refused correction is not under way")
        XCTAssertEqual(shown.reason, "Running in Default. You asked for Auto, but the runner couldn't switch Claude to it: \(words).")
        XCTAssertEqual(refusal.line, "Claude stays in Default — the runner couldn't switch it to Auto: \(words)")

        // The server stamped Claude's report when it took the runner's batch, after the runner's stamp on the refusal:
        // placed at the refusal's moment, the report's line still comes right before it.
        XCTAssertGreaterThan(changes[1].at, refusal.at)
        XCTAssertEqual(refusal.answeredChange(in: changes), 1)
        var reducer = TranscriptReducer()
        reducer.applyTailPage(page)
        let cards = changes.enumerated().map { i, change in
            DeliveredDecisionCard(kind: .permissionModeChange(change), placement: .at(i == 1 ? refusal.at : change.at))
        } + [DeliveredDecisionCard(kind: .permissionModeRefusal(refusal), placement: .at(refusal.at))]
        let ids = TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false,
                                       showWorkingIndicator: false, decisionCards: cards).map(\.id)
        let report = try XCTUnwrap(ids.firstIndex(of: cards[1].id))
        let refused = try XCTUnwrap(ids.firstIndex(of: cards[2].id))
        XCTAssertEqual(refused, report + 1, "the refusal follows the report it answers: \(ids)")
    }

    func testClaimLineIsWordedFromTheServersRequestedModeAndReason() throws {
        let detail = try JSONDecoder().decode(Session.self, from: data("session-root-claim.ios.json"))
        let claim = try XCTUnwrap(detail.permissionModeChanges?.first)
        XCTAssertEqual(claim.requestedMode, "bypassPermissions")
        XCTAssertEqual(claim.reason, "ROOT_RUNNER")
        XCTAssertEqual(claim.line, "Started in Auto, not Bypass — Bypass can't run on a root runner")
    }
}
