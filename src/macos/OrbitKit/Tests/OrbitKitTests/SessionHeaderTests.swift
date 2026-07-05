import XCTest
@testable import OrbitKit

/// Ports the web Agent-console header (`AgentView.tsx`): the session title over a
/// "`statusLabel` · `fmtTime`" subtitle. `statusWord` must agree with web's `statusLabel`.
final class SessionHeaderTests: XCTestCase {
    private func session(_ status: RunStatus, title: String? = "t",
                         pendingApprovals: Int? = nil, runningBgCount: Int? = nil,
                         error: String? = nil, endReason: String? = nil,
                         createdAt: String? = nil, lastTurnAt: String? = nil) -> Session {
        Session(id: "s", title: title, status: status, agentId: nil, assignedRunnerId: nil,
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
        XCTAssertEqual(SessionHeader.statusWord(for: session(.succeeded)), "Completed")
    }

    func testStatusWordFailed() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.failed, error: "boom")), "Failed")
    }

    func testStatusWordFailedOfflineIsDisconnected() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.failed, error: "runner offline")),
                       "Disconnected")
    }

    func testStatusWordDormant() {
        // A dormant/resumable end (no hard reason) reads as "Dormant", not the accusatory "Cancelled".
        XCTAssertEqual(SessionHeader.statusWord(for: session(.parked)), "Dormant")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.cancelled)), "Dormant")
    }

    func testStatusWordTerminalCancel() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.cancelled, endReason: "cancelled")),
                       "Cancelled")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.cancelled, endReason: "orphaned")), "Ended")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.interrupted)), "Interrupted")
    }

    func testStatusWordQueued() {
        XCTAssertEqual(SessionHeader.statusWord(for: session(.pending)), "Queued")
    }

    // MARK: subtitle — "state · when"

    /// 3.5 min elapsed → "3m ago" (RelativeTime floors), joined to the state with " · ".
    func testSubtitleJoinsStateAndRelativeTime() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T10:03:30Z")!
        let s = session(.running, lastTurnAt: "2026-07-05T10:00:00Z")
        XCTAssertEqual(SessionHeader.subtitle(for: s, now: now), "Running · 3m ago")
    }

    /// Web's `lastTurnAt ?? createdAt`: with no last turn, fall back to when it was created.
    func testSubtitleFallsBackToCreatedAt() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T12:00:00Z")!
        let s = session(.awaitingInput, createdAt: "2026-07-05T10:00:00Z")
        XCTAssertEqual(SessionHeader.subtitle(for: s, now: now), "Waiting for your reply · 2h ago")
    }

    /// No timestamps at all → the state word alone (no dangling separator).
    func testSubtitleWordOnlyWhenNoTimestamps() {
        XCTAssertEqual(SessionHeader.subtitle(for: session(.running)), "Running")
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
