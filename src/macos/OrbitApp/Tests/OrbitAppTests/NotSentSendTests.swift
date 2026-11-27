import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import OrbitKit
@testable import OrbitApp

/// The turn door, scripted: each POST to `/sessions/S1/turns` takes the next step — an answer, a
/// dropped connection, or no answer at all. Every other request is a 404. Records each attempt's
/// `clientTurnId` and how many held requests were ended by the client.
private final class ScriptedTurnURLProtocol: URLProtocol, @unchecked Sendable {
    enum Step { case answer(Int, String), drop, hold }

    private static let lock = NSLock()
    private static var steps: [Step] = []
    private static var keys: [String] = []
    private static var ended = 0

    static func script(_ next: [Step]) {
        lock.lock(); defer { lock.unlock() }
        steps = next
        keys = []
        ended = 0
    }

    static func then(_ next: [Step]) {
        lock.lock(); defer { lock.unlock() }
        steps += next
    }

    /// The `clientTurnId` of every attempt so far, in order.
    static var attempts: [String] {
        lock.lock(); defer { lock.unlock() }
        return keys
    }

    /// Held requests the client ended.
    static var endedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return ended
    }

    private var holding = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard request.httpMethod == "POST", request.url!.path.hasSuffix("/sessions/S1/turns") else {
            return respond(404, "")
        }
        let body = Self.body(of: request)
        let key = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["clientTurnId"] as? String
        Self.lock.lock()
        Self.keys.append(key ?? "")
        let step = Self.steps.isEmpty ? Step.hold : Self.steps.removeFirst()
        Self.lock.unlock()
        switch step {
        case .answer(let status, let body): respond(status, body)
        case .drop: client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        case .hold: holding = true
        }
    }

    override func stopLoading() {
        guard holding else { return }
        holding = false
        Self.lock.lock()
        Self.ended += 1
        Self.lock.unlock()
    }

    private func respond(_ status: Int, _ body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// A request's body reaches a URLProtocol as a stream.
    private static func body(of request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// A message into an existing session that did not get through: refused, or unanswered for 20 s.
/// Its bubble stays and reads `⚠ Not sent · Retry · Put back in the composer`
/// (docs/mocks/composer-sending-bubble, board 04-native-parity).
@MainActor
final class NotSentSendTests: XCTestCase {
    private static let accepted = #"{"turnId":"t2","kind":"message","placement":"accepted"}"#
    private static let ended = #"{"statusCode":409,"message":"the session has ended"}"#

    private func console(store: UnsentSendStoring = UnsentSendMemoryStore(),
                         restoring extra: [RunEvent] = []) throws -> ConsoleModel {
        var reducer = TranscriptReducer()
        let page = try JSONDecoder().decode(EventPage.self, from: Data(#"""
        {"events":[{"seq":1,"type":"user","turnId":"t1","payload":{"text":"first"}},
                   {"seq":2,"type":"assistant","turnId":"t1","payload":{"text":"done"}},
                   {"seq":3,"type":"turn_end","turnId":"t1","payload":{"subtype":"success"}}],"hasMore":false}
        """#.utf8))
        reducer.applyTailPage(page)
        for ev in extra { reducer.apply(ev) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScriptedTurnURLProtocol.self]
        let baseURL = URL(string: "https://orbit.test")!
        let tokens = InMemoryTokenStore()
        return ConsoleModel(sessionID: "S1", baseURL: baseURL, tokenStore: tokens,
                            attachments: AttachmentImageStore(baseURL: baseURL, tokenStore: tokens),
                            restoring: reducer, session: URLSession(configuration: configuration),
                            unsentSends: store)
    }

    private func users(_ console: ConsoleModel) -> [UserBubble] {
        console.state.items.compactMap { if case .user(let b) = $0 { return b }; return nil }
    }

    private func last(_ console: ConsoleModel) -> UserBubble? { users(console).last }

    private func send(_ console: ConsoleModel, _ words: String) async {
        console.composerText = words
        await console.send(authoritative: .awaitingInput)
    }

    // MARK: refused

    func testARefusalKeepsTheBubbleAsNotSentWithTheServersReason() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended)])
        let store = UnsentSendMemoryStore()
        let console = try console(store: store)
        await send(console, "Ship the quarterly report")

        let bubble = try XCTUnwrap(last(console))
        XCTAssertEqual(bubble.text, "Ship the quarterly report", "the bubble stays")
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason, "the session has ended", "the reason is available")
        XCTAssertEqual(console.composerText, "", "nothing is put back until the person asks")
        XCTAssertNil(console.statusMessage, "no Couldn't send line")
        XCTAssertFalse(console.showWorkingIndicator, "nothing works under it")
        XCTAssertEqual(store.sends(in: "S1").map(\.reason), ["the session has ended"], "kept for a restart")
    }

    // MARK: 20 s

    func testNoAnswerWithinTheLimitEndsTheRequestAndReadsNotSent() async throws {
        ScriptedTurnURLProtocol.script([.hold])
        let console = try console()
        console.sendAnswerTimeout = 0.4
        let started = Date()
        await send(console, "Ship the quarterly report")

        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the limit, not the 60 s request timeout")
        let bubble = try XCTUnwrap(last(console))
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason,
                       "The server didn't answer in 20 seconds. Retry sends the same message again; it can't arrive twice.")
        for _ in 0..<200 where ScriptedTurnURLProtocol.endedCount == 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(ScriptedTurnURLProtocol.endedCount, 1, "the request was ended, not left open")
        XCTAssertNil(console.statusMessage, "no Couldn't send line")
        XCTAssertFalse(console.sending, "Send is on again")
    }

    func testReplaysWithinTheLimitStaySilentUnderOneKey() async throws {
        ScriptedTurnURLProtocol.script([.drop, .drop, .answer(200, Self.accepted)])
        let console = try console()
        await send(console, "Ship the quarterly report")

        let attempts = ScriptedTurnURLProtocol.attempts
        XCTAssertEqual(attempts.count, 3)
        XCTAssertEqual(Set(attempts).count, 1, "one clientTurnId throughout")
        let bubble = try XCTUnwrap(last(console))
        XCTAssertFalse(bubble.isNotSent)
        XCTAssertEqual(bubble.turnId, "t2", "the blip was hidden: the message went")
        XCTAssertEqual(bubble.clientTurnId, attempts.first)
        XCTAssertNil(console.statusMessage)
    }

    func testRepeatedDropsPastTheReplaysReadNotSentWithTheSameKey() async throws {
        ScriptedTurnURLProtocol.script([.drop, .drop, .drop, .drop])
        let console = try console()
        await send(console, "Ship the quarterly report")

        XCTAssertEqual(Set(ScriptedTurnURLProtocol.attempts).count, 1)
        let bubble = try XCTUnwrap(last(console))
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason, "the connection dropped")
        XCTAssertNil(console.statusMessage, "the replay notice is taken down, and no Couldn't send line replaces it")
    }

    // MARK: Retry

    func testRetrySendsTheSameClientTurnIdAndTheBubbleIsSent() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended)])
        let store = UnsentSendMemoryStore()
        let console = try console(store: store)
        await send(console, "Ship the quarterly report")
        let notSent = try XCTUnwrap(last(console))
        XCTAssertTrue(notSent.isNotSent)

        ScriptedTurnURLProtocol.then([.answer(200, Self.accepted)])
        await console.retryUnsent(notSent)

        let attempts = ScriptedTurnURLProtocol.attempts
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0], attempts[1], "Retry is the same send: the same clientTurnId")
        let sent = try XCTUnwrap(last(console))
        XCTAssertEqual(sent.id, notSent.id, "the same row")
        XCTAssertFalse(sent.isNotSent)
        XCTAssertEqual(sent.turnId, "t2")
        XCTAssertEqual(users(console).count, 2, "never a second bubble")
        XCTAssertTrue(store.sends(in: "S1").isEmpty, "nothing left to retry")
    }

    func testANonRetryableRefusalStillOffersRetryWhichSaysWhyAgain() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended), .answer(409, Self.ended)])
        let console = try console()
        await send(console, "Ship the quarterly report")
        await console.retryUnsent(try XCTUnwrap(last(console)))

        XCTAssertEqual(ScriptedTurnURLProtocol.attempts.count, 2)
        let bubble = try XCTUnwrap(last(console))
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason, "the session has ended")
        XCTAssertNil(console.statusMessage)
    }

    // MARK: Put back

    func testPutBackReturnsTheWordsAndTheFilesAndTheBubbleGoes() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended)])
        let store = UnsentSendMemoryStore()
        let console = try console(store: store)
        await console.send(authoritative: .awaitingInput, overrideText: "Ship the quarterly report",
                           overrideAttachments: [TurnAttachment(id: "up1", mime: "application/pdf", name: "q3.pdf")])
        let notSent = try XCTUnwrap(last(console))
        XCTAssertTrue(notSent.isNotSent)
        XCTAssertEqual(notSent.attachments.map(\.id), ["up1"], "the chips show on the Not sent bubble")

        console.putBackUnsent(notSent)

        XCTAssertEqual(console.composerText, "Ship the quarterly report")
        XCTAssertEqual(console.pendingAttachments.map(\.remoteID), ["up1"], "the file comes back with the words")
        XCTAssertEqual(console.pendingAttachments.first?.filename, "q3.pdf")
        XCTAssertFalse(users(console).contains { $0.id == notSent.id }, "the bubble goes")
        XCTAssertTrue(store.sends(in: "S1").isEmpty)
        XCTAssertEqual(ScriptedTurnURLProtocol.attempts.count, 1, "nothing is sent")
    }

    func testPutBackKeepsWhatWasTypedSinceAboveTheReturnedWords() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended)])
        let console = try console()
        await send(console, "Ship the quarterly report")
        console.composerText = "a new thought"
        console.putBackUnsent(try XCTUnwrap(last(console)))
        XCTAssertEqual(console.composerText, "a new thought\n\nShip the quarterly report")
    }

    // MARK: restart

    func testANotSentMessageIsReloadedAfterARestartAndNotSentAgain() async throws {
        ScriptedTurnURLProtocol.script([])
        let store = UnsentSendMemoryStore([
            UnsentSend(clientTurnId: "c-kept", sessionID: "S1", text: "Ship the quarterly report",
                       draft: "Ship the quarterly report",
                       attachments: [TurnAttachment(id: "up1", mime: "image/png", name: "chart.png")],
                       reason: "the session has ended", afterSeq: 3),
            UnsentSend(clientTurnId: "c-open", sessionID: "S1", text: "and the appendix",
                       draft: "and the appendix", afterSeq: 3),
            UnsentSend(clientTurnId: "c-other", sessionID: "S2", text: "elsewhere", draft: "elsewhere"),
        ])
        let console = try console(store: store)

        let reloaded = users(console).filter(\.isNotSent)
        XCTAssertEqual(reloaded.map(\.clientTurnId), ["c-kept", "c-open"])
        XCTAssertEqual(reloaded.map(\.notSentReason), [
            "the session has ended",
            "The app closed before the server answered. Retry sends the same message again; it can't arrive twice.",
        ], "one still on its way when the app closed is Not sent now, with Retry")
        XCTAssertEqual(reloaded.first?.attachments.map(\.id), ["up1"])
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(ScriptedTurnURLProtocol.attempts.isEmpty, "never replayed on launch by itself")
        XCTAssertEqual(store.sends(in: "S2").map(\.clientTurnId), ["c-other"], "another session's stays as it was")

        // …and its Retry is the same send.
        ScriptedTurnURLProtocol.then([.answer(200, Self.accepted)])
        await console.retryUnsent(try XCTUnwrap(reloaded.first))
        XCTAssertEqual(ScriptedTurnURLProtocol.attempts, ["c-kept"])
    }

    func testAReloadedMessageWhoseEchoTheTranscriptHoldsIsLetGo() async throws {
        ScriptedTurnURLProtocol.script([])
        let store = UnsentSendMemoryStore([
            UnsentSend(clientTurnId: "c-arrived", sessionID: "S1", text: "Ship the quarterly report",
                       draft: "Ship the quarterly report", reason: UserBubble.notAnsweredReason, afterSeq: 3),
        ])
        let echo = RunEvent(seq: 4, type: .user, ts: "2026-11-27T10:01:00Z", turnId: "t2",
                            payload: .object(["text": .string("Ship the quarterly report")]))
        let console = try console(store: store, restoring: [echo])

        XCTAssertEqual(users(console).map(\.text), ["first", "Ship the quarterly report"],
                       "the echo stands for it: never a Not sent bubble beside it")
        XCTAssertFalse(users(console).contains(where: \.isNotSent))
        XCTAssertTrue(store.sends(in: "S1").isEmpty)
    }

    // MARK: refusals with their own card

    func testAConflictRefusalKeepsItsCardAndPutsTheWordsBack() async throws {
        let held = #"{"statusCode":409,"code":"TASK_ALREADY_RUNNING","message":"held","conflictingSessionId":"S9","taskId":"T1"}"#
        ScriptedTurnURLProtocol.script([.answer(409, held)])
        let store = UnsentSendMemoryStore()
        let console = try console(store: store)
        await send(console, "Ship the quarterly report")

        XCTAssertNotNil(console.runConflict, "the refusal's own card")
        XCTAssertEqual(console.composerText, "Ship the quarterly report", "the words are back in the box")
        XCTAssertFalse(users(console).contains { $0.text == "Ship the quarterly report" }, "the bubble steps aside")
        XCTAssertNil(console.statusMessage)
        XCTAssertTrue(store.sends(in: "S1").isEmpty)
    }

    // MARK: one at a time

    func testSendAndRetryStayOffWhileOneIsOnItsWay() async throws {
        ScriptedTurnURLProtocol.script([.answer(409, Self.ended), .hold])
        let console = try console()
        console.sendAnswerTimeout = 1.5
        await send(console, "first try")
        let notSent = try XCTUnwrap(last(console))

        console.composerText = "second message"
        let second = Task { await console.send(authoritative: .awaitingInput) }
        for _ in 0..<200 where ScriptedTurnURLProtocol.attempts.count < 2 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(console.sending)
        XCTAssertFalse(console.canSend, "Send stays off while one is on its way")
        await console.retryUnsent(notSent)
        XCTAssertEqual(ScriptedTurnURLProtocol.attempts.count, 2, "a Retry pressed meanwhile does nothing")
        await second.value
    }
}
