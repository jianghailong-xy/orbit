import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class GoogleDoorURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let answer = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// What reached the wire: each request's method and path, and its JSON body.
private final class GoogleDoorRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private var bodies: [[String: String]] = []

    func append(_ request: URLRequest) {
        let body = (try? JSONSerialization.jsonObject(with: sentBody(of: request))) as? [String: String]
        lock.lock()
        lines.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
        bodies.append(body ?? [:])
        lock.unlock()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    var sentBodies: [[String: String]] {
        lock.lock()
        defer { lock.unlock() }
        return bodies
    }
}

/// On macOS the URL loading system hands a URLProtocol the body as `httpBodyStream` and leaves
/// `httpBody` nil, so read the stream when there is no `httpBody`.
private func sentBody(of request: URLRequest) -> Data {
    if let body = request.httpBody, !body.isEmpty { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    stream.close()
    return data
}

/// A store whose writes don't stick — the Keychain of an unsigned build. Clearing still goes through.
private final class DroppingTokenStore: TokenStore, @unchecked Sendable {
    private let inner = InMemoryTokenStore()
    func token(for serverURL: URL) -> String? { inner.token(for: serverURL) }
    func setToken(_ token: String?, for serverURL: URL) { if token == nil { inner.setToken(nil, for: serverURL) } }
    func refreshToken(for serverURL: URL) -> String? { inner.refreshToken(for: serverURL) }
    func setRefreshToken(_ token: String?, for serverURL: URL) { if token == nil { inner.setRefreshToken(nil, for: serverURL) } }
}

/// Signing in with Google from the apps (docs/google-sign-in-design.md §4, §8.2): the /start URL
/// the sheet opens, the `orbit://auth/google` answer it comes back with, the exchange of that
/// answer's ticket, and the session kept exactly as a password sign-in keeps it.
final class GoogleSignInTests: XCTestCase {
    private let baseURL = URL(string: "https://orbit.test")!
    /// RFC 7636 Appendix B: the verifier and challenge every PKCE implementation is checked against.
    private static let rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    private static let rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    /// What the exchange answers: the same shape as `POST /auth/login`.
    private static let session = #"""
    {"accessToken":"access-g","refreshToken":"refresh-g","user":{"id":"u1","email":"ada@example.com","name":"Ada","role":"MEMBER"}}
    """#

    override func tearDown() {
        GoogleDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(_ store: TokenStore = InMemoryTokenStore()) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GoogleDoorURLProtocol.self]
        return APIClient(baseURL: baseURL, tokenStore: store, session: URLSession(configuration: configuration))
    }

    private func answer(_ status: Int, _ body: String) -> GoogleDoorRecorder {
        let recorder = GoogleDoorRecorder()
        GoogleDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, body)
        }
        return recorder
    }

    private func callback(_ query: String) -> URL { URL(string: "orbit://auth/google?\(query)")! }

    // MARK: the sign-in the app starts

    func testTheChallengeIsTheVerifiersS256() {
        XCTAssertEqual(GoogleSignIn.challenge(for: Self.rfcVerifier), Self.rfcChallenge)
        XCTAssertEqual(GoogleSignInRequest(verifier: Self.rfcVerifier, state: "s").challenge, Self.rfcChallenge)
    }

    func testEverySignInHasAVerifierAndAStateOfItsOwn() {
        let first = GoogleSignInRequest()
        let second = GoogleSignInRequest()
        let base64url = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        for token in [first.verifier, first.state, second.verifier, second.state, first.challenge] {
            XCTAssertEqual(token.count, 43, token)
            XCTAssertTrue(token.allSatisfy(base64url.contains), token)
        }
        XCTAssertEqual(Set([first.verifier, first.state, second.verifier, second.state]).count, 4)
    }

    func testTheStartURLAsksTheServerForANativeSignIn() {
        let request = GoogleSignInRequest(verifier: Self.rfcVerifier, state: "state-1")

        XCTAssertEqual(GoogleSignIn.startURL(baseURL: baseURL, request: request).absoluteString,
                       "https://orbit.test/api/auth/google/start?client=native"
                           + "&code_challenge=\(Self.rfcChallenge)&client_state=state-1")
    }

    func testTheStartURLIsOnTheServersOwnAddress() {
        let request = GoogleSignInRequest(verifier: Self.rfcVerifier, state: "state-1")
        let url = GoogleSignIn.startURL(baseURL: URL(string: "http://localhost:2086/orbit")!, request: request)

        XCTAssertEqual(url.absoluteString, "http://localhost:2086/orbit/api/auth/google/start?client=native"
                                               + "&code_challenge=\(Self.rfcChallenge)&client_state=state-1")
    }

    func testTheVerifierStaysInTheApp() {
        let request = GoogleSignInRequest()
        let url = GoogleSignIn.startURL(baseURL: baseURL, request: request).absoluteString

        XCTAssertFalse(url.contains(request.verifier))
        XCTAssertTrue(url.contains(request.challenge))
        XCTAssertTrue(url.contains(request.state))
    }

    // MARK: the server's answer

    func testAnAnswerWithThisSignInsStateHandsBackItsTicket() throws {
        XCTAssertEqual(try GoogleSignIn.ticket(from: callback("ticket=T-1&state=S-1"), state: "S-1"), "T-1")
        XCTAssertEqual(try GoogleSignIn.ticket(from: callback("state=S-1&ticket=a%2Bb"), state: "S-1"), "a+b")
        XCTAssertEqual(try GoogleSignIn.ticket(from: URL(string: "ORBIT://AUTH/google?ticket=T-1&state=S-1")!,
                                               state: "S-1"), "T-1")
    }

    func testAnErrorAnswerThrowsItsCode() {
        for code in ["GOOGLE_NOT_CONFIGURED", "GOOGLE_CANCELLED", "GOOGLE_FLOW_EXPIRED", "GOOGLE_EMAIL_UNVERIFIED"] {
            XCTAssertThrowsError(try GoogleSignIn.ticket(from: callback("error=\(code)&state=S-1"), state: "S-1")) {
                XCTAssertEqual($0 as? GoogleSignInError, .refused(code: code))
            }
        }
    }

    func testAnAnswerToAnotherSignInIsRefusedWhateverItCarries() {
        for query in ["ticket=T-1&state=S-2", "ticket=T-1", "ticket=T-1&state=", "ticket=T-1&state=s-1",
                      "error=GOOGLE_CANCELLED&state=S-2", "error=GOOGLE_CANCELLED"] {
            XCTAssertThrowsError(try GoogleSignIn.ticket(from: callback(query), state: "S-1"), query) {
                XCTAssertEqual($0 as? GoogleSignInError, .stateMismatch, query)
            }
        }
    }

    func testAnythingButOrbitAuthGoogleIsNoAnswer() {
        let urls = ["orbit://auth/other?ticket=T-1&state=S-1", "orbit://session/google?ticket=T-1&state=S-1",
                    "https://auth/google?ticket=T-1&state=S-1", "orbit://auth/google",
                    "orbit://auth/google?state=S-1", "orbit://auth/google?ticket=&state=S-1"]
        for raw in urls {
            XCTAssertThrowsError(try GoogleSignIn.ticket(from: URL(string: raw)!, state: "S-1"), raw) {
                XCTAssertEqual($0 as? GoogleSignInError, .malformedCallback, raw)
            }
        }
    }

    /// The sheet catches the answer itself (§8.2); were it ever opened as a link, it routes nowhere.
    func testTheAnswerIsNoDeepLink() {
        XCTAssertEqual(GoogleSignIn.callbackScheme, DeepLink.scheme)
        XCTAssertNil(DeepLink.parse(callback("ticket=T-1&state=S-1")))
        XCTAssertNil(DeepLink.parse(callback("error=GOOGLE_CANCELLED&state=S-1")))
        XCTAssertNil(DeepLink.parse(URL(string: "orbit://auth")!))
    }

    // MARK: whether the server offers Google

    func testTheServerSaysWhetherItOffersGoogle() async throws {
        let recorder = answer(200, #"{"password":true,"google":true,"googleSignup":true}"#)

        let methods = try await client().signInMethods()

        XCTAssertEqual(methods, SignInMethods(password: true, google: true, googleSignup: true))
        XCTAssertEqual(recorder.sent, ["GET /api/auth/methods"])
    }

    func testAServerWithGoogleOffOffersThePasswordAlone() async throws {
        _ = answer(200, #"{"password":true,"google":false,"googleSignup":false}"#)

        let methods = try await client().signInMethods()

        XCTAssertEqual(methods, .passwordOnly)
    }

    func testAServerFromBeforeGoogleSignInOffersThePasswordAlone() async throws {
        _ = answer(404, #"{"message":"Cannot GET /api/auth/methods","error":"Not Found","statusCode":404}"#)

        let methods = try await client().signInMethods()

        XCTAssertEqual(methods, .passwordOnly)
        XCTAssertFalse(methods.google)
        XCTAssertFalse(methods.googleSignup)
    }

    func testAServerThatBrokeIsNotTakenForAnOldOne() async {
        _ = answer(502, "<html>Bad Gateway</html>")

        do {
            _ = try await client().signInMethods()
            XCTFail("a 502 read as an answer")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 502, body: "<html>Bad Gateway</html>"))
        }
    }

    func testAMethodsAnswerMissingAFieldStillDecodes() throws {
        let methods = try JSONDecoder().decode(SignInMethods.self, from: Data(#"{"google":true}"#.utf8))
        XCTAssertEqual(methods, SignInMethods(password: true, google: true, googleSignup: false))
    }

    // MARK: the exchange, and the session it leaves

    func testTheExchangeSendsTheTicketAndVerifierAndKeepsTheSession() async throws {
        let recorder = answer(201, Self.session)
        let store = InMemoryTokenStore()

        let res = try await client(store).exchangeGoogleTicket("T-1", codeVerifier: Self.rfcVerifier)

        XCTAssertEqual(recorder.sent, ["POST /api/auth/google/exchange"])
        XCTAssertEqual(recorder.sentBodies, [["ticket": "T-1", "codeVerifier": Self.rfcVerifier]])
        XCTAssertEqual(res.accessToken, "access-g")
        XCTAssertEqual(res.user.email, "ada@example.com")
        XCTAssertEqual(store.token(for: baseURL), "access-g")
        XCTAssertEqual(store.refreshToken(for: baseURL), "refresh-g")
    }

    func testAnExchangeTheStoreDidntKeepIsNoSignIn() async {
        _ = answer(201, Self.session)
        let store = DroppingTokenStore()

        do {
            _ = try await client(store).exchangeGoogleTicket("T-1", codeVerifier: Self.rfcVerifier)
            XCTFail("signed in with no token stored")
        } catch {
            XCTAssertEqual(error as? TokenNotStoredError, TokenNotStoredError())
        }
        XCTAssertNil(store.token(for: baseURL))
        XCTAssertNil(store.refreshToken(for: baseURL))
    }

    func testARefusedExchangeKeepsNothing() async {
        let refusal = #"{"code":"GOOGLE_ACCOUNT_NOT_FOUND","message":"No Orbit account signs in with this Google account"}"#
        _ = answer(403, refusal)
        let store = InMemoryTokenStore()

        do {
            _ = try await client(store).exchangeGoogleTicket("T-1", codeVerifier: Self.rfcVerifier)
            XCTFail("a refused exchange signed in")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 403, body: refusal))
            XCTAssertEqual(APIClient.refusalCode(error), "GOOGLE_ACCOUNT_NOT_FOUND")
        }
        XCTAssertNil(store.token(for: baseURL))
        XCTAssertNil(store.refreshToken(for: baseURL))
    }

    // MARK: one whole sign-in

    func testASignInOpensStartAndTradesTheTicketItBringsBack() async throws {
        let recorder = answer(201, Self.session)
        let store = InMemoryTokenStore()
        let request = GoogleSignInRequest()
        let start = GoogleSignIn.startURL(baseURL: baseURL, request: request)
        var opened: [URL] = []

        let res = try await GoogleSignIn.signIn(api: client(store), request: request) { url in
            opened.append(url)
            return URL(string: "orbit://auth/google?ticket=T-9&state=\(request.state)")!
        }

        XCTAssertEqual(opened, [start])
        XCTAssertEqual(recorder.sent, ["POST /api/auth/google/exchange"])
        XCTAssertEqual(recorder.sentBodies, [["ticket": "T-9", "codeVerifier": request.verifier]])
        XCTAssertEqual(res.user.email, "ada@example.com")
        XCTAssertEqual(store.token(for: baseURL), "access-g")
        XCTAssertEqual(store.refreshToken(for: baseURL), "refresh-g")
    }

    func testAnErrorAnswerAsksTheServerForNothing() async {
        let recorder = answer(201, Self.session)
        let request = GoogleSignInRequest()

        do {
            _ = try await GoogleSignIn.signIn(api: client(), request: request) { _ in
                URL(string: "orbit://auth/google?error=GOOGLE_NOT_CONFIGURED&state=\(request.state)")!
            }
            XCTFail("an error answer signed in")
        } catch {
            XCTAssertEqual(error as? GoogleSignInError, .refused(code: "GOOGLE_NOT_CONFIGURED"))
        }
        XCTAssertEqual(recorder.sent, [])
    }

    func testAnAnswerToAnotherSignInIsNeverTraded() async {
        let recorder = answer(201, Self.session)
        let store = InMemoryTokenStore()

        do {
            _ = try await GoogleSignIn.signIn(api: client(store), request: GoogleSignInRequest()) { _ in
                URL(string: "orbit://auth/google?ticket=T-9&state=someone-elses")!
            }
            XCTFail("another sign-in's ticket was traded")
        } catch {
            XCTAssertEqual(error as? GoogleSignInError, .stateMismatch)
        }
        XCTAssertEqual(recorder.sent, [])
        XCTAssertNil(store.token(for: baseURL))
    }

    func testClosingTheSheetEndsTheSignIn() async {
        let recorder = answer(201, Self.session)

        do {
            _ = try await GoogleSignIn.signIn(api: client()) { _ in throw GoogleSignInError.cancelled }
            XCTFail("a closed sheet signed in")
        } catch {
            XCTAssertEqual(error as? GoogleSignInError, .cancelled)
        }
        XCTAssertEqual(recorder.sent, [])
    }
}
