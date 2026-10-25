import XCTest
@testable import OrbitKit

/// The words a phone's folded composer band shows: the draft or the placeholder, and each folded
/// card's line cut to its count. When the band folds is `TailPinningTests`'.
final class FoldedBandTests: XCTestCase {
    func testTheDraftIsItsFirstLineWithWordsOnIt() {
        XCTAssertNil(FoldedBand.draftLine(""))
        XCTAssertNil(FoldedBand.draftLine(" \n\t\n"))
        XCTAssertEqual(FoldedBand.draftLine("\n  \n  Ship it  \nthen tag"), "Ship it")
        XCTAssertEqual(FoldedBand.draftLine("可以，建好后直接启动"), "可以，建好后直接启动")
    }

    private func proc(_ id: String, _ status: String) -> BackgroundProc {
        BackgroundProc(id: id, command: "sleep 1", status: status, outputTail: "")
    }

    func testTheTraySaysWhatStillRunsOrHowManyThereAre() {
        XCTAssertEqual(FoldedBand.processes([proc("a", "running"), proc("b", "completed"), proc("c", "running")]),
                       "2 running")
        XCTAssertEqual(FoldedBand.processes((0..<10).map { proc("\($0)", "completed") }), "10")
    }

    private func card(running: Int = 0, failed: Int = 0, done: Int, total: Int) throws -> SessionTaskCard {
        let row = SessionCreatedTaskRow(id: "T1", title: "One", status: "OPEN", running: false, queued: false,
                                        createdAt: "2026-10-16T09:00:00Z", projectId: nil, replaces: nil)
        let created = SessionCreatedTasks(total: total, running: running, failed: failed, done: done,
                                          items: [row], projects: [])
        return try XCTUnwrap(SessionTaskCard(created: created, watched: []))
    }

    func testTheTasksCardSaysWhatFailedOrHowManyAreDone() throws {
        XCTAssertEqual(FoldedBand.tasks(try card(done: 3, total: 3)),
                       SessionCreatedTasksCopy.CountPart(text: "3/3", failed: false))
        XCTAssertEqual(FoldedBand.tasks(try card(running: 1, done: 1, total: 3)),
                       SessionCreatedTasksCopy.CountPart(text: "1/3", failed: false))
        XCTAssertEqual(FoldedBand.tasks(try card(failed: 1, done: 2, total: 3)),
                       SessionCreatedTasksCopy.CountPart(text: "1 failed", failed: true))
    }

    private func branch(_ status: String? = nil, merged: Bool? = nil, target: String? = nil,
                        targets: [String] = ["main"], diverged: Bool = false, recovering: Bool = false,
                        added: Int = 2321, deleted: Int = 66) -> FoldedBand.Branch? {
        FoldedBand.branch(mergeStatus: status, branchMerged: merged, mergeTarget: target, targets: targets,
                          diverged: diverged, recovering: recovering, added: added, deleted: deleted)
    }

    /// The merge slot's chips, word for word (`WorktreeMergeControl`).
    func testALandingIsSaidInTheMergeSlotsWords() {
        XCTAssertEqual(branch("merged"), .landed("✓ Merged"))
        XCTAssertEqual(branch("merged", target: "release"), .landed("✓ Merged → release"))
        XCTAssertEqual(branch(merged: true), .landed("✓ In main"))
        XCTAssertEqual(branch(merged: true, targets: ["master"]), .landed("✓ In master"))
        XCTAssertEqual(branch(merged: true, target: "develop"), .landed("✓ In develop"))
        XCTAssertEqual(branch("pending"), .merging)
    }

    func testAnythingElseIsTheSizeOfTheChange() {
        XCTAssertEqual(branch(), .changes(added: 2321, deleted: 66))
        XCTAssertEqual(branch("conflict"), .changes(added: 2321, deleted: 66))
        XCTAssertEqual(branch("error", merged: true), .changes(added: 2321, deleted: 66))
        XCTAssertNil(branch(added: 0, deleted: 0), "nothing to count")
    }

    /// The slot puts a branch Orbit is not tracking, and a merge held for recovery, before any chip.
    func testADivergedOrRecoveringBranchIsNoLanding() {
        XCTAssertEqual(branch("merged", diverged: true), .changes(added: 2321, deleted: 66))
        XCTAssertEqual(branch(merged: true, recovering: true), .changes(added: 2321, deleted: 66))
        XCTAssertEqual(branch("pending", diverged: true), .changes(added: 2321, deleted: 66))
    }
}
