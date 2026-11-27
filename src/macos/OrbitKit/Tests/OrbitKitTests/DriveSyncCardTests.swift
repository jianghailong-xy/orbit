import XCTest
@testable import OrbitKit

/// An agent's drive_sync call as its sync's card (board docs/mocks/drive-sync-card), in the words of the web's
/// `DriveSyncCard.tsx`: which calls draw it, read off the receipt a runner really answers with, and each state's lines.
final class DriveSyncCardTests: XCTestCase {
    private func receipt(_ entity: String, ok: Bool = true) -> String {
        #"{"receiptVersion":1,"ok":\#(ok),"outcome":"\#(ok ? "written" : "refused")","operation":"drive_sync","id":"bgj_1","entity":\#(entity)}"#
    }

    private func call(_ result: String?, status: ToolStatus = .ok) -> ToolCard {
        ToolCard(id: "t1", name: DriveSyncCard.toolName,
                 input: .object(["localPath": .string("out"), "path": .string("/Reports/out")]),
                 result: result, status: status)
    }

    private func sync(_ status: String, done: Int = 412, total: Int? = 28701, same: Int = 4, deleted: Int = 0,
                      failed: [DriveSync.Failure] = [], failedCount: Int = 0, ended: String? = nil,
                      error: String? = nil) -> DriveSync {
        DriveSync(id: "s1", status: status, sourceName: "stage", destPath: "/书格", destEntryId: "d1",
                      filesSeen: 28705, filesTotal: total, filesDone: done, filesSame: same, filesDeleted: deleted,
                      bytesTotal: 2_600_000_000_000, bytesSent: 238_000_000_000, currentPath: "PDF/谢宣城诗集.pdf",
                      failed: failed, failedCount: failedCount, error: error,
                      startedAt: "2026-11-24T06:57:00Z", updatedAt: "2026-11-24T07:30:00Z", endedAt: ended)
    }

    func testReadsTheSyncFromTheReceiptARunnerAnswersWith() {
        XCTAssertEqual(DriveSyncCard.syncID(receipt(#"{"jobId":"bgj_1","status":"running","syncId":"35344yWPof4phuXdrUNez"}"#)),
                       "35344yWPof4phuXdrUNez")
        XCTAssertEqual(DriveSyncCard.syncID(#"{"jobId":"bgj_1","syncId":"s1"}"#), "s1")
        XCTAssertNil(DriveSyncCard.syncID(receipt(#"{"jobId":"bgj_1","status":"running"}"#)), "an older runner names no sync")
        XCTAssertNil(DriveSyncCard.syncID(receipt(#"{"syncId":"s1"}"#, ok: false)), "a refused receipt names nothing")
        XCTAssertNil(DriveSyncCard.syncID("not json"))
        XCTAssertNil(DriveSyncCard.syncID(nil))
    }

    func testOnlyAnAnsweredCallNamingItsSyncDrawsTheCard() {
        XCTAssertTrue(DriveSyncCard.drawsCard(call(receipt(#"{"syncId":"s1"}"#))))
        XCTAssertFalse(DriveSyncCard.drawsCard(call(nil, status: .running)))
        XCTAssertFalse(DriveSyncCard.drawsCard(call(receipt(#"{"jobId":"bgj_1"}"#))))
        XCTAssertFalse(DriveSyncCard.drawsCard(call("refused", status: .error)))
        var documents = call(receipt(#"{"syncId":"s1"}"#))
        documents.name = "mcp__orbit__documents_sync"
        XCTAssertTrue(DriveSyncCard.drawsCard(documents), "its name while Drive was called Documents")
        var other = call(receipt(#"{"syncId":"s1"}"#))
        other.name = "mcp__orbit__drive_put"
        XCTAssertFalse(DriveSyncCard.drawsCard(other))
    }

    func testRunningStates() {
        let checking = sync("CHECKING", total: nil)
        XCTAssertEqual(DriveSyncCard.title(checking), "Syncing to Drive")
        XCTAssertEqual(DriveSyncCard.stats(checking, rate: nil).lead, "Checking files…")
        XCTAssertEqual(DriveSyncCard.stats(checking, rate: nil).rest, " 28,705 so far")
        XCTAssertEqual(DriveSyncCard.icon(checking), .running)

        let uploading = sync("UPLOADING")
        let stats = DriveSyncCard.stats(uploading, rate: nil)
        XCTAssertEqual(stats.lead, "412 of 28,701 files")
        XCTAssertTrue(stats.rest.hasPrefix(" · "))
        XCTAssertEqual(DriveSyncCard.current(uploading), "↑ PDF/谢宣城诗集.pdf")
        XCTAssertEqual(DriveSyncCard.meta(uploading), ["4 already the same", "from stage/"])
        XCTAssertFalse(DriveSyncCard.folds(uploading))
    }

    func testACleanEndCanFoldToOneLine() {
        let done = sync("DONE", done: 28701, ended: "2026-11-24T06:59:05Z")
        XCTAssertTrue(DriveSyncCard.folds(done))
        let line = DriveSyncCard.foldLine(done)
        XCTAssertEqual(line.lead, "Synced 28,701 files to")
        XCTAssertTrue(line.rest.contains(" in 2 min 5 s"), line.rest)
        XCTAssertTrue(line.rest.contains("4 already the same"), line.rest)
        XCTAssertNil(DriveSyncCard.current(done))

        let nothing = sync("DONE", done: 0, same: 28701, deleted: 3, ended: "2026-11-24T06:57:41Z")
        XCTAssertEqual(DriveSyncCard.foldLine(nothing).lead, "Already up to date:")
        XCTAssertTrue(DriveSyncCard.foldLine(nothing).rest.contains("3 moved to Trash"))
        // The card is open by default, so it says the same as the line it folds to.
        XCTAssertEqual(DriveSyncCard.title(done), "Synced 28,701 files")
        XCTAssertEqual(DriveSyncCard.stats(done, rate: nil).right, "4 already the same")
        XCTAssertEqual(DriveSyncCard.title(nothing), "Already up to date")
        let checked = DriveSyncCard.stats(nothing, rate: nil)
        XCTAssertEqual(checked.lead, "28,701 files checked")
        XCTAssertTrue(checked.rest.contains("3 moved to Trash"), checked.rest)
        XCTAssertNil(checked.right)
    }

    func testFailuresAStopAndAFailedSyncStayOpen() {
        let failed = [DriveSync.Failure(path: "PDF/a.pdf", error: "The file is larger than 5 GB.")]
        let partial = sync("DONE", done: 28694, failed: failed, failedCount: 2, ended: "2026-11-24T21:03:00Z")
        XCTAssertFalse(DriveSyncCard.folds(partial))
        XCTAssertEqual(DriveSyncCard.title(partial), "Synced 28,694 of 28,701 files")
        XCTAssertEqual(DriveSyncCard.stats(partial, rate: nil).lead, "2 failed")
        XCTAssertEqual(DriveSyncCard.icon(partial), .bad)
        XCTAssertEqual(DriveSyncCard.showAll(partial), "Show all 2")

        let stopped = sync("STOPPED", ended: "2026-11-24T07:40:00Z")
        XCTAssertEqual(DriveSyncCard.title(stopped), "Sync stopped")
        XCTAssertEqual(DriveSyncCard.icon(stopped), .stopped)
        XCTAssertTrue(DriveSyncCard.stats(stopped, rate: 5_000_000).rest.hasPrefix(" synced · "))
        XCTAssertNil(DriveSyncCard.stats(stopped, rate: 5_000_000).right, "a stopped sync has no pace")

        let broken = sync("FAILED", error: "/书格 is a file in Documents, not a folder.")
        XCTAssertEqual(DriveSyncCard.title(broken), "Sync failed")
        XCTAssertEqual(DriveSyncCard.icon(broken), .bad)
    }

    func testDurationReadsAsTheWebSays() {
        XCTAssertEqual(DriveSyncCard.duration(0.2), "1 s")
        XCTAssertEqual(DriveSyncCard.duration(41), "41 s")
        XCTAssertEqual(DriveSyncCard.duration(125), "2 min 5 s")
    }
}
