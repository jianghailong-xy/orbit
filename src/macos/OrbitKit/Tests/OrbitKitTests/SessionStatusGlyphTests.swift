import XCTest
@testable import OrbitKit

/// Ports the web `StatusIcon` cases: the glyph at the leading edge of a session row. Colour (tone)
/// carries the meaning, so each state is asserted on shape + tone + label.
final class SessionStatusGlyphTests: XCTestCase {
    private func session(_ status: RunStatus, pendingApprovals: Int? = nil, runningBgCount: Int? = nil,
                         error: String? = nil, endReason: String? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                runningBgCount: runningBgCount, error: error, endReason: endReason)
    }

    func testRunning() {
        let g = SessionStatusGlyph.make(for: session(.running))
        XCTAssertEqual(g, .init(shape: .spinner, tone: .brand, label: "Running"))
    }

    func testRunningWaitingForApproval() {
        let g = SessionStatusGlyph.make(for: session(.running, pendingApprovals: 2))
        XCTAssertEqual(g, .init(shape: .symbol("pause.circle"), tone: .warning, label: "Waiting for approval"))
    }

    func testAwaitingInputNeedsReply() {
        let g = SessionStatusGlyph.make(for: session(.awaitingInput))
        XCTAssertEqual(g, .init(shape: .symbol("message"), tone: .neutral, label: "Waiting for your reply"))
    }

    func testAwaitingInputWithBackgroundShowsSpinner() {
        let g = SessionStatusGlyph.make(for: session(.awaitingInput, runningBgCount: 3))
        XCTAssertEqual(g, .init(shape: .spinner, tone: .brand, label: "3 background processes running"))
    }

    func testSucceeded() {
        let g = SessionStatusGlyph.make(for: session(.succeeded))
        XCTAssertEqual(g, .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Completed"))
    }

    func testFailed() {
        let g = SessionStatusGlyph.make(for: session(.failed, error: "boom"))
        XCTAssertEqual(g, .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: "boom"))
    }

    func testFailedOfflineIsNeutralDisconnect() {
        let g = SessionStatusGlyph.make(for: session(.failed, error: "runner offline"))
        XCTAssertEqual(g.shape, .symbol("wifi.slash"))
        XCTAssertEqual(g.tone, .neutral)
    }

    func testPendingIsQueued() {
        let g = SessionStatusGlyph.make(for: session(.pending))
        XCTAssertEqual(g, .init(shape: .symbol("clock"), tone: .neutral, label: "Queued"))
    }

    func testParkedIsDormant() {
        let g = SessionStatusGlyph.make(for: session(.parked))
        XCTAssertEqual(g.shape, .symbol("pause.circle"))
        XCTAssertEqual(g.tone, .neutral)
        XCTAssertEqual(g.label, "Dormant — send a message to resume")
    }

    func testCancelledWithHardReasonIsTerminal() {
        let g = SessionStatusGlyph.make(for: session(.cancelled, endReason: "cancelled"))
        XCTAssertEqual(g, .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Cancelled"))
    }

    func testInterruptedWithoutReasonIsTerminal() {
        let g = SessionStatusGlyph.make(for: session(.interrupted))
        XCTAssertEqual(g, .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Interrupted"))
    }

    func testOrphanedReadsAsEnded() {
        let g = SessionStatusGlyph.make(for: session(.cancelled, endReason: "orphaned"))
        XCTAssertEqual(g.label, "Ended — task already finished")
    }

    /// A legacy CANCELLED with an unknown (nil) reason must not read as the accusatory "Cancelled".
    func testCancelledWithUnknownReasonIsDormant() {
        let g = SessionStatusGlyph.make(for: session(.cancelled))
        XCTAssertEqual(g.shape, .symbol("pause.circle"))
        XCTAssertEqual(g.label, "Dormant — send a message to resume")
    }

    func testCompletedTabOverridesToDone() {
        // A session filed into the Completed tab settles to CANCELLED but must read as done…
        let g = SessionStatusGlyph.make(for: session(.cancelled, endReason: "cancelled"), completed: true)
        XCTAssertEqual(g, .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Completed"))
    }

    func testCompletedTabStillSurfacesFailure() {
        // …but a genuine FAILED still surfaces in the Completed tab.
        let g = SessionStatusGlyph.make(for: session(.failed, error: "boom"), completed: true)
        XCTAssertEqual(g.shape, .symbol("xmark.circle.fill"))
        XCTAssertEqual(g.tone, .error)
    }

    /// The list payload's terminal-state fields decode (server keys: error / endReason).
    func testSessionDecodesTerminalFields() throws {
        let json = #"{"id":"s1","status":"CANCELLED","error":null,"endReason":"orphaned"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.endReason, "orphaned")
        XCTAssertNil(s.error)
    }
}
