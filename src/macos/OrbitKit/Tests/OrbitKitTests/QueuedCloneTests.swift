import Foundation
import XCTest
@testable import OrbitKit

/// A session held by its GitHub workspace's clone (queuedReason `WORKSPACE_CLONING`): the waiting card, the list row,
/// and the failed wait's sentence. The words are web `runnerSlots.ts`'s, read back as text.
final class QueuedCloneTests: XCTestCase {
    private func workspace(_ state: String?, repo: String? = "https://github.com/acme/widgets.git") throws -> SessionAgentRef {
        var fields: [String: Any] = ["id": "W1"]
        if let state { fields["cloneState"] = state }
        if let repo { fields["repoUrl"] = repo }
        return try JSONDecoder().decode(SessionAgentRef.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    func testTheCardNamesWhatIsWaitingAndWhatIsCloning() throws {
        let row = try QueuedCapacityTests.row("WORKSPACE_CLONING")
        let waiting = try XCTUnwrap(QueuedClone.card(session: row, workspace: workspace("PENDING"), heard: nil, storedAt: nil))
        XCTAssertEqual(waiting.title, "Waiting to clone acme/widgets")
        XCTAssertNil(waiting.progress)
        let cloning = try XCTUnwrap(QueuedClone.card(session: row, workspace: workspace("CLONING"), heard: nil, storedAt: nil))
        XCTAssertEqual(cloning.title, "Cloning acme/widgets")
    }

    func testThePercentageTheStreamRelayedRidesTheCard() throws {
        let row = try QueuedCapacityTests.row("WORKSPACE_CLONING")
        let heard = CloneHeard(state: .cloning, progress: 42, at: Date())
        let card = try XCTUnwrap(QueuedClone.card(session: row, workspace: workspace("CLONING"), heard: heard, storedAt: nil))
        XCTAssertEqual(card.progress, 42)
        // A detail read after the frame is ahead of it: the stored PENDING stands, with no percentage.
        let later = try XCTUnwrap(QueuedClone.card(session: row, workspace: workspace("PENDING"), heard: heard,
                                                   storedAt: Date().addingTimeInterval(5)))
        XCTAssertEqual(later.state, .pending)
        XCTAssertNil(later.progress)
    }

    func testNoCardWhereThePlainWordsStand() throws {
        let cloning = try QueuedCapacityTests.row("WORKSPACE_CLONING")
        XCTAssertNil(QueuedClone.card(session: cloning, workspace: try workspace("READY"), heard: nil, storedAt: nil))
        XCTAssertNil(QueuedClone.card(session: cloning, workspace: try workspace("FAILED"), heard: nil, storedAt: nil))
        XCTAssertNil(QueuedClone.card(session: cloning, workspace: try workspace("CLONING", repo: "https://example.com/a/b.git"),
                                      heard: nil, storedAt: nil))
        XCTAssertNil(QueuedClone.card(session: cloning, workspace: try workspace(nil), heard: nil, storedAt: nil))
        XCTAssertNil(QueuedClone.card(session: cloning, workspace: nil, heard: nil, storedAt: nil))
        let other = try QueuedCapacityTests.row("runner_at_capacity")
        XCTAssertNil(QueuedClone.card(session: other, workspace: try workspace("CLONING"), heard: nil, storedAt: nil))
    }

    func testTheSentenceSaysWhereAndWhen() {
        XCTAssertEqual(QueuedClone.sentence(machine: "HPC"), "On HPC. This session starts when the clone is done.")
        XCTAssertEqual(QueuedClone.sentence(machine: nil), "This session starts when the clone is done.")
    }

    func testTheRowReadsThePercentageOnceHeard() throws {
        let row = try QueuedCapacityTests.row("WORKSPACE_CLONING")
        XCTAssertEqual(SessionLine.make(for: row, live: true).text, "Waiting for the clone")
        XCTAssertEqual(SessionLine.make(for: row, live: true, cloneHeard: CloneHeard(state: .cloning)).text, "Waiting for the clone")
        let line = SessionLine.make(for: row, live: true, cloneHeard: CloneHeard(state: .cloning, progress: 42))
        XCTAssertEqual(line.text, "Cloning · 42%")
        XCTAssertEqual(line.tone, .queued)
        // A percentage of a clone that has not started again is not shown.
        XCTAssertEqual(SessionLine.make(for: row, live: true, cloneHeard: CloneHeard(state: .pending, progress: 42)).text,
                       "Waiting for the clone")
    }

    func testTheFailedWaitNoLongerPointsAtTheFirstLine() throws {
        XCTAssertEqual(QueuedClone.FAILED_WAIT, "This session starts once the repository is cloned.")
        XCTAssertFalse(QueuedClone.FAILED_WAIT.lowercased().contains("first line"))
        XCTAssertEqual(SessionLine.make(for: try QueuedCapacityTests.row("WORKSPACE_CLONE_FAILED"), live: true).text, "Clone failed")
    }

    func testTheWordsAreTheWebs() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var copy: String?
        for _ in 0..<12 {
            let file = dir.appendingPathComponent("src/web/src/lib/runnerSlots.ts")
            if FileManager.default.fileExists(atPath: file.path) { copy = try String(contentsOf: file, encoding: .utf8); break }
            dir = dir.deletingLastPathComponent()
        }
        let web = try XCTUnwrap(copy)
        XCTAssertTrue(web.contains("export const CLONE_WAIT_TITLE = '\(QueuedClone.WAIT_TITLE)';"))
        XCTAssertTrue(web.contains("export const CLONE_FAILED_TITLE = '\(QueuedClone.FAILED_TITLE)';"))
        XCTAssertTrue(web.contains("export const CLONE_FAILED_WAIT = '\(QueuedClone.FAILED_WAIT)';"))
        XCTAssertTrue(web.contains("export const CLONE_WAIT_STARTS = '\(QueuedClone.STARTS)';"))
        XCTAssertTrue(web.contains("return `Cloning · ${progress}%`;"))
    }
}
