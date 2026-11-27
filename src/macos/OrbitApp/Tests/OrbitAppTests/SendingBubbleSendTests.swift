import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
import OrbitKit
@testable import OrbitApp

/// The send's POST, held until the test answers it; every other request is a 404.
private final class HeldTurnURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var held: HeldTurnURLProtocol?

    static var isHolding: Bool {
        lock.lock()
        defer { lock.unlock() }
        return held != nil
    }

    static func answer(_ body: String) {
        lock.lock()
        let request = held
        held = nil
        lock.unlock()
        request?.respond(200, body)
    }

    private func respond(_ status: Int, _ body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard request.httpMethod == "POST", request.url!.path.hasSuffix("/sessions/S1/turns") else {
            return respond(404, "")
        }
        Self.lock.lock()
        Self.held = self
        Self.lock.unlock()
    }

    override func stopLoading() {}
}

/// `ConsoleModel.send` against a server that has not answered yet, and then has.
@MainActor
final class SendingBubbleSendTests: XCTestCase {
    private func console() throws -> ConsoleModel {
        var reducer = TranscriptReducer()
        let page = try JSONDecoder().decode(EventPage.self, from: Data(#"""
        {"events":[{"seq":1,"type":"user","turnId":"t1","payload":{"text":"first"}},
                   {"seq":2,"type":"assistant","turnId":"t1","payload":{"text":"done"}},
                   {"seq":3,"type":"turn_end","turnId":"t1","payload":{"subtype":"success"}}],"hasMore":false}
        """#.utf8))
        reducer.applyTailPage(page)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldTurnURLProtocol.self]
        let baseURL = URL(string: "https://orbit.test")!
        let tokens = InMemoryTokenStore()
        return ConsoleModel(sessionID: "S1", baseURL: baseURL, tokenStore: tokens,
                            attachments: AttachmentImageStore(baseURL: baseURL, tokenStore: tokens),
                            restoring: reducer, session: URLSession(configuration: configuration))
    }

    private func last(_ console: ConsoleModel) -> UserBubble? {
        if case .user(let bubble)? = console.state.items.last { return bubble }
        return nil
    }

    func testTheMessageWaitsAsSendingAndWhatIsTypedMeanwhileSurvivesTheAnswer() async throws {
        let console = try console()
        console.composerText = "ship it"
        let send = Task { await console.send(authoritative: .awaitingInput) }
        for _ in 0..<500 where !HeldTurnURLProtocol.isHolding { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(HeldTurnURLProtocol.isHolding)

        XCTAssertEqual(console.composerText, "", "the words left the box at the press")
        let waiting = try XCTUnwrap(last(console))
        XCTAssertEqual(waiting.text, "ship it")
        XCTAssertTrue(waiting.isSending)
        XCTAssertFalse(console.showWorkingIndicator, "nothing works under it yet")

        console.composerText = "and one more thing"
        HeldTurnURLProtocol.answer(#"{"turnId":"t2","kind":"message","placement":"accepted"}"#)
        await send.value

        XCTAssertEqual(console.composerText, "and one more thing")
        let sent = try XCTUnwrap(last(console))
        XCTAssertEqual(sent.id, waiting.id, "the same bubble")
        XCTAssertFalse(sent.isSending)
        XCTAssertEqual(sent.turnId, "t2")
        XCTAssertTrue(console.showWorkingIndicator, "the server has it")
    }
}
