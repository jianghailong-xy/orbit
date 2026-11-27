import Foundation
import XCTest
@testable import OrbitKit

/// A message into an existing session the server refused, or did not answer within 20 s, keeps its
/// bubble: `⚠ Not sent · Retry · Put back in the composer`, with the reason available
/// (docs/mocks/composer-sending-bubble, board 04-native-parity; web pendingSend.ts).
final class NotSentBubbleTests: XCTestCase {
    private func user(_ seq: Int, turn: String, text: String, attachments: [String] = []) -> RunEvent {
        var payload: [String: JSONValue] = ["text": .string(text)]
        if !attachments.isEmpty {
            payload["attachments"] = .array(attachments.map {
                .object(["id": .string($0), "mime": .string("image/png"), "name": .string("shot.png")])
            })
        }
        return RunEvent(seq: seq, type: .user, ts: "2026-11-27T10:00:00Z", turnId: turn, payload: .object(payload))
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

    private static let ended = "the session has ended"

    func testTheCopyIsTheWebsWordForWord() throws {
        XCTAssertEqual(UserBubble.notSentLabel, "⚠ Not sent")
        XCTAssertEqual(UserBubble.retryLabel, "Retry")
        XCTAssertEqual(UserBubble.putBackLabel, "Put back in the composer")
        XCTAssertEqual(UserBubble.answerTimeout, 20)
        let pending = try source("src/web/src/lib/pendingSend.ts")
        XCTAssertTrue(pending.contains("export const SEND_ANSWER_TIMEOUT_MS = 20_000;"))
        XCTAssertTrue(pending.contains(UserBubble.notAnsweredReason), "the timeout's reason is web's own sentence")
        let transcript = try source("src/web/src/components/Transcript.tsx")
        XCTAssertTrue(transcript.contains("⚠ Not sent"))
        XCTAssertTrue(transcript.contains("Retry"))
        XCTAssertTrue(transcript.contains(UserBubble.putBackLabel))
    }

    func testARefusalKeepsTheBubbleNotSentWithItsReason() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let id = bubbles(r).last!.id
        XCTAssertTrue(r.markNotSent(clientTurnId: "c2", reason: Self.ended))
        let bubble = bubbles(r).last!
        XCTAssertEqual(bubble.id, id, "the same bubble stays")
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertFalse(bubble.isSending)
        XCTAssertTrue(bubble.isUntaken, "the server has not taken it")
        XCTAssertEqual(bubble.strength, 1, "Not sent is not dimmed")
        XCTAssertEqual(bubble.notSentReason, Self.ended)
        XCTAssertEqual(bubble.clientTurnId, "c2")
        XCTAssertTrue(r.state.tailIsSending, "no working dots under it")
        XCTAssertTrue(PendingTray.rows(state: r.state, withdrawing: [], steering: [], steerOffered: true).isEmpty)
    }

    func testTheTimeoutsReasonIsSaid() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        r.markNotSent(clientTurnId: "c2", reason: UserBubble.notAnsweredReason)
        XCTAssertEqual(bubbles(r).last!.notSentReason,
                       "The server didn't answer in 20 seconds. Retry sends the same message again; it can't arrive twice.")
    }

    func testRetryTurnsTheSameBubbleBackToSendingUnderTheSameKey() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let id = bubbles(r).last!.id
        r.markNotSent(clientTurnId: "c2", reason: Self.ended)
        r.markSending(clientTurnId: "c2")
        let bubble = bubbles(r).last!
        XCTAssertEqual(bubble.id, id)
        XCTAssertTrue(bubble.isSending)
        XCTAssertNil(bubble.notSentReason)
        XCTAssertEqual(bubble.clientTurnId, "c2", "one clientTurnId throughout")
        r.setOptimisticTurnId(clientTurnId: "c2", turnId: "t2", placement: "accepted")
        XCTAssertFalse(bubbles(r).last!.isUntaken)
        XCTAssertEqual(bubbles(r).count, 2)
    }

    func testAnEchoOfAMessageTheServerDidTakeReplacesTheNotSentBubble() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        let id = bubbles(r).last!.id
        r.markNotSent(clientTurnId: "c2", reason: UserBubble.notAnsweredReason)
        r.apply(user(4, turn: "t2", text: "ship it"))
        XCTAssertEqual(bubbles(r).map(\.text), ["first", "ship it"], "never beside it")
        let bubble = bubbles(r).last!
        XCTAssertEqual(bubble.id, id, "the echo takes its place")
        XCTAssertFalse(bubble.isNotSent)
        XCTAssertNil(bubble.notSentReason)
        XCTAssertEqual(bubble.turnId, "t2")
        XCTAssertEqual(r.drawnUntaken(clientTurnId: "c2"), false, "the console lets its record go")
    }

    func testAnEchoOfPicturesAloneReplacesItToo() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "", attachments: [TurnAttachment(id: "att-1")])
        r.markNotSent(clientTurnId: "c2", reason: Self.ended)
        r.apply(user(4, turn: "t2", text: "", attachments: ["att-1"]))
        XCTAssertEqual(bubbles(r).count, 2)
        XCTAssertFalse(bubbles(r).last!.isNotSent)
    }

    func testARunThatEndsLeavesANotSentBubbleItsRetryAndPutBack() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        r.markNotSent(clientTurnId: "c2", reason: Self.ended)
        r.apply(RunEvent(seq: 4, type: .status, payload: .object(["status": .string("FAILED")])))
        let bubble = bubbles(r).last!
        XCTAssertTrue(bubble.isNotSent, "not Not delivered: it never reached the queue that drain empties")
        XCTAssertFalse(bubble.undelivered)
    }

    func testARunThatEndedUnderTheSendStillLetsItReadNotSent() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        r.apply(RunEvent(seq: 4, type: .status, payload: .object(["status": .string("FAILED")])))
        XCTAssertEqual(r.drawnUntaken(clientTurnId: "c2"), true, "no answer tagged it")
        XCTAssertTrue(r.markNotSent(clientTurnId: "c2", reason: Self.ended))
        XCTAssertTrue(bubbles(r).last!.isNotSent)
    }

    func testAMessageQueuedBehindARunningTurnReadsNotSentInTheTail() {
        var r = idle()
        r.apply(user(4, turn: "t2", text: "long job"))
        r.addOptimisticUser(clientTurnId: "c3", text: "and then deploy", queued: true)
        r.markNotSent(clientTurnId: "c3", reason: Self.ended)
        let rows = TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, running: true)
        let tail = rows.compactMap { row -> UserBubble? in if case .queued(let b) = row { return b }; return nil }
        XCTAssertEqual(tail.map(\.text), ["and then deploy"])
        XCTAssertTrue(tail[0].isNotSent)
        XCTAssertTrue(PendingTray.rows(state: r.state, withdrawing: [], steering: [], steerOffered: true).isEmpty)
        XCTAssertFalse(RunnerUpdating.holdsQueued(tail[0]))
    }

    func testMarkingIsANoOpOnceTheMessageArrivedOrWentBack() {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        r.apply(user(4, turn: "t2", text: "ship it"))
        XCTAssertFalse(r.markNotSent(clientTurnId: "c2", reason: Self.ended), "its echo already took it")
        r.addOptimisticUser(clientTurnId: "c3", text: "and more")
        r.markNotSent(clientTurnId: "c3", reason: Self.ended)
        r.removeOptimisticUser(clientTurnId: "c3")
        XCTAssertNil(r.drawnUntaken(clientTurnId: "c3"), "Put back took it down")
        XCTAssertFalse(r.markNotSent(clientTurnId: "c3", reason: Self.ended))
    }

    // MARK: across a restart

    func testAReloadedMessageIsDrawnNotSentOnceAtTheEnd() {
        var r = idle()
        r.addUnsentUser(clientTurnId: "c2", text: "ship it", attachments: [TurnAttachment(id: "up1", mime: "image/png")],
                        notSentReason: UnsentSend.closedBeforeAnswerReason)
        r.addUnsentUser(clientTurnId: "c2", text: "ship it", notSentReason: UnsentSend.closedBeforeAnswerReason)
        let bubble = bubbles(r).last!
        XCTAssertEqual(bubbles(r).count, 2, "drawn once")
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.attachments.map(\.id), ["up1"], "its chips show")
        XCTAssertEqual(bubble.notSentReason,
                       "The app closed before the server answered. Retry sends the same message again; it can't arrive twice.")
    }

    func testTheNotSentBubbleSurvivesATranscriptSnapshot() throws {
        var r = idle()
        r.addOptimisticUser(clientTurnId: "c2", text: "ship it")
        r.markNotSent(clientTurnId: "c2", reason: Self.ended)
        let restored = try JSONDecoder().decode(TranscriptReducer.self, from: JSONEncoder().encode(r))
        XCTAssertEqual(bubbles(restored).last!.notSentReason, Self.ended)
        XCTAssertTrue(bubbles(restored).last!.isNotSent)
    }

    func testAnEchoAfterTheSendIsFoundForAReloadedMessage() {
        let send = UnsentSend(clientTurnId: "c2", sessionID: "S1", text: "ship it", draft: "ship it", afterSeq: 3)
        var before = idle()
        before.apply(user(4, turn: "t9", text: "ship it"))
        XCTAssertTrue(before.state.holdsEcho(of: send), "the same words, opened after it was sent")
        var earlier = TranscriptReducer()
        earlier.apply(user(2, turn: "t0", text: "ship it"))
        XCTAssertFalse(earlier.state.holdsEcho(of: send), "the same words sent before it are another message")
        XCTAssertFalse(idle().state.holdsEcho(of: send))
        let pictures = UnsentSend(clientTurnId: "c3", sessionID: "S1", text: "", draft: "",
                                  attachments: [TurnAttachment(id: "up1")], afterSeq: 3)
        var echoed = idle()
        echoed.apply(user(4, turn: "t9", text: "", attachments: ["up1"]))
        XCTAssertTrue(echoed.state.holdsEcho(of: pictures))
    }

    func testTheStoreKeepsEachSessionsMessagesApart() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "NotSentBubbleTests-\(UUID().uuidString)"))
        let url = URL(string: "https://orbit.test")!
        let store = UnsentSendDefaultsStore(baseURL: url, defaults: defaults)
        let a = UnsentSend(clientTurnId: "c1", sessionID: "S1", text: "one", draft: "one",
                           attachments: [TurnAttachment(id: "up1", mime: "image/png", name: "a.png")],
                           reason: Self.ended, afterSeq: 3)
        let b = UnsentSend(clientTurnId: "c2", sessionID: "S2", text: "!ls", draft: "!ls", shell: true)
        store.replace(in: "S1", with: [a])
        store.replace(in: "S2", with: [b])
        let reopened = UnsentSendDefaultsStore(baseURL: url, defaults: defaults)
        XCTAssertEqual(reopened.sends(in: "S1"), [a], "the words, the key, the session and the attachment ids survive")
        XCTAssertEqual(reopened.sends(in: "S2"), [b])
        reopened.replace(in: "S1", with: [])
        XCTAssertEqual(reopened.load(), [b])
        XCTAssertTrue(UnsentSendDefaultsStore(baseURL: URL(string: "https://other.test")!, defaults: defaults).load().isEmpty,
                      "one key per server")
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

    private func section(_ text: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(text.range(of: start), "missing \(start)")
        let b = try XCTUnwrap(text.range(of: end, range: a.upperBound..<text.endIndex), "missing \(end)")
        return String(text[a.lowerBound..<b.lowerBound])
    }

    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    func testASendThatDidNotGetThroughSaysSoOnItsBubbleNotInACouldntSendLine() throws {
        let console = try source(Self.console)
        let deliver = try section(console, from: "private func deliver(_ clientTurnId: String, resuming: Bool) async {",
                                  to: "private func handBack(")
        XCTAssertFalse(deliver.contains("sendFailureMessage"), "no Couldn't send line for it")
        XCTAssertFalse(deliver.contains("composerText"), "nothing goes back into the box by itself")
        XCTAssertTrue(deliver.contains("reducer.markNotSent(clientTurnId: clientTurnId, reason: reason)"))
        XCTAssertTrue(deliver.contains("error is SendNotAnswered ? UserBubble.notAnsweredReason : APIClient.failureReason(error)"))
        // The refusals with a card of their own keep it, and hand the words back.
        let cards = try section(deliver, from: "if let held = error as? TaskRunStillHeld", to: "} else {")
        XCTAssertEqual(cards.components(separatedBy: "handBack(clientTurnId)").count - 1, 2)
        XCTAssertTrue(console.contains("composerText = composerText.isEmpty ? draft : draft + \"\\n\" + composerText"))
    }

    func testTheAnswerIsWaitedForTwentySecondsAndTheRequestIsThenEnded() throws {
        let console = try source(Self.console)
        XCTAssertTrue(console.contains("var sendAnswerTimeout: TimeInterval = UserBubble.answerTimeout"))
        let post = try section(console, from: "private func postTurn(", to: "private func postTurnReplaying(")
        XCTAssertTrue(post.contains("return try await answered(within: sendAnswerTimeout) {"),
                      "the replays and the handoff wait run inside the one deadline")
        XCTAssertTrue(post.contains("defer { group.cancelAll() }"), "past it the request is ended")
        XCTAssertTrue(console.contains("return try await self.api.interruptAndSend(sessionID: self.sessionID, interruptRequest)"),
                      "a stop-and-send's follow-up goes out inside the same deadline and replays")
        let api = try source("src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift")
        XCTAssertTrue(api.contains("try await postCancellable(\"sessions/\\(sessionID)/interrupt\", body: req)"))
        XCTAssertTrue(api.contains("try await postCancellable(\"sessions/\\(sessionID)/turns\", body: req)"))
        XCTAssertTrue(api.contains("try await postCancellable(\"sessions/\\(sessionID)/resume\", body: req)"))
    }

    func testRetryIsTheSameSendAndOneAtATime() throws {
        let console = try source(Self.console)
        let retry = try section(console, from: "func retryUnsent(_ bubble: UserBubble) async {", to: "func putBackUnsent(")
        XCTAssertTrue(retry.contains("!sending"), "a press while another send is on its way does nothing")
        XCTAssertTrue(retry.contains("await deliver(clientTurnId, resuming: resuming)"))
        XCTAssertFalse(retry.contains("UUID()"), "no new key")
    }

    func testTheBubbleDrawsTheFootWithTheReasonAsATooltipOnTheMacAndALineOnIPhone() throws {
        let bubble = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift")
        let foot = try section(bubble, from: "private var notSentFoot: some View {", to: "private var notSentWhy: some View {")
        XCTAssertTrue(foot.contains("Text(UserBubble.notSentLabel)"))
        XCTAssertTrue(foot.contains("Text(UserBubble.retryLabel)"))
        XCTAssertTrue(foot.contains("Text(UserBubble.putBackLabel)"))
        XCTAssertTrue(foot.contains("#if os(macOS)\n        .help(bubble.notSentReason ?? \"\")"), "a hover tooltip on the Mac")
        let why = try section(bubble, from: "private var notSentWhy: some View {", to: "/// Why a message only the server's receipt")
        XCTAssertTrue(why.contains("#if os(iOS)"))
        XCTAssertTrue(why.contains("Text(reason).font(.orbitMeta).foregroundStyle(.red)"), "one red line on iPhone")
        XCTAssertTrue(bubble.contains("if bubble.isNotSent {\n                notSentFoot"))
        let view = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
        XCTAssertTrue(view.contains(".environment(\\.notSentActions, NotSentActions("))
        XCTAssertTrue(view.contains("retryEnabled: !console.sending))"))
    }
}
