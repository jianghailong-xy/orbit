import Foundation
import XCTest
@testable import OrbitKit

/// A message sent into an existing session waits as a dimmed `Sending…` bubble until the server takes
/// it (docs/mocks/composer-sending-bubble, board 04-native-parity).
final class SendingBubbleTests: XCTestCase {
    private func user(_ seq: Int, turn: String, text: String, ts: String = "2026-11-27T10:00:00Z",
                      attachments: [String] = []) -> RunEvent {
        var payload: [String: JSONValue] = ["text": .string(text)]
        if !attachments.isEmpty {
            payload["attachments"] = .array(attachments.map {
                .object(["id": .string($0), "mime": .string("image/png"), "name": .string("shot.png")])
            })
        }
        return RunEvent(seq: seq, type: .user, ts: ts, turnId: turn, payload: .object(payload))
    }

    /// A session at rest after one finished turn.
    private func idle() -> TranscriptReducer {
        var r = TranscriptReducer()
        r.apply(user(1, turn: "t1", text: "first"))
        r.apply(RunEvent(seq: 2, type: .assistant, ts: "2026-11-27T10:00:05Z",
                         payload: .object(["text": .string("done")])))
        r.apply(RunEvent(seq: 3, type: .turnEnd, ts: "2026-11-27T10:00:06Z",
                         payload: .object(["subtype": .string("success")])))
        return r
    }

    private func bubbles(_ r: TranscriptReducer) -> [UserBubble] {
        r.state.items.compactMap { if case .user(let b) = $0 { return b }; return nil }
    }

    private func rows(_ r: TranscriptReducer, running: Bool = false) -> [TranscriptRow] {
        TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false,
                             showWorkingIndicator: false, running: running)
    }

    private func headIDs(_ r: TranscriptReducer, running: Bool) -> [String] {
        rows(r, running: running).compactMap { if case .turnHead(let line) = $0 { return line.bubbleID }; return nil }
    }

    func testAPendingBubbleReadsSendingAndIsDimmed() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let bubble = bubbles(r).last!
        XCTAssertTrue(bubble.isSending)
        XCTAssertTrue(r.state.tailIsSending)
        XCTAssertEqual(UserBubble.sendingLabel, "Sending…")
        XCTAssertEqual(UserBubble.sendingOpacity, 0.62, "web `.chat-sending`")
    }

    func testAcceptanceTurnsTheSameBubbleIntoTheOrdinaryOne() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let id = bubbles(r).last!.id
        r.setOptimisticTurnId(clientTurnId: "c2", turnId: "t2", placement: "accepted",
                              acceptedAt: "2026-11-27T10:01:00Z")
        let bubble = bubbles(r).last!
        XCTAssertEqual(bubble.id, id, "the same row")
        XCTAssertFalse(bubble.isSending)
        XCTAssertFalse(r.state.tailIsSending)
        XCTAssertEqual(bubble.ts, "2026-11-27T10:01:00Z", "its time in the foot, where Sending… was")
        XCTAssertEqual(bubbles(r).count, 2)
    }

    func testNoTurnClockRunsUnderAMessageTheServerHasNotTaken() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let sent = bubbles(r).last!.id
        XCTAssertFalse(headIDs(r, running: true).contains(sent))
        XCTAssertFalse(rows(r, running: true).contains {
            if case .turnHead(let line) = $0 { return TurnHead.label(line, running: true)?.hasPrefix("Working") == true }
            return false
        })
        r.setOptimisticTurnId(clientTurnId: "c2", turnId: "t2")
        XCTAssertFalse(headIDs(r, running: true).contains(sent), "taken, but no turn has opened yet")
        r.apply(user(4, turn: "t2", text: "ship it"))
        XCTAssertTrue(headIDs(r, running: true).contains(sent), "the echo opens the turn")
    }

    func testAnEarlyEchoReconcilesWithoutADuplicate() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let id = bubbles(r).last!.id
        r.apply(user(4, turn: "t2", text: "ship it"))                    // before the POST's answer
        XCTAssertFalse(bubbles(r).last!.isSending)
        r.setOptimisticTurnId(clientTurnId: "c2", turnId: "t2", placement: "accepted")
        XCTAssertEqual(bubbles(r).map(\.text), ["first", "ship it"])
        XCTAssertEqual(bubbles(r).last!.id, id)
        XCTAssertEqual(bubbles(r).last!.turnId, "t2")
    }

    func testAnEarlyEchoOfPicturesAloneReconcilesToo() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "", attachments: [TurnAttachment(id: "att-1")])
        r.apply(user(4, turn: "t2", text: "", attachments: ["att-1"]))
        r.setOptimisticTurnId(clientTurnId: "c2", turnId: "t2")
        XCTAssertEqual(bubbles(r).count, 2)
        XCTAssertFalse(bubbles(r).last!.isSending)
    }

    func testAnEchoOfOtherPicturesIsAnotherMessage() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "", attachments: [TurnAttachment(id: "att-1")])
        r.apply(user(4, turn: "t9", text: "", attachments: ["att-9"]))
        XCTAssertEqual(bubbles(r).filter(\.isSending).count, 1)
    }

    /// Sent while a turn runs: the bubble waits in the transcript's tail, and moves to the tray only
    /// once the answer says it is on the queue.
    func testAMessageSentMidTurnWaitsInTheTailUntilTheServerTakesIt() {
        var r = idle()
        r.apply(user(4, turn: "t2", text: "long job"))
        r.addOptimisticUser(clientTurnId: "c3", text: "and then deploy", queued: true)
        func tail() -> [String] {
            rows(r, running: true).compactMap { if case .queued(let b) = $0 { return b.text }; return nil }
        }
        func tray() -> [String] {
            PendingTray.rows(state: r.state, withdrawing: [], steering: [], steerOffered: true).map(\.text)
        }
        XCTAssertEqual(tail(), ["and then deploy"])
        XCTAssertEqual(tray(), [])
        XCTAssertTrue(r.state.queued[0].isSending)
        XCTAssertFalse(r.state.tailIsSending, "the running turn's own dots stay")
        XCTAssertFalse(RunnerUpdating.tailHolds(r.state.queued), "Sending…, not held")

        r.setOptimisticTurnId(clientTurnId: "c3", turnId: "t3", placement: "queued")
        XCTAssertEqual(tail(), [])
        XCTAssertEqual(tray(), ["and then deploy"])
    }

    func testTheHeldTagDoesNotLandOnAMessageStillSending() {
        var r = idle()
        let before = bubbles(r).last!.id
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        XCTAssertEqual(RunnerUpdating.footBubbleID(r.state.items), before)
    }

    // MARK: - the app's wires (SwiftUI is not built on Linux, so these read the source)

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    func testTheBubbleDrawsSendingDimmedAndNoDotsRunUnderIt() throws {
        let bubble = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift")
        XCTAssertTrue(bubble.contains("bubble.isUntaken ? UserBubble.sendingOpacity : 1"), "on its way, or Not sent")
        XCTAssertTrue(bubble.contains("Text(UserBubble.sendingLabel)"))
        XCTAssertEqual(bubble.components(separatedBy: ".opacity(strength)").count - 1, 3,
                       "the pictures, the files and the words")
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        XCTAssertTrue(console.contains("guard !state.tailIsSending else { return false }"))
    }

    func testTheAnswerNeverTouchesTheComposer() throws {
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        let start = try XCTUnwrap(console.range(of: "let accepted = try await postTurn("))
        let end = try XCTUnwrap(console.range(of: "} catch {", range: start.upperBound..<console.endIndex))
        XCTAssertFalse(console[start.lowerBound..<end.lowerBound].contains("composerText"),
                       "what was typed while the message was on its way stays in the box")
    }
}
