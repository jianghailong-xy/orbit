import Foundation
import XCTest
@testable import OrbitKit

/// A session no runner has claimed yet opens on its first message, not on an empty pane.
///
/// `GET …/turns?view=active` lists the opening prompt as the accepted head, marked `opening`, under the
/// id its turn will have, until the runner's echo of it lands (apiserver session-create-attachments-alone.pg.spec.ts). The console draws it from
/// that row, and the echo takes over that row: the message is on screen once, before and after the
/// claim. Web parity: WorkspaceView.queuedOpening.test.tsx.
final class QueuedOpeningTurnTests: XCTestCase {

    private static let opening = "Fix: Codex update failed on orbit@austin. Read the install log and fix it."
    private static let openingTurn = "0195c0de-0000-7000-8000-0000000000a1"

    /// The opening as the active view lists it while no runner has claimed the session.
    private func listedOpening() throws -> [QueuedTurnInfo] {
        try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("""
            [{"turnId": "\(Self.openingTurn)", "kind": "message", "placement": "accepted",
              "content": "\(Self.opening)", "createdAt": "2026-11-14T09:30:00.000Z",
              "attachments": [], "opening": true}]
            """.utf8))
    }

    private func event(_ json: String) throws -> RunEvent {
        try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private func rows(_ reducer: TranscriptReducer) -> [TranscriptRow] {
        TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }

    /// Every row that says the opening message, and whether the queue draws it.
    private func openingRows(_ reducer: TranscriptReducer) -> [(bubble: UserBubble, queued: Bool)] {
        rows(reducer).compactMap { row in
            switch row {
            case .item(.user(let bubble)) where bubble.text == Self.opening: return (bubble, false)
            case .queued(let bubble) where bubble.text == Self.opening:      return (bubble, true)
            default:                                                         return nil
            }
        }
    }

    func testAnUnclaimedSessionDrawsItsFirstMessage() throws {
        var reducer = TranscriptReducer()
        XCTAssertTrue(openingRows(reducer).isEmpty)

        reducer.reconcileQueuedTurns(try listedOpening(), knownBefore: reducer.state.listedTurnIDs)

        XCTAssertEqual(try listedOpening().first?.opening, true, "the opening mark is not decoded")
        let drawn = openingRows(reducer)
        XCTAssertEqual(drawn.count, 1, "the first message is not on screen while the session is queued")
        XCTAssertFalse(drawn[0].queued, "drawn as a queued follow-up, with a Cancel the opening does not have")
        XCTAssertEqual(drawn[0].bubble.turnId, Self.openingTurn)
        XCTAssertTrue(drawn[0].bubble.pending)
    }

    func testOnceTheClaimedTurnsEventsArriveTheFirstMessageIsThereOnce() throws {
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(try listedOpening(), knownBefore: reducer.state.listedTurnIDs)
        let placeholder = try XCTUnwrap(openingRows(reducer).first?.bubble)

        // A runner claims it: the system init, the echo of the opening, the first reply.
        reducer.apply(try event(#"{"seq": 1, "type": "system", "turnId": "\#(Self.openingTurn)", "payload": {"subtype": "init"}}"#))
        reducer.apply(try event("""
            {"seq": 2, "type": "user", "turnId": "\(Self.openingTurn)", "ts": "2026-11-14T09:31:00.000Z",
             "payload": {"text": "\(Self.opening)"}}
            """))
        reducer.apply(try event(#"{"seq": 3, "type": "assistant", "turnId": "\#(Self.openingTurn)", "payload": {"text": "Reading the install log."}}"#))
        // The active view no longer lists it once its echo is stored.
        reducer.reconcileQueuedTurns([], knownBefore: reducer.state.listedTurnIDs)

        let drawn = openingRows(reducer)
        XCTAssertEqual(drawn.count, 1, "the first message is drawn twice once the runner echoes it")
        XCTAssertEqual(drawn[0].bubble.id, placeholder.id, "the echo did not take over the row that drew it")
        XCTAssertTrue(reducer.state.accepted.isEmpty)
    }

    /// The listing can also arrive after the echo: a stale snapshot must not draw it again.
    func testAListingThatArrivesAfterTheEchoDrawsNothingMore() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try event("""
            {"seq": 1, "type": "user", "turnId": "\(Self.openingTurn)", "payload": {"text": "\(Self.opening)"}}
            """))
        reducer.reconcileQueuedTurns(try listedOpening(), knownBefore: reducer.state.listedTurnIDs)
        XCTAssertEqual(openingRows(reducer).count, 1)
    }
}
