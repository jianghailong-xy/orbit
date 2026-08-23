import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// THE NAME ONE Run now CARRIES, over a real URLSession.
///
/// `POST /tasks/:id/execute` keys this request's receipt on the `triggerId` in its body
/// (src/apiserver/src/tasks/task-run-identity.ts), which is what makes a resend of one press the
/// same run rather than a second. Two things decide whether this client is usable for that, and
/// neither is visible to the type system: the token has to be a Base62 public id the server can
/// decode, and it has to survive the 401 refresh-and-retry — a resend nothing above `send` can see
/// or re-name.
/// What a stubbed attempt does: answer with a status, or lose the answer entirely.
private enum StubbedAttempt {
    case answered(status: Int, data: Data)
    /// The connection dies with the request already delivered — a dropped link, a killed proxy.
    /// The server may well have committed the run; the client simply never learns.
    case transportFailure
}

private final class RunRequestURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> StubbedAttempt)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        switch handler(request) {
        case .transportFailure:
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        case .answered(let status, let data):
            let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                           httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// URLProtocol hands back a request whose body has been moved to `httpBodyStream`, so the bytes are
/// read off the stream rather than off `httpBody` (which is nil by then).
private func bodyBytes(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return data
}

private final class BodyRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [[String: String]] = []

    func append(_ request: URLRequest) {
        let decoded = (try? JSONDecoder().decode([String: String].self, from: bodyBytes(request))) ?? [:]
        lock.lock()
        storage.append(decoded)
        lock.unlock()
    }

    var bodies: [[String: String]] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

final class RunRequestTokenTests: XCTestCase {
    override func tearDown() {
        RunRequestURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(refreshToken: String? = nil) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunRequestURLProtocol.self]
        let baseURL = URL(string: "https://orbit.test")!
        let store = InMemoryTokenStore()
        store.setToken("stale", for: baseURL)
        if let refreshToken { store.setRefreshToken(refreshToken, for: baseURL) }
        return APIClient(baseURL: baseURL, tokenStore: store,
                         session: URLSession(configuration: configuration))
    }

    func testNewTokenIsABase62PublicIDTheServerCanDecode() {
        // `@IsPublicId` decodes the value and runs `IsUUID('all')` on the result, so a token in any
        // other shape is a 400 rather than a run.
        let token = PublicID.newToken()

        XCTAssertFalse(token.isEmpty)
        XCTAssertTrue(token.allSatisfy { $0.isLetter || $0.isNumber })
        let decoded = PublicID.toUUID(token)
        XCTAssertNotNil(decoded, "\(token) is not a Base62 public id")
        XCTAssertEqual(decoded?.count, 36)
        XCTAssertEqual(decoded?.split(separator: "-").map(\.count), [8, 4, 4, 4, 12])
    }

    func testBase62EncodingIsTheInverseOfTheDecoderTheOtherClientsShare() {
        // The shared vector `PublicIDTests` pins: what the web's `uuidToBase62` produces for this
        // UUID. Round-tripping alone would pass with a private, wrong alphabet.
        let bytes: [UInt8] = [0x34, 0x0e, 0x51, 0xd2, 0x8f, 0x4d, 0x77, 0x2c,
                              0xb0, 0x60, 0x63, 0x36, 0x8b, 0xdb, 0x0a, 0x64]
        let encoded = PublicID.base62(bytes)

        XCTAssertEqual(PublicID.toUUID(encoded), "340e51d2-8f4d-772c-b060-63368bdb0a64")
    }

    func testEveryDrawIsANewName() {
        // Two deliberate presses are two runs — including a press over an error the last one left
        // on screen. Nothing is remembered between draws, which is what makes that true.
        let drawn = Set((0..<256).map { _ in PublicID.newToken() })

        XCTAssertEqual(drawn.count, 256)
    }

    func testExecuteTaskCarriesTheNameItWasGiven() async throws {
        let recorder = BodyRecorder()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            return .answered(status: 201, data: Data())
        }

        try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")

        XCTAssertEqual(recorder.bodies, [["triggerId": "341DOGTVEs0Fk0gAn1mje"]])
    }

    func testALostAnswerIsResentUnderTheSameNameByteForByte() async throws {
        // The failure the whole mechanism exists for: the POST is delivered, the run is committed,
        // and only the ANSWER is lost. A client that gives up here fails on screen while its run is
        // going, and the next press — a new name — starts a second one.
        let recorder = BodyRecorder()
        let attempts = Counter()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            return attempts.next() == 1 ? .transportFailure : .answered(status: 201, data: Data())
        }

        try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")

        XCTAssertEqual(recorder.bodies.count, 2, "a lost answer was not resent")
        XCTAssertEqual(recorder.bodies, [["triggerId": "341DOGTVEs0Fk0gAn1mje"],
                                         ["triggerId": "341DOGTVEs0Fk0gAn1mje"]])
    }

    func testTheResendIsBounded() async throws {
        // Bounded, and it FAILS when the bound is spent. An unbounded resend would hold the button
        // in its loading state for as long as an outage lasted.
        let recorder = BodyRecorder()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            return .transportFailure
        }

        do {
            try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")
            XCTFail("a request that never got an answer reported success")
        } catch {}

        XCTAssertEqual(recorder.bodies.count, 4) // one delivery plus three bounded resends
        XCTAssertEqual(Set(recorder.bodies.map { $0["triggerId"] ?? "" }).count, 1)
    }

    func testTheAnswerIsReadBackThroughInProgressUnderTheSameName() async throws {
        // The response-loss window in full: the first delivery is still committing when the resend
        // arrives, so the resend is told "being answered right now, ask again with the same
        // triggerId". Stopping there would fail the press while its run starts, and the next press
        // — a new name — would start a second one.
        let recorder = BodyRecorder()
        let attempts = Counter()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            switch attempts.next() {
            case 1: return .transportFailure
            case 2: return .answered(status: 409, data: Self.inProgressBody)
            default: return .answered(status: 201, data: Data())
            }
        }

        try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")

        XCTAssertEqual(recorder.bodies.count, 3)
        XCTAssertEqual(Set(recorder.bodies.map { $0["triggerId"] ?? "" }),
                       ["341DOGTVEs0Fk0gAn1mje"])
    }

    func testTheRealInProgressRefusalSurvivesTheSpentAttempts() async throws {
        // The real last answer, not a summary of it.
        let recorder = BodyRecorder()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            return .answered(status: 409, data: Self.inProgressBody)
        }

        do {
            try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")
            XCTFail("an unread answer was reported as success")
        } catch APIError.http(let status, let body) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(body?.contains("TASK_RUN_REQUEST_IN_PROGRESS"), true)
        }

        XCTAssertEqual(recorder.bodies.count, 4)
    }

    /// The control plane's own IN_PROGRESS body, verbatim in shape.
    private static let inProgressBody = Data(
        #"{"statusCode":409,"code":"TASK_RUN_REQUEST_IN_PROGRESS","message":"being answered"}"#.utf8)

    func testAnAnsweredRequestIsNeverResent() async throws {
        // 409 TASK_RUN_REQUEST_MISMATCH is the SAME status from the SAME door and means the
        // opposite: this name already means something else, and asking again can only repeat it.
        // Told apart by the server's own `code` — retrying on the 409 alone would loop on it.
        let recorder = BodyRecorder()
        RunRequestURLProtocol.handler = { request in
            recorder.append(request)
            return .answered(status: 409, data: Data(#"{"code":"TASK_RUN_REQUEST_MISMATCH"}"#.utf8))
        }

        do {
            try await client().executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")
            XCTFail("a 409 was reported as success")
        } catch APIError.http(let status, _) {
            XCTAssertEqual(status, 409)
        }

        XCTAssertEqual(recorder.bodies.count, 1, "a structured refusal was resent")
    }

    func testTheRefreshRetryResendsTheSameNameRatherThanADifferentRequest() async throws {
        // The resend nothing above `send` can see. If it rebuilt the body — or dropped it — one
        // press would reach the server twice under two names, which is two runs.
        let recorder = BodyRecorder()
        let attempts = Counter()
        RunRequestURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/auth/refresh") == true {
                let pair = #"{"accessToken":"a.b.c","refreshToken":"r2"}"#
                return .answered(status: 200, data: Data(pair.utf8))
            }
            recorder.append(request)
            return attempts.next() == 1
                ? .answered(status: 401, data: Data())
                : .answered(status: 201, data: Data())
        }
        let api = client(refreshToken: "r1")

        try await api.executeTask("t1", triggerId: "341DOGTVEs0Fk0gAn1mje")

        XCTAssertEqual(recorder.bodies.count, 2, "the 401 was not retried")
        XCTAssertEqual(recorder.bodies.first, recorder.bodies.last)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}
