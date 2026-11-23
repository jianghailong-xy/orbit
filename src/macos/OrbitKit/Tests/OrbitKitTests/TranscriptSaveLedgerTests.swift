import XCTest
@testable import OrbitKit

/// A live `translation` (seq 0) folded into a reply already in the window changes a durable row with
/// no new `maxSeq`. The registry skipped every write whose `maxSeq` had not moved, so on an idle
/// session that translation never reached disk and a relaunch drew the reply untranslated (web
/// parity: b1b4b3784e, `saveTranscript`'s `rewrite`). `ConsoleRegistry.persist` asks the ledger;
/// that wire is pinned in `TranscriptSaveLedgerWiringTests`.
final class TranscriptSaveLedgerTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TranscriptSaveLedgerTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func ev(_ seq: Int, _ type: RunEventType, _ payload: [String: JSONValue], turn: String? = "t1") -> RunEvent {
        RunEvent(seq: seq, type: type, turnId: turn, payload: .object(payload))
    }

    /// An idle session: the owner's message, the reply, the turn's end.
    private func idleSession() -> TranscriptReducer {
        var r = TranscriptReducer()
        r.apply(ev(1, .user, ["text": .string("Fix it")]))
        r.apply(ev(2, .assistant, ["text": .string("Found it.")]))
        r.apply(ev(3, .turnEnd, ["status": .string("AWAITING_INPUT")]))
        return r
    }

    private func reply(_ r: TranscriptReducer, seq: Int) -> AssistantBubble? {
        for item in r.state.items {
            if case .assistant(let b) = item, b.seq == seq { return b }
        }
        return nil
    }

    func testATranslationFoldedIntoTheLastDurableReplyIsPersistedWithNoNewMaxSeqAndIsThereAfterRestoring() throws {
        let store = FileTranscriptStore(directory: directory)
        var ledger = TranscriptSaveLedger()
        var live = idleSession()
        store.save(sessionID: "S1", reducer: live)
        ledger.restored("S1", live)
        XCTAssertFalse(ledger.claim("S1", live), "nothing the disk copy lacks yet")

        live.apply(ev(0, .translation, ["of": .int(2), "lang": .string("zh-Hans"), "text": .string("找到了。")], turn: nil))
        XCTAssertEqual(live.state.maxSeq, 3, "a live translation moves no seq")
        XCTAssertEqual(reply(live, seq: 2)?.translation?.text, "找到了。")

        XCTAssertTrue(ledger.claim("S1", live), "the reply it changed is written all the same")
        store.save(sessionID: "S1", reducer: live)
        XCTAssertFalse(ledger.claim("S1", live), "once: the next tick has nothing new")

        let restored = try XCTUnwrap(store.load(sessionID: "S1"))
        XCTAssertEqual(reply(restored, seq: 2)?.translation?.text, "找到了。",
                       "a relaunch draws the reply translated")
        XCTAssertEqual(restored.state.maxSeq, 3)
        var restoredLedger = TranscriptSaveLedger()
        restoredLedger.restored("S1", restored)
        XCTAssertFalse(restoredLedger.claim("S1", restored), "the restored copy is the disk copy")
    }

    func testANewDurableEventIsStillWritten() {
        var ledger = TranscriptSaveLedger()
        var live = idleSession()
        ledger.restored("S1", live)
        live.apply(ev(4, .user, ["text": .string("Thanks")], turn: "t2"))
        XCTAssertTrue(ledger.claim("S1", live))
        XCTAssertFalse(ledger.claim("S1", live))
    }

    func testAConsoleNeverWrittenIsWrittenOnceAndAForgottenOneAgain() {
        var ledger = TranscriptSaveLedger()
        let live = idleSession()
        XCTAssertTrue(ledger.claim("S1", live), "no disk copy at all")
        XCTAssertFalse(ledger.claim("S1", live))
        ledger.forget("S1")
        XCTAssertTrue(ledger.claim("S1", live))
        ledger.forgetAll()
        XCTAssertTrue(ledger.claim("S1", live))
    }
}
