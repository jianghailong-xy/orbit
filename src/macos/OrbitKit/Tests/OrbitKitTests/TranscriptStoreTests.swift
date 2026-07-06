import XCTest
@testable import OrbitKit

/// Persistence + resume tests for the local transcript store. The headline guarantee: a reducer
/// snapshot round-trips, and a *resumed* reducer (restored from disk, then fed the next turn)
/// behaves bit-for-bit identically to one that never stopped — so switching sessions can reuse a
/// cached/persisted reducer instead of replaying from seq 0.
final class TranscriptStoreTests: XCTestCase {

    // MARK: - reducer Codable / resume equivalence

    private func turnOne() -> [RunEvent] {
        [
            RunEvent(seq: 2, type: .user, payload: .object(["text": .string("List the files"),
                                                            "clientTurnId": .string("c1")])),
            RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("I'll list them.")])),
            RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string("I'll list them.")])),
            RunEvent(seq: 4, type: .toolUse, payload: .object(["toolUseId": .string("t1"),
                                                               "name": .string("Bash"),
                                                               "input": .object(["command": .string("ls")])])),
            RunEvent(seq: 5, type: .toolResult, payload: .object(["toolUseId": .string("t1"),
                                                                  "content": .string("a.txt")])),
            RunEvent(seq: 6, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])),
        ]
    }

    private func roundTrip(_ r: TranscriptReducer) throws -> TranscriptReducer {
        let data = try JSONEncoder().encode(r)
        return try JSONDecoder().decode(TranscriptReducer.self, from: data)
    }

    func testReducerSnapshotRoundTripsToEqualState() throws {
        var a = TranscriptReducer()
        for ev in turnOne() { a.apply(ev) }
        let b = try roundTrip(a)
        XCTAssertEqual(a.state, b.state, "decoded snapshot must reproduce the rendered state")
        XCTAssertEqual(b.state.maxSeq, 6, "reconnect cursor survives the round trip")
    }

    /// The core guarantee. Restore mid-session, then drive the next turn through BOTH reducers.
    /// They must stay identical — which only holds if `seen` (dedup), `idSeq` (synthetic ids) and
    /// the open-bubble cursors were all persisted, not just `state`.
    func testResumeContinuationIsBitExact() throws {
        var live = TranscriptReducer()
        for ev in turnOne() { live.apply(ev) }
        var restored = try roundTrip(live)

        let nextTurn: [RunEvent] = [
            // Duplicate of an already-seen durable event (an over-eager replay): must be deduped.
            RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string("I'll list them.")])),
            RunEvent(seq: 7, type: .user, payload: .object(["text": .string("now delete a.txt"),
                                                            "clientTurnId": .string("c2")])),
            RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Done.")])),
            RunEvent(seq: 8, type: .assistant, payload: .object(["text": .string("Done.")])),
            RunEvent(seq: 9, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])),
        ]
        for ev in nextTurn { live.apply(ev); restored.apply(ev) }

        XCTAssertEqual(live.state, restored.state,
                       "a resumed reducer must continue identically to one that never stopped")
        // Sanity: the duplicate seq-3 was dropped (no extra assistant bubble), ids are unique.
        XCTAssertEqual(restored.state.items.count, live.state.items.count)
        XCTAssertEqual(Set(restored.state.items.map(\.id)).count, restored.state.items.count,
                       "restored idSeq prevents synthetic-id collisions on new bubbles")
    }

    /// Restored mid-stream (an open, not-yet-finalized assistant bubble): the finalize event that
    /// arrives after resume must fold into the SAME bubble, not append a duplicate — i.e. the
    /// `openAssistant` cursor was restored.
    func testMidStreamOpenBubbleRestored() throws {
        var live = TranscriptReducer()
        live.apply(RunEvent(seq: 2, type: .user, payload: .object(["text": .string("hi")])))
        live.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("hel")])))
        var restored = try roundTrip(live)

        let finalize = RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string("hello")]))
        live.apply(finalize); restored.apply(finalize)

        XCTAssertEqual(live.state, restored.state)
        XCTAssertEqual(restored.state.items.count, 2, "user + one assistant (not a duplicate)")
        XCTAssertEqual(restored.state.items.last?.asAssistant?.displayText, "hello")
    }

    /// A pending queued send (held out of `items`) is part of the snapshot, so switching sessions /
    /// backgrounding doesn't lose the visible queue.
    func testQueuedSendSurvivesRoundTrip() throws {
        var a = TranscriptReducer()
        for ev in turnOne() { a.apply(ev) }
        a.addOptimisticUser(clientTurnId: "cq", text: "run this after", queued: true)
        let b = try roundTrip(a)
        XCTAssertEqual(a.state, b.state)
        XCTAssertEqual(b.state.queued.map(\.text), ["run this after"])
        XCTAssertEqual(b.state.queued.first?.pending, true)
    }

    /// Migration safety: a snapshot written before `queued` existed lacks the key entirely. It must
    /// default to empty rather than fail the whole decode (which would discard the cached session).
    func testStateDecodesSnapshotWithoutQueuedKey() throws {
        let json = #"{"items":[],"pendingApprovals":[],"background":[],"status":"AWAITING_INPUT","maxSeq":6}"#
        let s = try JSONDecoder().decode(TranscriptState.self, from: Data(json.utf8))
        XCTAssertEqual(s.queued, [])
        XCTAssertEqual(s.maxSeq, 6)
        XCTAssertEqual(s.status, .awaitingInput)
        // Same tolerance for the (newer) history-window cursor: paging is simply off.
        XCTAssertNil(s.oldestSeq)
        XCTAssertFalse(s.hasMoreOlder)
    }

    /// The scroll-up paging cursor is part of the snapshot — a restored session must know where
    /// its loaded window starts (and whether older pages remain) without re-fetching the tail.
    func testHistoryWindowSurvivesRoundTrip() throws {
        var a = TranscriptReducer()
        a.applyTailPage(EventPage(events: turnOne(), hasMore: true))
        let b = try roundTrip(a)
        XCTAssertEqual(a.state, b.state)
        XCTAssertEqual(b.state.oldestSeq, 2)
        XCTAssertTrue(b.state.hasMoreOlder)
    }

    // MARK: - FileTranscriptStore

    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("orbitkit-store-\(UUID().uuidString)")
    }

    func testFileStoreSaveLoadRoundTrip() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir)

        var r = TranscriptReducer()
        for ev in turnOne() { r.apply(ev) }
        store.save(sessionID: "sess-A", reducer: r)

        let loaded = store.load(sessionID: "sess-A")
        XCTAssertEqual(loaded?.state, r.state)
        XCTAssertEqual(store.storedSessionIDs(), ["sess-A"])

        store.remove(sessionID: "sess-A")
        XCTAssertNil(store.load(sessionID: "sess-A"))
        XCTAssertTrue(store.storedSessionIDs().isEmpty)
    }

    func testFileStoreMissingReturnsNil() {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir)
        XCTAssertNil(store.load(sessionID: "never-saved"))
    }

    /// The version gate: a snapshot from a previous schema (here v1, which predates the
    /// history-window cursor) decodes to nil — the session re-fetches its tail page — rather than
    /// rehydrating a window whose scroll-up paging would be permanently dead.
    func testFileStoreDiscardsPreviousSchemaVersion() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir)
        var r = TranscriptReducer()
        for ev in turnOne() { r.apply(ev) }
        store.save(sessionID: "sess-A", reducer: r)

        // Rewind the stored envelope to the previous schema version.
        let url = dir.appendingPathComponent("sess-A.json")
        let text = try String(contentsOf: url, encoding: .utf8)
        let downgraded = text.replacingOccurrences(of: #""version":2"#, with: #""version":1"#)
        XCTAssertNotEqual(downgraded, text, "expected a v2 envelope to rewrite")
        try downgraded.write(to: url, atomically: true, encoding: .utf8)

        XCTAssertNil(store.load(sessionID: "sess-A"))
    }

    func testFileStorePrunesOldestBeyondCap() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir, maxFiles: 2)
        let r = TranscriptReducer()

        // Save 3 sessions with strictly increasing modification times so order is deterministic.
        for (i, id) in ["old", "mid", "new"].enumerated() {
            store.save(sessionID: id, reducer: r)
            let url = dir.appendingPathComponent("\(id).json")
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(1000 + i))],
                                                  ofItemAtPath: url.path)
        }
        // A save re-runs prune; trigger it once more after the mtimes are set.
        store.save(sessionID: "new", reducer: r)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 2000)],
                                              ofItemAtPath: dir.appendingPathComponent("new.json").path)
        store.save(sessionID: "mid", reducer: r)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1500)],
                                              ofItemAtPath: dir.appendingPathComponent("mid.json").path)
        store.save(sessionID: "new", reducer: r) // re-prune with mid<new, old oldest → old evicted

        let remaining = Set(store.storedSessionIDs())
        XCTAssertFalse(remaining.contains("old"), "oldest snapshot pruned beyond the cap")
        XCTAssertTrue(remaining.contains("new"))
        XCTAssertLessThanOrEqual(remaining.count, 2)
    }

    // MARK: - LRUOrder

    func testLRUOrderEvictsLeastRecentlyUsed() {
        var lru = LRUOrder(capacity: 2)
        XCTAssertEqual(lru.use("a"), [])
        XCTAssertEqual(lru.use("b"), [])
        XCTAssertEqual(lru.use("a"), [], "re-using 'a' moves it to front, still within capacity")
        XCTAssertEqual(lru.use("c"), ["b"], "'b' is now least-recently-used → evicted")
        XCTAssertEqual(lru.keys, ["c", "a"])
    }

    func testLRUOrderRemove() {
        var lru = LRUOrder(capacity: 3)
        _ = lru.use("a"); _ = lru.use("b")
        lru.remove("a")
        XCTAssertEqual(lru.keys, ["b"])
    }
}
