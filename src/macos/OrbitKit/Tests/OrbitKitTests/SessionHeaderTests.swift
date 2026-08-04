import XCTest
@testable import OrbitKit

/// Ports the web Agent-console header (`AgentView.tsx`): the session title over a
/// "`statusLabel` · `fmtTime`" subtitle. `statusWord` must agree with web's `statusLabel`.
final class SessionHeaderTests: XCTestCase {
    private func session(_ status: RunStatus, title: String? = "t",
                         runStatus: RunStatus? = nil,
                         sessionState: SessionState? = nil,
                         runState: SessionRunState? = nil,
                         lifecycleState: SessionLifecycleState? = nil,
                         pendingApprovals: Int? = nil, runningBgCount: Int? = nil,
                         error: String? = nil, endReason: String? = nil,
                         createdAt: String? = nil, lastTurnAt: String? = nil) -> Session {
        Session(id: "s", title: title, status: status, runStatus: runStatus,
                sessionState: sessionState,
                runState: runState, lifecycleState: lifecycleState,
                agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                runningBgCount: runningBgCount, error: error, endReason: endReason,
                createdAt: createdAt, lastTurnAt: lastTurnAt)
    }

    // MARK: statusWord — the terse state word (web `statusLabel`)

    func testStatusWordRunning() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.running)), "Running")
    }

    func testStatusWordWaitingForApproval() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.running, pendingApprovals: 1)),
                       "Waiting for approval")
    }

    func testStatusWordAwaitingInput() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.awaitingInput)), "Waiting for your reply")
    }

    func testStatusWordAwaitingInputWithBackground() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.awaitingInput, runningBgCount: 2)),
                       "2 background processes running")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.awaitingInput, runningBgCount: 1)),
                       "Background process running")
    }

    func testStatusWordSucceeded() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.succeeded)), "Succeeded")
    }

    func testStatusWordFailed() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.failed, error: "boom")), "Failed")
    }

    func testStatusWordFailedOfflineIsDisconnected() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.failed, error: "runner offline")),
                       "Disconnected")
    }

    /// Every ended run reads "Ended" — the accusatory "Cancelled" and the misleading "Dormant"
    /// both described the same resumable state.
    func testStatusWordEndedCoversEveryReason() {
        for reason in ["idle", "cancelled", "orphaned", "completed", "task_cancelled"] {
            XCTAssertEqual(SessionHeader.statusWord(for: session(.cancelled, endReason: reason)),
                           "Ended", reason)
        }
        XCTAssertEqual(SessionHeader.statusWord(for: session(.cancelled)), "Ended")
    }

    func testStatusWordBareInterruptedStaysInterrupted() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.interrupted)), "Interrupted")
    }

    func testStatusWordQueued() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.pending)), "Queued")
    }

    func testExplicitRunStateOverridesContradictoryLegacyFields() {
        let cases: [(SessionRunState, String)] = [
            (.queued, "Queued"),
            (.running, "Running"),
            (.awaitingInput, "Waiting for your reply"),
            (.succeeded, "Succeeded"),
            (.failed, "Failed"),
            (.interrupted, "Interrupted"),
            (.ended, "Ended"),
        ]
        for (state, expected) in cases {
            let s = session(.cancelled, sessionState: .completed, runState: state,
                            lifecycleState: .completed, endReason: "completed")
            XCTAssertEqual(SessionHeader.statusWord(for: s), expected, state.rawValue)
        }
    }

    func testServerLiveStatesRetainUsefulDetail() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(
            .cancelled, runState: .running, pendingApprovals: 1)), "Waiting for approval")
        XCTAssertEqual(SessionHeader.statusWord(for: session(
            .cancelled, runState: .awaitingInput, runningBgCount: 2)),
            "2 background processes running")
        XCTAssertEqual(SessionHeader.statusWord(for: session(
            .cancelled, runState: .failed, error: "runner offline")), "Disconnected")
    }

    /// The raw CANCELLED still wins over the legacy mixed COMPLETED — it reads as the neutral
    /// "Ended" rather than the "Succeeded" the legacy field would have implied.
    func testRawRunStatusWinsOverLegacyMixedCompletedState() {
        let s = session(.succeeded, runStatus: .cancelled, sessionState: .completed,
                        endReason: "completed")
        XCTAssertEqual(SessionHeader.statusWord(for: s), "Ended")
    }

    /// Filed and stopped are the same run outcome; only the lifecycle axis tells them apart.
    func testFiledAndStoppedShareTheEndedWord() {
        for reason in ["completed", "cancelled", "ended", "idle"] {
            let s = session(.cancelled, runState: .ended, lifecycleState: .completed,
                            endReason: reason)
            XCTAssertEqual(SessionHeader.statusWord(for: s), "Ended", reason)
        }
    }

    func testUnknownServerSessionStateUsesLegacyFallback() {
        let s = session(.succeeded, sessionState: .unknown)
        XCTAssertEqual(SessionHeader.statusWord(for: s), "Succeeded")
    }

    func testLifecycleStateDoesNotChangeHeaderRunState() {
        for lifecycle: SessionLifecycleState in [.open, .completed, .trash] {
            let s = session(.cancelled, runState: .succeeded, lifecycleState: lifecycle)
            XCTAssertEqual(SessionHeader.statusWord(for: s), "Succeeded", lifecycle.rawValue)
        }
    }

    // MARK: subtitle — "run state · lifecycle · when"

    /// 3.5 min elapsed → "3m ago" (RelativeTime floors), after run state and lifecycle location.
    func testSubtitleJoinsStateAndRelativeTime() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T10:03:30Z")!
        let s = session(.running, lastTurnAt: "2026-07-05T10:00:00Z")
        XCTAssertEqual(SessionHeader.subtitle(for: s, now: now), "Running · Open · 3m ago")
    }

    /// Web's `lastTurnAt ?? createdAt`: with no last turn, fall back to when it was created.
    func testSubtitleFallsBackToCreatedAt() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T12:00:00Z")!
        let s = session(.awaitingInput, createdAt: "2026-07-05T10:00:00Z")
        XCTAssertEqual(SessionHeader.subtitle(for: s, now: now),
                       "Waiting for your reply · Open · 2h ago")
    }

    /// No timestamps at all still keeps run state and lifecycle location separate.
    func testSubtitleWordOnlyWhenNoTimestamps() {
        XCTAssertEqual(SessionHeader.subtitle(for: session(.running)), "Running · Open")
    }

    func testSubtitleShowsCompletedIndependentlyFromSucceeded() {
        let s = session(.succeeded, runState: .succeeded, lifecycleState: .completed)
        XCTAssertEqual(SessionHeader.subtitle(for: s), "Succeeded · Completed")
    }

    /// A filed session now reads "Ended · Completed": the run outcome and where it lives are
    /// different facts, and the run axis no longer restates the filing act.
    func testSubtitleKeepsBothAxesForAFiledSession() {
        let s = session(.cancelled, runState: .ended, lifecycleState: .completed,
                        endReason: "completed")
        XCTAssertEqual(SessionHeader.subtitle(for: s), "Ended · Completed")
    }

    func testSubtitleNilWhenNoSession() {
        XCTAssertNil(SessionHeader.subtitle(for: nil))
    }

    // MARK: title — session name, else agent, else neutral

    func testTitlePrefersSessionTitle() {
        XCTAssertEqual(SessionHeader.title(for: session(.running, title: "Fix the header"),
                                           fallbackAgent: "claude"), "Fix the header")
    }

    func testTitleFallsBackToAgent() {
        XCTAssertEqual(SessionHeader.title(for: session(.running, title: nil), fallbackAgent: "claude"),
                       "claude")
        // An empty (not just nil) title also falls through.
        XCTAssertEqual(SessionHeader.title(for: session(.running, title: ""), fallbackAgent: "claude"),
                       "claude")
    }

    func testTitleNeutralDefault() {
        XCTAssertEqual(SessionHeader.title(for: nil, fallbackAgent: nil), "Session")
    }
}
