import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import OrbitKit
@testable import OrbitApp

/// POST /sessions, scripted: each create takes the next step — an answer, or no answer at all. Records
/// every create's body.
private final class ScriptedCreateURLProtocol: URLProtocol, @unchecked Sendable {
    enum Step { case answer(Int, String), hold }

    private static let lock = NSLock()
    private static var steps: [Step] = []
    private static var bodies: [[String: Any]] = []

    static func script(_ next: [Step]) {
        lock.lock(); defer { lock.unlock() }
        steps = next
        bodies = []
    }

    /// Every create's JSON body so far, in order.
    static var creates: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return bodies
    }

    private var holding = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard request.httpMethod == "POST", request.url!.path.hasSuffix("/sessions") else { return respond(404, "") }
        let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request)) as? [String: Any]) ?? [:]
        Self.lock.lock()
        Self.bodies.append(body)
        let step = Self.steps.isEmpty ? Step.hold : Self.steps.removeFirst()
        Self.lock.unlock()
        switch step {
        case .answer(let status, let body): respond(status, body)
        case .hold: holding = true
        }
    }

    override func stopLoading() { holding = false }

    private func respond(_ status: Int, _ body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

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

/// A new session's first message waits as a `Sending…` bubble on the new-session page, as the web's
/// `draftPending` does (docs/mocks/composer-sending-bubble, boards 03 and 04).
@MainActor
final class NewSessionFirstMessageTests: XCTestCase {
    private static let made = #"""
    {"id":"S9","title":"New","status":"PENDING","runStatus":"PENDING","sessionState":"PENDING","lifecycleState":"OPEN",
     "filingState":"OPEN","agentId":"a1","assignedRunnerId":"hpc","engine":"claude","provider":"claude",
     "model":"claude-opus-5-5","permissionMode":"default","createdAt":"2026-11-27T10:00:00.000Z",
     "updatedAt":"2026-11-27T10:00:00.000Z","pendingApprovals":0,"tags":[],"source":"USER"}
    """#
    private static let refused = #"{"statusCode":409,"message":"the machine is offline"}"#

    private var opened: [String] = []

    private func draft() throws -> ConsoleModel {
        let agent = try JSONDecoder().decode(Agent.self, from: Data(#"""
        {"id":"a1","name":"orbit-develop","provider":"claude","runnerId":"hpc","enabled":true,"enableWorktree":false,
         "effort":"","workDir":"/root/orbit","appendSystemPrompt":"","workDirExists":true,"workDirIsGit":true}
        """#.utf8))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScriptedCreateURLProtocol.self]
        let baseURL = URL(string: "https://orbit.test")!
        let tokens = InMemoryTokenStore()
        let console = ConsoleModel(draftFor: agent, defaultModel: "claude-opus-5-5", baseURL: baseURL, tokenStore: tokens,
                                   attachments: AttachmentImageStore(baseURL: baseURL, tokenStore: tokens),
                                   session: URLSession(configuration: configuration))
        opened = []
        console.onSessionCreated = { [unowned self] session in self.opened.append(session.id) }
        return console
    }

    private func send(_ console: ConsoleModel, _ words: String) async {
        console.composerText = words
        await console.send()
    }

    func testThePressCarriesAClientRequestIdAndOpensTheSessionOnSuccess() async throws {
        ScriptedCreateURLProtocol.script([.answer(201, Self.made)])
        let console = try draft()
        await send(console, "Ship the quarterly report")

        let body = try XCTUnwrap(ScriptedCreateURLProtocol.creates.first)
        XCTAssertEqual(body["prompt"] as? String, "Ship the quarterly report")
        let key = try XCTUnwrap(body["clientRequestId"] as? String)
        XCTAssertNotNil(UUID(uuidString: key), "a UUID minted at the press")
        XCTAssertEqual(opened, ["S9"], "the session opens")
        XCTAssertNil(console.draftPendingBubble, "the bubble is the session's first message now")
        XCTAssertEqual(console.composerText, "")
    }

    func testRefusedReadsNotSentAndSendStaysOffUntilItIsRetriedOrPutBack() async throws {
        ScriptedCreateURLProtocol.script([.answer(409, Self.refused)])
        let console = try draft()
        await send(console, "Ship the quarterly report")

        let bubble = try XCTUnwrap(console.draftPendingBubble)
        XCTAssertEqual(bubble.text, "Ship the quarterly report")
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason, "the machine is offline")
        XCTAssertEqual(console.composerText, "", "nothing is put back until the person asks")
        XCTAssertTrue(opened.isEmpty)
        console.composerText = "Something else"
        XCTAssertFalse(console.canSend, "Send is off while one reads Not sent")
        await console.send()
        XCTAssertEqual(ScriptedCreateURLProtocol.creates.count, 1, "a press on it sends nothing")
    }

    func testRetrySendsTheSameClientRequestIdAndOpensTheSession() async throws {
        ScriptedCreateURLProtocol.script([.answer(409, Self.refused), .answer(201, Self.made)])
        let console = try draft()
        await send(console, "Ship the quarterly report")
        XCTAssertTrue(try XCTUnwrap(console.draftPendingBubble).isNotSent)

        await console.retryDraftPending()

        let keys = ScriptedCreateURLProtocol.creates.map { $0["clientRequestId"] as? String }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotNil(keys[0])
        XCTAssertEqual(keys[0], keys[1], "Retry sends the same one")
        XCTAssertEqual(ScriptedCreateURLProtocol.creates[1]["prompt"] as? String, "Ship the quarterly report")
        XCTAssertEqual(opened, ["S9"])
        XCTAssertNil(console.draftPendingBubble)
    }

    func testNoAnswerWithinTheLimitReadsNotSentWithTheTimeoutsReason() async throws {
        ScriptedCreateURLProtocol.script([.hold])
        let console = try draft()
        console.sendAnswerTimeout = 0.4
        await send(console, "Ship the quarterly report")

        let bubble = try XCTUnwrap(console.draftPendingBubble)
        XCTAssertTrue(bubble.isNotSent)
        XCTAssertEqual(bubble.notSentReason, UserBubble.notAnsweredReason)
        XCTAssertFalse(console.sending)
        XCTAssertFalse(console.canSend)
    }

    func testWhileItIsOnItsWayItReadsSending() async throws {
        ScriptedCreateURLProtocol.script([.hold])
        let console = try draft()
        console.sendAnswerTimeout = 5
        console.composerText = "Ship the quarterly report"
        let pressed = Task { await console.send() }
        for _ in 0..<200 where console.draftPendingBubble == nil { try await Task.sleep(nanoseconds: 10_000_000) }

        let bubble = try XCTUnwrap(console.draftPendingBubble)
        XCTAssertTrue(bubble.isSending)
        XCTAssertEqual(console.composerText, "", "the words left the box")
        pressed.cancel()
        await pressed.value
    }

    func testPutBackReturnsTheWordsAndTurnsSendOn() async throws {
        ScriptedCreateURLProtocol.script([.answer(409, Self.refused)])
        let console = try draft()
        await send(console, "Ship the quarterly report")

        console.putBackDraftPending()

        XCTAssertNil(console.draftPendingBubble)
        XCTAssertEqual(console.composerText, "Ship the quarterly report")
        XCTAssertTrue(console.canSend)
        XCTAssertEqual(ScriptedCreateURLProtocol.creates.count, 1, "nothing was sent")
    }

    func testAShellFirstMessageKeepsTodaysBehaviour() async throws {
        ScriptedCreateURLProtocol.script([.answer(201, Self.made)])
        let console = try draft()
        await send(console, "!ls")

        let body = try XCTUnwrap(ScriptedCreateURLProtocol.creates.first)
        XCTAssertEqual(body["shell"] as? Bool, true)
        XCTAssertNil(body["clientRequestId"], "no key, no bubble")
        XCTAssertNil(console.draftPendingBubble)
        XCTAssertEqual(opened, ["S9"])
    }
}
