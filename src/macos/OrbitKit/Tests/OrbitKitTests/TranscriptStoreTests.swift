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

    /// The full chain the in-memory window cap depends on: trim → write the snapshot → rehydrate
    /// from it → page the trimmed history back in. A snapshot is the whole reducer, so a restored
    /// session has to carry not just the shortened window but the moved cursor AND the pruned dedup
    /// set — miss either and scrolling up on a reopened app shows a hole (or a duplicate) exactly
    /// where the trim was.
    func testTrimmedWindowSurvivesTheSnapshotAndStillPagesBack() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir)
        func replies(_ seqs: ClosedRange<Int>) -> [RunEvent] {
            seqs.map { RunEvent(seq: $0, type: .assistant, payload: .object(["text": .string("m\($0)")])) }
        }

        var live = TranscriptReducer()
        live.applyTailPage(EventPage(events: replies(1...60), hasMore: false))
        XCTAssertTrue(live.trimOlder(keeping: 20))            // seqs 1…40 dropped, cursor at 41
        let full = try JSONEncoder().encode(live)
        store.save(sessionID: "s1", reducer: live)

        // A snapshot of a trimmed window is smaller for the same reason the app wanted the cap —
        // it is the item array that dominates (docs/ios-perf-baseline.md §6).
        var untrimmed = TranscriptReducer()
        untrimmed.applyTailPage(EventPage(events: replies(1...60), hasMore: false))
        XCTAssertLessThan(full.count, (try JSONEncoder().encode(untrimmed)).count / 2)

        guard let restored0 = store.load(sessionID: "s1") else {
            return XCTFail("a trimmed snapshot must still decode")
        }
        var restored = restored0
        XCTAssertEqual(restored.state.items.count, 20)
        XCTAssertEqual(restored.state.oldestSeq, 41)
        XCTAssertTrue(restored.state.hasMoreOlder, "the trim boundary survives as pageable history")
        XCTAssertEqual(restored.state.maxSeq, 60, "and the resume cursor is untouched")

        // Scroll up on the restored session: the dropped page grafts back, once, in order.
        restored.prependOlder(EventPage(events: replies(21...40), hasMore: true))
        XCTAssertEqual(restored.state.items.map { $0.asAssistant?.text }, (21...60).map { "m\($0)" })
        XCTAssertEqual(restored.state.oldestSeq, 21)
        XCTAssertEqual(Set(restored.state.items.map(\.id)).count, 40, "no id collisions after rehydrate")

        // …and the live stream resumes on top of it exactly as before.
        restored.apply(RunEvent(seq: 61, type: .assistant, payload: .object(["text": .string("m61")])))
        XCTAssertEqual(restored.state.items.count, 41)
        XCTAssertEqual(restored.state.maxSeq, 61)
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

    /// The version gate: a snapshot from a previous schema decodes to nil — the session re-fetches
    /// its tail page — rather than rehydrating state with stale derived fields.
    func testFileStoreDiscardsPreviousSchemaVersion() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir)
        var r = TranscriptReducer()
        for ev in turnOne() { r.apply(ev) }
        store.save(sessionID: "sess-A", reducer: r)

        // Rewind the stored envelope to the previous schema version.
        let url = dir.appendingPathComponent("sess-A.json")
        let text = try String(contentsOf: url, encoding: .utf8)
        let downgraded = text.replacingOccurrences(of: #""version":4"#, with: #""version":3"#)
        XCTAssertNotEqual(downgraded, text, "expected a v4 envelope to rewrite")
        try downgraded.write(to: url, atomically: true, encoding: .utf8)

        XCTAssertNil(store.load(sessionID: "sess-A"))
    }

    /// The cap is enforced as new sessions arrive, dropping the least-recently-written snapshot.
    func testFileStorePrunesOldestBeyondCap() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir, maxFiles: 2)
        let r = TranscriptReducer()

        // Two snapshots, back-dated so "old" is unambiguously the least recent. The ids carry a
        // hyphen so `PublicID.storageKey` leaves them alone — a bare word like "old" is valid
        // base62, so it would land in a UUID-named file the back-dating below couldn't find.
        for (i, id) in ["sess-old", "sess-mid"].enumerated() {
            store.save(sessionID: id, reducer: r)
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: Double(1000 + i))],
                ofItemAtPath: dir.appendingPathComponent("\(id).json").path)
        }
        XCTAssertEqual(Set(store.storedSessionIDs()), ["sess-old", "sess-mid"],
                       "at the cap, nothing dropped yet")

        // A third session takes it past the cap — its own file is the newest, so "old" goes.
        store.save(sessionID: "sess-new", reducer: r)

        let remaining = Set(store.storedSessionIDs())
        XCTAssertFalse(remaining.contains("sess-old"), "oldest snapshot pruned beyond the cap")
        XCTAssertEqual(remaining, ["sess-mid", "sess-new"])
    }

    /// Re-saving an existing session skips the prune scan: it cannot grow the directory, and the
    /// focused console re-saves the same file every few seconds while a session streams — pruning
    /// there cost a stat per stored snapshot each time, on the main thread. Overwrites must therefore
    /// leave a directory that is AT the cap completely alone.
    func testFileStoreOverwriteDoesNotPrune() throws {
        let dir = tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileTranscriptStore(directory: dir, maxFiles: 1)
        var r = TranscriptReducer()

        store.save(sessionID: "sess-a", reducer: r)   // new file → prunes, but it's at the cap
        // Plant a snapshot directly on disk so the directory is now OVER the cap. Nothing but a prune
        // can remove it, which is what makes the assertion below meaningful: were prune still running
        // on every save, the overwrite would evict this (leaving only the just-written "sess-a").
        try Data("{}".utf8).write(to: dir.appendingPathComponent("planted.json"))

        for ev in turnOne() { r.apply(ev) }
        store.save(sessionID: "sess-a", reducer: r)   // an overwrite — the streaming checkpoint's shape

        XCTAssertEqual(Set(store.storedSessionIDs()), ["sess-a", "planted"], "an overwrite drops nothing")
        XCTAssertEqual(store.load(sessionID: "sess-a")?.state, r.state, "and still writes the new state")
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
