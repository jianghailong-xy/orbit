import Foundation
import XCTest
@testable import OrbitKit

/// A parked session the server says something will resume (`activity` WAITING — a scheduled wake-up,
/// an armed auto-retry, a watch this client holds none of) reads "Waiting to resume" on its header,
/// glyph and row, never "Waiting for your reply" (web `resumeWords`, 2026-11-13).
final class SessionActivityTests: XCTestCase {
    private func parked(activity: String?, pendingApprovals: Int? = nil, runningSubagentCount: Int? = nil,
                        runState: SessionRunState = .awaitingInput) -> Session {
        Session(id: "S1", title: "Coordinator", status: .awaitingInput, runState: runState,
                agentId: nil, assignedRunnerId: nil, pendingApprovals: pendingApprovals, branch: nil,
                updatedAt: nil, runningSubagentCount: runningSubagentCount, activity: activity)
    }

    func testAWaitTheServerReportsIsNotAWaitForYourReply() {
        let s = parked(activity: "WAITING")
        XCTAssertTrue(s.resumesOnItsOwn)
        XCTAssertEqual(SessionHeader.statusWord(for: s), "Waiting to resume")
        XCTAssertEqual(SessionStatusGlyph.make(for: s),
                       SessionStatusGlyph(shape: .symbol("eye"), tone: .neutral, label: "Waiting to resume"))
        XCTAssertEqual(SessionLine.make(for: s, live: true),
                       SessionLine(text: "Waiting to resume", tone: .watching))
    }

    func testNothingIsInventedWhenTheServerSaysNothing() {
        for activity in [nil, "BACKGROUND_JOB", "SOMETHING_NEW"] as [String?] {
            let s = parked(activity: activity)
            XCTAssertFalse(s.resumesOnItsOwn, "\(String(describing: activity))")
            XCTAssertEqual(SessionHeader.statusWord(for: s), "Waiting for your reply")
        }
        // Only a parked session: a running one says so through its run state.
        XCTAssertFalse(parked(activity: "WAITING", runState: .running).resumesOnItsOwn)
    }

    func testAQuestionForYouAndASubAgentStillOutrankTheWait() {
        XCTAssertEqual(SessionHeader.statusWord(for: parked(activity: "WAITING", pendingApprovals: 1)),
                       "Waiting for approval")
        XCTAssertEqual(SessionHeader.statusWord(for: parked(activity: "WAITING", runningSubagentCount: 1)),
                       SessionLine.subagentRunningLabel(1))
    }

    func testTheFieldIsDecodedOffTheListRow() throws {
        let json = #"{"id":"S1","title":"t","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","activity":"WAITING"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.activity, "WAITING")
        XCTAssertTrue(s.resumesOnItsOwn)
    }
}
