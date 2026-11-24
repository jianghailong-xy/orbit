import XCTest
@testable import OrbitKit

/// An agent's documents_sync call as its sync's card (board docs/mocks/documents-sync-card), in the words of the web's
/// `DocumentsSyncCard.tsx`: which calls draw it, read off the receipt a runner really answers with, and each state's lines.
final class DocumentsSyncCardTests: XCTestCase {
    private func receipt(_ entity: String, ok: Bool = true) -> String {
        #"{"receiptVersion":1,"ok":\#(ok),"outcome":"\#(ok ? "written" : "refused")","operation":"documents_sync","id":"bgj_1","entity":\#(entity)}"#
    }

    private func call(_ result: String?, status: ToolStatus = .ok) -> ToolCard {
        ToolCard(id: "t1", name: DocumentsSyncCard.toolName,
                 input: .object(["localPath": .string("out"), "path": .string("/Reports/out")]),
                 result: result, status: status)
    }

    private func sync(_ status: String, done: Int = 412, total: Int? = 28701, same: Int = 4, deleted: Int = 0,
                      failed: [DocumentsSync.Failure] = [], failedCount: Int = 0, ended: String? = nil,
                      error: String? = nil) -> DocumentsSync {
        DocumentsSync(id: "s1", status: status, sourceName: "stage", destPath: "/书格", destEntryId: "d1",
                      filesSeen: 28705, filesTotal: total, filesDone: done, filesSame: same, filesDeleted: deleted,
                      bytesTotal: 2_600_000_000_000, bytesSent: 238_000_000_000, currentPath: "PDF/谢宣城诗集.pdf",
                      failed: failed, failedCount: failedCount, error: error,
                      startedAt: "2026-11-24T06:57:00Z", updatedAt: "2026-11-24T07:30:00Z", endedAt: ended)
    }

    func testReadsTheSyncFromTheReceiptARunnerAnswersWith() {
        XCTAssertEqual(DocumentsSyncCard.syncID(receipt(#"{"jobId":"bgj_1","status":"running","syncId":"35344yWPof4phuXdrUNez"}"#)),
                       "35344yWPof4phuXdrUNez")
        XCTAssertEqual(DocumentsSyncCard.syncID(#"{"jobId":"bgj_1","syncId":"s1"}"#), "s1")
        XCTAssertNil(DocumentsSyncCard.syncID(receipt(#"{"jobId":"bgj_1","status":"running"}"#)), "an older runner names no sync")
        XCTAssertNil(DocumentsSyncCard.syncID(receipt(#"{"syncId":"s1"}"#, ok: false)), "a refused receipt names nothing")
        XCTAssertNil(DocumentsSyncCard.syncID("not json"))
        XCTAssertNil(DocumentsSyncCard.syncID(nil))
    }

    func testOnlyAnAnsweredCallNamingItsSyncDrawsTheCard() {
        XCTAssertTrue(DocumentsSyncCard.drawsCard(call(receipt(#"{"syncId":"s1"}"#))))
        XCTAssertFalse(DocumentsSyncCard.drawsCard(call(nil, status: .running)))
        XCTAssertFalse(DocumentsSyncCard.drawsCard(call(receipt(#"{"jobId":"bgj_1"}"#))))
        XCTAssertFalse(DocumentsSyncCard.drawsCard(call("refused", status: .error)))
        var other = call(receipt(#"{"syncId":"s1"}"#))
        other.name = "mcp__orbit__documents_put"
        XCTAssertFalse(DocumentsSyncCard.drawsCard(other))
    }

    func testRunningStates() {
        let checking = sync("CHECKING", total: nil)
        XCTAssertEqual(DocumentsSyncCard.title(checking), "Syncing to Documents")
        XCTAssertEqual(DocumentsSyncCard.stats(checking, rate: nil).lead, "Checking files…")
        XCTAssertEqual(DocumentsSyncCard.stats(checking, rate: nil).rest, " 28,705 so far")
        XCTAssertEqual(DocumentsSyncCard.icon(checking), .running)

        let uploading = sync("UPLOADING")
        let stats = DocumentsSyncCard.stats(uploading, rate: nil)
        XCTAssertEqual(stats.lead, "412 of 28,701 files")
        XCTAssertTrue(stats.rest.hasPrefix(" · "))
        XCTAssertEqual(DocumentsSyncCard.current(uploading), "↑ PDF/谢宣城诗集.pdf")
        XCTAssertEqual(DocumentsSyncCard.meta(uploading), ["4 already the same", "from stage/"])
        XCTAssertFalse(DocumentsSyncCard.folds(uploading))
    }

    func testACleanEndFoldsToOneLine() {
        let done = sync("DONE", done: 28701, ended: "2026-11-24T06:59:05Z")
        XCTAssertTrue(DocumentsSyncCard.folds(done))
        let line = DocumentsSyncCard.foldLine(done)
        XCTAssertEqual(line.lead, "Synced 28,701 files to")
        XCTAssertTrue(line.rest.contains(" in 2 min 5 s"), line.rest)
        XCTAssertTrue(line.rest.contains("4 already the same"), line.rest)
        XCTAssertNil(DocumentsSyncCard.current(done))

        let nothing = sync("DONE", done: 0, same: 28701, deleted: 3, ended: "2026-11-24T06:57:41Z")
        XCTAssertEqual(DocumentsSyncCard.foldLine(nothing).lead, "Already up to date:")
        XCTAssertTrue(DocumentsSyncCard.foldLine(nothing).rest.contains("3 moved to Trash"))
    }

    func testFailuresAStopAndAFailedSyncStayOpen() {
        let failed = [DocumentsSync.Failure(path: "PDF/a.pdf", error: "The file is larger than 5 GB.")]
        let partial = sync("DONE", done: 28694, failed: failed, failedCount: 2, ended: "2026-11-24T21:03:00Z")
        XCTAssertFalse(DocumentsSyncCard.folds(partial))
        XCTAssertEqual(DocumentsSyncCard.title(partial), "Synced 28,694 of 28,701 files")
        XCTAssertEqual(DocumentsSyncCard.stats(partial, rate: nil).lead, "2 failed")
        XCTAssertEqual(DocumentsSyncCard.icon(partial), .bad)
        XCTAssertEqual(DocumentsSyncCard.showAll(partial), "Show all 2")

        let stopped = sync("STOPPED", ended: "2026-11-24T07:40:00Z")
        XCTAssertEqual(DocumentsSyncCard.title(stopped), "Sync stopped")
        XCTAssertEqual(DocumentsSyncCard.icon(stopped), .stopped)
        XCTAssertTrue(DocumentsSyncCard.stats(stopped, rate: 5_000_000).rest.hasPrefix(" synced · "))
        XCTAssertNil(DocumentsSyncCard.stats(stopped, rate: 5_000_000).right, "a stopped sync has no pace")

        let broken = sync("FAILED", error: "/书格 is a file in Documents, not a folder.")
        XCTAssertEqual(DocumentsSyncCard.title(broken), "Sync failed")
        XCTAssertEqual(DocumentsSyncCard.icon(broken), .bad)
    }

    func testDurationReadsAsTheWebSays() {
        XCTAssertEqual(DocumentsSyncCard.duration(0.2), "1 s")
        XCTAssertEqual(DocumentsSyncCard.duration(41), "41 s")
        XCTAssertEqual(DocumentsSyncCard.duration(125), "2 min 5 s")
    }
}
