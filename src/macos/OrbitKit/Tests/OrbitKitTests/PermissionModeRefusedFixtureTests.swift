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

    /// A long session: the second turn's 240 replies pushed the refusal out of the tail the app loads (200 events). The
    /// detail still carries it (`permissionModeCorrectionRefusal`), so the control shows the lasting gap with the CLI's
    /// words, not "Default → Auto".
    func testRefusalPagedOutOfTheLoadedEventsStillReadsAsALastingGapFromTheDetail() throws {
        let detail = try JSONDecoder().decode(Session.self, from: data("session-refused-paged.ios.json"))
        let page = try JSONDecoder().decode(EventPage.self, from: data("session-refused-paged.events.json"))
        XCTAssertTrue(page.events.compactMap(PermissionModeRefusal.init(event:)).isEmpty, "the refusal's event is not loaded")
        XCTAssertTrue(page.hasMore)
        let changes = try XCTUnwrap(detail.permissionModeChanges)
        XCTAssertEqual(changes.map(\.cause), ["CLAIM", "ENGINE_REPORT"])
        XCTAssertEqual(detail.actualPermissionMode, "default")
        let carried = try XCTUnwrap(detail.permissionModeCorrectionRefusal, "the detail carries the refusal")
        XCTAssertEqual(carried.mode, "default")
        XCTAssertEqual(carried.requestedMode, "auto")
        XCTAssertEqual(carried.reason, words)

        let refusal = try XCTUnwrap(PermissionModeRefusal.standing(loaded: [], detail: carried, latest: changes.last,
                                                                   actual: detail.actualPermissionMode))
        let shown = SessionModeDisplay(intent: .auto, actual: detail.actualPermissionMode, beforeStart: false,
                                       latestChange: changes.last, refusal: refusal)
        XCTAssertEqual(shown.label, "Default", "the lasting gap, not \"Default → Auto\"")
        XCTAssertFalse(shown.isCorrecting)
        XCTAssertEqual(shown.reason, "Running in Default. You asked for Auto, but the runner couldn't switch Claude to it: \(words).")

        // Without the detail's word, the events loaded say nothing of it: the control would read as switching.
        let blind = SessionModeDisplay(intent: .auto, actual: detail.actualPermissionMode, beforeStart: false,
                                       latestChange: changes.last, refusal: nil)
        XCTAssertEqual(blind.label, "Default → Auto")
        XCTAssertTrue(blind.isCorrecting)

        // A later change supersedes it, here or on the server: a refusal of an older report does not stand.
        let later = SessionPermissionModeChange(fromMode: "default", toMode: "plan", cause: "OWNER_PICK", client: "ios",
                                                at: "2099-01-01T00:00:00.000Z", seq: 99)
        XCTAssertNil(PermissionModeRefusal.standing(loaded: [], detail: carried, latest: later, actual: "plan"))
    }

    func testLoadedRefusalEventIsTheGapsOwnSoItsLineIsAmber() throws {
        // Both loaded and carried: the event's refusal is the one that stands, so its transcript line is the gap's.
        let page = try JSONDecoder().decode(EventPage.self, from: data("session-refused.events.json"))
        let detail = try JSONDecoder().decode(Session.self, from: data("session-refused-paged.ios.json"))
        let loaded = page.events.compactMap(PermissionModeRefusal.init(event:))
        let carried = try XCTUnwrap(detail.permissionModeCorrectionRefusal)
        let latest = SessionPermissionModeChange(fromMode: "auto", toMode: "default", cause: "ENGINE_REPORT", client: nil,
                                                 at: try XCTUnwrap(loaded.last).at, seq: 2)
        let standing = PermissionModeRefusal.standing(loaded: loaded, detail: carried, latest: latest, actual: "default")
        XCTAssertEqual(standing, loaded.last)
        XCTAssertNotEqual(standing?.seq, PermissionModeRefusal.detailSeq)
    }

    func testClaimLineIsWordedFromTheServersRequestedModeAndReason() throws {
        let detail = try JSONDecoder().decode(Session.self, from: data("session-root-claim.ios.json"))
        let claim = try XCTUnwrap(detail.permissionModeChanges?.first)
        XCTAssertEqual(claim.requestedMode, "bypassPermissions")
        XCTAssertEqual(claim.reason, "ROOT_RUNNER")
        XCTAssertEqual(claim.line, "Started in Auto, not Bypass — Bypass can't run on a root runner")
    }
}
