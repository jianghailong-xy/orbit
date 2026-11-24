import XCTest
@testable import OrbitKit

/// The transfer card's words and rules (`DriveTransfer`), the reducer keeping a transfer's live byte count, and
/// the rows that put a run of transfers in one card. Event shapes are a real session's (11-24): DeepSeek-style call
/// ids, results that are receipts with the answer under `entity`, one test upload, then a burst.
final class DriveTransferTests: XCTestCase {
    private func put(_ seq: Int, _ id: String, _ path: String, at second: Int) -> RunEvent {
        RunEvent(seq: seq, type: .toolUse, ts: "2026-11-24T05:39:\(String(format: "%02d", second))Z", payload: .object([
            "toolUseId": .string(id), "name": .string("mcp__orbit__documents_put"),
            "input": .object(["path": .string(path), "localPath": .string("/u/\(id).jpg")]),
        ]))
    }

    private func receipt(_ seq: Int, _ id: String, size: Int, at second: Int) -> RunEvent {
        let text = #"{"receiptVersion":1,"ok":true,"outcome":"written","operation":"documents_put","entity":{"id":"E\#(id)","path":"/x","link":"orbit-document:E\#(id)","sizeBytes":\#(size)}}"#
        return RunEvent(seq: seq, type: .toolResult, ts: "2026-11-24T05:39:\(String(format: "%02d", second))Z",
                        payload: .object(["toolUseId": .string(id), "content": .string(text)]))
    }

    private func output(_ id: String, _ content: String, _ version: Int) -> RunEvent {
        RunEvent(seq: 0, type: .toolOutput, payload: .object([
            "toolUseId": .string(id), "content": .string(content), "snapshotSeq": .int(version),
        ]))
    }

    private func rows(_ r: TranscriptReducer) -> [TranscriptRow] {
        TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }

    // MARK: words

    func testReadsTheRunnersLineAndNothingElse() {
        XCTAssertEqual(DriveTransfer.progress("Uploaded 3355443 of 11954323 bytes")?.sent, 3_355_443)
        XCTAssertEqual(DriveTransfer.progress("Downloaded 5 of 5 bytes")?.size, 5)
        XCTAssertNil(DriveTransfer.progress("Uploaded 5 of 0 bytes"))
        XCTAssertNil(DriveTransfer.progress("npm test"))
        XCTAssertNil(DriveTransfer.progress(nil))
    }

    func testShowsPathsAsDriveDoes() {
        XCTAssertEqual(DriveTransfer.displayPath("~/Drive/书格/a.jpg"), "/书格/a.jpg")
        XCTAssertEqual(DriveTransfer.displayPath("/home/orbit/Drive/书格/a.jpg"), "/书格/a.jpg")
        XCTAssertEqual(DriveTransfer.displayPath("/run/orbit-drive/drive/书格/a.jpg"), "/书格/a.jpg")
        XCTAssertEqual(DriveTransfer.displayPath("/run/orbit-documents/drive/书格/a.jpg"), "/书格/a.jpg")
        XCTAssertEqual(DriveTransfer.displayPath("书格//a.jpg"), "/书格/a.jpg")
        XCTAssertEqual(DriveTransfer.commonFolder(["/S/d/单幅/a.jpg", "/S/d/老地图/b.jpg"]), "/S/d/")
        XCTAssertEqual(DriveTransfer.commonFolder(["/a.jpg", "/b/c.jpg"]), "/")
    }

    func testSpeedAndTimeLeftAsTheUploadTraySaysThem() {
        let t0 = Date(timeIntervalSince1970: 0)
        XCTAssertNil(DriveTransfer.rate([(t0, 0)]))
        XCTAssertEqual(DriveTransfer.rate([(t0, 0), (t0 + 5, 1_000_000), (t0 + 6, 6_000_000), (t0 + 8, 16_000_000)]),
                       5_000_000)
        XCTAssertEqual(DriveTransfer.duration(8), "8 s")
        XCTAssertEqual(DriveTransfer.duration(125), "2 min 5 s")
    }

    // MARK: the reducer and the rows

    func testARunOfUploadsIsOneCardWithLiveBytesThenAFinishedCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object(["text": .string("Uploading the files now.")])))
        r.apply(put(2, "call_00_a", "/书格/古图/十王图/01.jpg", at: 1))
        r.apply(put(3, "call_01_b", "/书格/古图/十王图/02.jpg", at: 1))
        r.apply(put(4, "call_02_c", "/书格/古图/单幅/03.jpg", at: 2))
        r.apply(receipt(5, "call_00_a", size: 2_400_000, at: 3))
        r.apply(output("call_01_b", "Uploaded 1200000 of 2400000 bytes", 7))
        // A line that is not a byte count, for a call that is no shell, changes nothing.
        r.apply(output("call_02_c", "something else", 8))

        let running = rows(r)
        guard let row = running.first(where: { if case .transfer = $0 { return true } else { return false } }),
              case .transfer(let kind, let cards) = row else { return XCTFail("no transfer row in \(running.map(\.id))") }
        XCTAssertEqual(kind, .put)
        XCTAssertEqual(cards.map(\.id), ["call_00_a", "call_01_b", "call_02_c"])
        XCTAssertEqual(row.id, "call_00_a", "a card takes its first call's bare id, as a group does")
        XCTAssertFalse(running.contains { if case .steps = $0 { return true } else { return false } },
                       "no transfer call folds into a steps line")

        let files = cards.map { DriveTransfer.file($0, live: true) }
        XCTAssertEqual(files.map(\.status), [.done, .running, .waiting])
        XCTAssertEqual(files[0].size, 2_400_000, "a receipt's size is read under entity")
        XCTAssertEqual(files[0].entryID, "Ecall_00_a")
        XCTAssertEqual(files[1].sent, 1_200_000)
        let summary = DriveTransfer.summarize(.put, files)
        XCTAssertEqual(summary.folder, "/书格/古图/")
        XCTAssertEqual(DriveTransfer.counting(summary), "Uploading 2 of 3")
        XCTAssertEqual(DriveTransfer.bytes(summary), "3.6 MB so far")
        XCTAssertEqual(DriveTransfer.title(summary), "Uploading to Drive")
        XCTAssertEqual(summary.fraction, 0.5, accuracy: 0.001)

        r.apply(receipt(6, "call_01_b", size: 2_400_000, at: 5))
        r.apply(receipt(7, "call_02_c", size: 3_000_000, at: 9))
        // A late byte count cannot pull a settled call back to a preview.
        r.apply(output("call_01_b", "Uploaded 1300000 of 2400000 bytes", 9))
        guard case .transfer(_, let done)? = rows(r).first(where: { if case .transfer = $0 { return true } else { return false } })
        else { return XCTFail("the finished run lost its card") }
        let finished = DriveTransfer.summarize(.put, done.map { DriveTransfer.file($0, live: true) })
        XCTAssertTrue(finished.clean)
        XCTAssertEqual(DriveTransfer.title(finished), "Uploaded 3 files")
        XCTAssertEqual(DriveTransfer.counting(finished), "3 uploaded")
        XCTAssertEqual(DriveTransfer.bytes(finished), "7.8 MB in 8 s")
        XCTAssertEqual(DriveTransfer.pace(finished, rate: nil, stalledFor: nil), "average 975 KB/s")
    }

    func testThinkingBetweenCallsStaysUnderTheCardAndASentenceStartsANewOne() {
        var r = TranscriptReducer()
        r.apply(put(1, "call_00_a", "/S/a.jpg", at: 1))
        r.apply(receipt(2, "call_00_a", size: 10, at: 2))
        r.apply(RunEvent(seq: 3, type: .thinking, payload: .object(["text": .string("Works."), "thinkingMs": .int(296)])))
        r.apply(put(4, "call_01_b", "/S/b.jpg", at: 3))
        r.apply(RunEvent(seq: 5, type: .assistant, payload: .object(["text": .string("First one landed.")])))
        r.apply(put(6, "call_02_c", "/S/c.jpg", at: 4))
        let kinds: [String] = rows(r).compactMap {
            switch $0 {
            case .transfer(_, let cards): return "transfer:" + cards.map(\.id).joined(separator: ",")
            case .steps: return "steps"
            case .item(let item): return item.id
            default: return nil
            }
        }
        XCTAssertEqual(kinds.filter { $0.hasPrefix("transfer") || $0 == "steps" },
                       ["transfer:call_00_a,call_01_b", "steps", "transfer:call_02_c"])
        XCTAssertEqual(TranscriptRecordAnchor.rowID(containing: "call_01_b", in: rows(r)), "call_00_a",
                       "a member is reached through its card's row")
    }

    func testAFailedReceiptAndACutOffCall() {
        let refused = ToolCard(id: "x", name: "mcp__orbit__documents_put",
                               input: .object(["path": .string("/S/x.jpg")]),
                               result: #"{"receiptVersion":1,"ok":false,"error":{"message":"Documents quota reached."}}"#,
                               status: .ok)
        XCTAssertEqual(DriveTransfer.file(refused, live: true).status, .failed)
        XCTAssertEqual(DriveTransfer.file(refused, live: true).error, "Documents quota reached.")

        let cut = ToolCard(id: "y", name: "mcp__orbit__drive_put", input: .object(["path": .string("/S/y.jpg")]),
                           result: "Uploaded 5 of 10 bytes", status: .running)
        XCTAssertEqual(DriveTransfer.file(cut, live: false).status, .stopped)
        XCTAssertEqual(DriveTransfer.kind("mcp__orbit__drive_get"), .get, "a stored call from before the rename")
    }

    func testTheBoundaryClearsATransfersLiveCount() {
        var r = TranscriptReducer()
        r.apply(put(1, "call_00_a", "/S/a.jpg", at: 1))
        r.apply(output("call_00_a", "Uploaded 5 of 10 bytes", 3))
        XCTAssertEqual(r.state.items.last?.asTool?.result, "Uploaded 5 of 10 bytes")
        XCTAssertTrue(r.clearLiveToolOutputsAtBoundary())
        XCTAssertNil(r.state.items.last?.asTool?.result)
    }
}
