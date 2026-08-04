import XCTest
@testable import OrbitKit

/// Ports the web `StatusIcon` cases: the glyph at the leading edge of a session row. Colour (tone)
/// carries the meaning, so each state is asserted on shape + tone + label.
final class SessionStatusGlyphTests: XCTestCase {
    private func session(_ status: RunStatus, pendingApprovals: Int? = nil, runningBgCount: Int? = nil,
                         error: String? = nil, endReason: String? = nil,
                         runStatus: RunStatus? = nil,
                         sessionState: SessionState? = nil,
                         runState: SessionRunState? = nil,
                         lifecycleState: SessionLifecycleState? = nil) -> Session {
        Session(id: "s", title: "t", status: status, runStatus: runStatus,
                sessionState: sessionState,
                runState: runState, lifecycleState: lifecycleState,
                agentId: nil, assignedRunnerId: nil,
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

    /// A left-up dev server outlives the turn but isn't the agent working — it says so with a
    /// static, muted glyph rather than the working spinner, which would never stop.
    func testAwaitingInputWithBackgroundShowsMutedConsoleGlyph() {
        let g = SessionStatusGlyph.make(for: session(.awaitingInput, runningBgCount: 3))
        XCTAssertEqual(g, .init(shape: .symbol("terminal"), tone: .neutral,
                                label: "3 background processes running"))
    }

    func testSucceeded() {
        let g = SessionStatusGlyph.make(for: session(.succeeded))
        XCTAssertEqual(g, .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Succeeded"))
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

    /// The collapse: every deliberate end wears one neutral check, whatever ended it. Resume
    /// eligibility never consulted endReason, so a different glyph per reason claimed a
    /// difference the server did not have.
    func testEveryDeliberateEndSharesOneNeutralGlyph() {
        for reason in ["completed", "ended", "cancelled", "task_cancelled", "deleted",
                       // Retired PARKED-era reasons: no writer left, stored rows still decode.
                       "idle", "orphaned", "future_reason"] {
            let g = SessionStatusGlyph.make(for: session(.cancelled, endReason: reason))
            XCTAssertEqual(g, .init(shape: .symbol("checkmark.circle"), tone: .neutral,
                                    label: "Ended"), reason)
        }
        // A legacy row carrying no reason at all lands in the same place.
        XCTAssertEqual(SessionStatusGlyph.make(for: session(.cancelled)),
                       .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Ended"))
    }

    /// Neutral, not green: an ended run reported no verdict of its own, so it must never
    /// outrank a genuine SUCCEEDED sitting in the same list.
    func testEndedStaysNeutralWhileSucceededKeepsSuccessTone() {
        XCTAssertEqual(
            SessionStatusGlyph.make(for: session(.cancelled, endReason: "completed")).tone,
            .neutral)
        XCTAssertEqual(SessionStatusGlyph.make(for: session(.succeeded)).tone, .success)
    }

    /// A stopped turn is not a stopped session: bare INTERRUPTED keeps its own glyph.
    func testBareInterruptedKeepsItsOwnGlyph() {
        let g = SessionStatusGlyph.make(for: session(.interrupted))
        XCTAssertEqual(g, .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Interrupted"))
    }

    func testCompletedLifecycleDoesNotOverrideTheRunOutcome() {
        let s = session(.cancelled, endReason: "cancelled",
                        runState: .ended, lifecycleState: .completed)
        XCTAssertEqual(SessionStatusGlyph.make(for: s),
                       .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Ended"))
    }

    func testCompletedLifecycleStillSurfacesFailure() {
        let g = SessionStatusGlyph.make(for: session(.failed, error: "boom",
                                                     runState: .failed, lifecycleState: .completed))
        XCTAssertEqual(g.shape, .symbol("xmark.circle.fill"))
        XCTAssertEqual(g.tone, .error)
    }

    func testTrashLifecycleDoesNotOverrideSucceededRun() {
        let g = SessionStatusGlyph.make(for: session(.succeeded,
                                                     runState: .succeeded, lifecycleState: .trash))
        XCTAssertEqual(g, .init(shape: .symbol("checkmark.circle.fill"),
                                tone: .success, label: "Succeeded"))
    }

    func testExplicitRunStateOverridesContradictoryLegacyFields() {
        let cases: [(SessionRunState, SessionStatusGlyph)] = [
            (.queued, .init(shape: .symbol("clock"), tone: .neutral, label: "Queued")),
            (.running, .init(shape: .spinner, tone: .brand, label: "Running")),
            (.awaitingInput, .init(shape: .symbol("message"), tone: .neutral,
                                  label: "Waiting for your reply")),
            (.succeeded, .init(shape: .symbol("checkmark.circle.fill"), tone: .success,
                               label: "Succeeded")),
            (.failed, .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: "Failed")),
            (.interrupted, .init(shape: .symbol("minus.circle"), tone: .neutral,
                                 label: "Interrupted")),
            (.ended, .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Ended")),
        ]
        for (state, expected) in cases {
            let s = session(.cancelled, endReason: "cancelled",
                            sessionState: .completed, runState: state, lifecycleState: .trash)
            XCTAssertEqual(SessionStatusGlyph.make(for: s), expected, state.rawValue)
        }
    }

    func testServerLiveStatesRetainUsefulDetail() {
        let approval = session(.cancelled, pendingApprovals: 2, runState: .running)
        XCTAssertEqual(SessionStatusGlyph.make(for: approval),
                       .init(shape: .symbol("pause.circle"), tone: .warning,
                             label: "Waiting for approval"))

        let background = session(.cancelled, runningBgCount: 3, runState: .awaitingInput)
        XCTAssertEqual(SessionStatusGlyph.make(for: background),
                       .init(shape: .symbol("terminal"), tone: .neutral,
                             label: "3 background processes running"))

        let offline = session(.cancelled, error: "runner offline", runState: .failed)
        XCTAssertEqual(SessionStatusGlyph.make(for: offline),
                       .init(shape: .symbol("wifi.slash"), tone: .neutral,
                             label: "Disconnected — runner went offline"))
    }

    /// The raw CANCELLED must win over the legacy mixed COMPLETED: a filed session reads as the
    /// neutral "Ended", never as the green Succeeded the legacy field would imply.
    func testRawRunStatusWinsOverLegacyMixedCompletedState() {
        let s = session(.succeeded, endReason: "completed", runStatus: .cancelled,
                        sessionState: .completed)
        XCTAssertEqual(SessionStatusGlyph.make(for: s),
                       .init(shape: .symbol("checkmark.circle"), tone: .neutral,
                             label: "Ended"))
    }

    func testUnknownServerSessionStateDecodesAndUsesLegacyFallback() throws {
        let json = #"{"id":"s1","status":"SUCCEEDED","sessionState":"NEW_FUTURE_STATE"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.sessionState, .unknown)
        XCTAssertEqual(SessionStatusGlyph.make(for: s),
                       .init(shape: .symbol("checkmark.circle.fill"), tone: .success,
                             label: "Succeeded"))
    }

    /// A legacy lifecycle value normalizes while terminal execution fields remain independent.
    func testSessionDecodesLegacyLifecycleAndTerminalFields() throws {
        let json = #"{"id":"s1","status":"RUNNING","runStatus":"CANCELLED","sessionState":"ENDED","runState":"ENDED","filingState":"ARCHIVED","error":null,"endReason":"orphaned"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.runStatus, .cancelled)
        XCTAssertEqual(s.effectiveRunStatus, .cancelled)
        XCTAssertEqual(s.sessionState, .ended)
        XCTAssertEqual(s.runState, .ended)
        XCTAssertEqual(s.effectiveRunState, .ended)
        XCTAssertEqual(s.lifecycleState, .completed)
        XCTAssertEqual(s.effectiveLifecycleState, .completed)
        XCTAssertEqual(s.endReason, "orphaned")
        XCTAssertNil(s.error)
    }

    func testSessionStateIsOptionalForOlderServers() throws {
        let json = #"{"id":"s1","status":"CANCELLED"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertNil(s.sessionState)
        XCTAssertNil(s.runStatus)
        XCTAssertEqual(s.effectiveRunStatus, .cancelled)
    }
}
