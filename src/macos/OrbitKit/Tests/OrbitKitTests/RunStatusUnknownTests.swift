import XCTest
@testable import OrbitKit

/// Plan step 0.6 (docs/session-three-state-plan.md): one session row whose status is a word this
/// build does not know must not fail the whole list, and must never read as running.
final class RunStatusUnknownTests: XCTestCase {
    private let listJSON = #"""
    [{"id":"a","status":"RUNNING"},
     {"id":"new","status":"SOME_NEW_WORD","runStatus":"SOME_NEW_WORD"},
     {"id":"b","status":"AWAITING_INPUT"},
     {"id":"c","status":"SUCCEEDED"}]
    """#

    private func decodeList() throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(listJSON.utf8))
    }

    /// (1) The list decodes with every row, the unknown one included.
    func testSessionListWithAnUnknownStatusDecodesEveryRow() throws {
        let sessions = try decodeList()
        XCTAssertEqual(sessions.map(\.id), ["a", "new", "b", "c"])
        XCTAssertEqual(sessions[1].status, .unknown)
        XCTAssertEqual(sessions[1].runStatus, .unknown)
        XCTAssertEqual(sessions[0].effectiveRunStatus, .running)
        XCTAssertEqual(sessions[2].effectiveRunStatus, .awaitingInput)
        XCTAssertEqual(sessions[3].effectiveRunStatus, .succeeded)
    }

    /// (2) The unknown row is not live, claims no outcome, and is worded as ended, never running.
    func testUnknownStatusIsNotLiveAndNeverReadsAsRunning() throws {
        let row = try XCTUnwrap(decodeList().first { $0.id == "new" })
        let status = row.effectiveRunStatus
        XCTAssertEqual(status, .unknown)
        XCTAssertFalse(status.isLive)
        XCTAssertFalse(status.isTerminal)
        XCTAssertEqual(row.effectiveRunState, .ended)
        XCTAssertFalse(row.effectiveRunState.isLive)
        XCTAssertFalse(row.isGenerating)

        let word = SessionHeader.statusWord(for: row)
        XCTAssertNotEqual(word, "Running")
        let ended = Session(id: "e", title: nil, status: .cancelled, agentId: nil, assignedRunnerId: nil,
                            pendingApprovals: nil, branch: nil, updatedAt: nil)
        XCTAssertEqual(ended.effectiveRunState, .ended)
        XCTAssertEqual(word, SessionHeader.statusWord(for: ended))

        XCTAssertNotEqual(ComposerLogic.availability(status: status), .queue)
        XCTAssertFalse(WorktreeBarLogic.turnActive(status: status, runningSubagents: 2, sending: true))
    }

    /// An unknown `runStatus` beside a known legacy `status` defers to the legacy word.
    func testUnknownRunStatusDefersToTheKnownLegacyStatus() throws {
        let row = try JSONDecoder().decode(
            Session.self, from: Data(#"{"id":"x","status":"RUNNING","runStatus":"SOME_NEW_WORD"}"#.utf8))
        XCTAssertEqual(row.effectiveRunStatus, .running)
    }

    /// (3) The seven known words decode to exactly the cases they did before.
    func testTheSevenKnownStatusesDecodeUnchanged() throws {
        let expected: [String: RunStatus] = [
            "PENDING": .pending, "RUNNING": .running, "SUCCEEDED": .succeeded, "FAILED": .failed,
            "CANCELLED": .cancelled, "AWAITING_INPUT": .awaitingInput, "INTERRUPTED": .interrupted,
        ]
        for (raw, status) in expected {
            let decoded = try JSONDecoder().decode(RunStatus.self, from: Data("\"\(raw)\"".utf8))
            XCTAssertEqual(decoded, status, raw)
            XCTAssertEqual(decoded.rawValue, raw)
            let row = try JSONDecoder().decode(
                Session.self, from: Data(#"{"id":"s","status":"\#(raw)"}"#.utf8))
            XCTAssertEqual(row.status, status, raw)
        }
    }
}
