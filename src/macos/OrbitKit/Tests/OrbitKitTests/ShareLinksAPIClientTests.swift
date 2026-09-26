import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class ShareDoorURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, data: Data))?

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
        client?.urlProtocol(self, didLoad: answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// URLProtocol hands back a request whose body has been moved to `httpBodyStream`, so the bytes are
/// read off the stream rather than off `httpBody` (which is nil by then).
private func sentBody(_ request: URLRequest) -> String {
    if let body = request.httpBody { return String(decoding: body, as: UTF8.self) }
    guard let stream = request.httpBodyStream else { return "" }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return String(decoding: data, as: UTF8.self)
}

/// What reached the wire: the method, the path and the body.
private final class ShareDoorRecorder: @unchecked Sendable {
    struct Sent: Equatable {
        let method: String?
        let path: String?
        let body: String
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        let sent = Sent(method: request.httpMethod, path: request.url?.path, body: sentBody(request))
        lock.lock()
        storage.append(sent)
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// THE PANEL'S THREE DOORS, FOR EACH KIND OF ROOT. One panel serves a session, a task and a
/// project, so what differs between them is only the path each press goes to: read the link, open
/// or change it, turn it off — `GET | PUT | DELETE /{sessions|tasks|projects}/:id/share`
/// (docs/share-links-design.md §5). The legacy `POST /sessions/:id/share` is not one of them.
final class ShareLinksAPIClientTests: XCTestCase {

    override func tearDown() {
        ShareDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ShareDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> ShareDoorRecorder {
        let recorder = ShareDoorRecorder()
        ShareDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    private static func link(kind: String, include: String) -> String {
        """
        {"id":"L1","kind":"\(kind)","token":"Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa","include":\(include),
         "expiresAt":null,"revokedAt":null,"viewCount":3,"lastViewedAt":null,
         "createdAt":"2026-09-25T04:00:00.000Z","updatedAt":"2026-09-25T04:00:00.000Z",
         "state":"ACTIVE","stateReason":null,"root":{"id":"r1","title":"Root","status":"OPEN"}}
        """
    }

    /// Settings → Shared links reads every link the account has made in one call, and turns off any
    /// number of them in another — the web page's two doors (`listShareLinks`, `turnOffShareLinks`).
    func testTheAccountsLinksAreOneReadAndTurningThemOffIsOnePost() async throws {
        let one = Self.link(kind: "SESSION", include: #"{"toolOutput":true}"#)
        let listed = answer("{\"links\":[\(one)]}")
        let links = try await client().shareLinks()
        XCTAssertEqual(links.map(\.id), ["L1"])
        XCTAssertEqual(links.first?.state, .active)
        XCTAssertEqual(listed.sent, [.init(method: "GET", path: "/api/share-links", body: "")])

        let turned = answer(#"{"count":2}"#)
        let count = try await client().turnOffShareLinks(["L1", "L2"])
        XCTAssertEqual(count, 2)
        XCTAssertEqual(turned.sent, [
            .init(method: "POST", path: "/api/share-links/turn-off", body: #"{"shareLinkIds":["L1","L2"]}"#),
        ])
    }

    func testEachKindIsReadAtItsOwnPath() async throws {
        let recorder = answer(#"{"link":null,"counts":{"tasks":12,"comments":29,"files":0,"runs":13,"transcripts":14}}"#)
        let api = client()
        let project = try await api.shareLink(.project, "34UonbgOiq9ajX8aH3JPz")
        _ = try await api.shareLink(.task, "34UozoiaJIsxCZj728bfe")
        _ = try await api.shareLink(.session, "244BxBMw6XOK2rqknTjz2S")
        XCTAssertNil(project.link)
        XCTAssertEqual(project.counts?.transcripts, 14)
        XCTAssertEqual(recorder.sent, [
            .init(method: "GET", path: "/api/projects/34UonbgOiq9ajX8aH3JPz/share", body: ""),
            .init(method: "GET", path: "/api/tasks/34UozoiaJIsxCZj728bfe/share", body: ""),
            .init(method: "GET", path: "/api/sessions/244BxBMw6XOK2rqknTjz2S/share", body: ""),
        ])
    }

    func testASwitchIsOnePutOfItsOwnLayerAnsweredByTheLink() async throws {
        let recorder = answer(Self.link(kind: "TASK", include:
            #"{"commentsAndFiles":false,"conversations":true,"toolOutput":true}"#))
        var panel = SharePanel(kind: .task)
        let link = try await client().putShareLink(.task, "t1", panel.toggle(.conversations, on: true))
        XCTAssertEqual(link.include.conversations, true)
        XCTAssertEqual(recorder.sent, [
            .init(method: "PUT", path: "/api/tasks/t1/share", body: #"{"include":{"conversations":true}}"#),
        ])
    }

    func testOpeningAProjectLinkIsAnEmptyPut() async throws {
        let recorder = answer(Self.link(kind: "PROJECT", include:
            #"{"taskPages":true,"commentsAndFiles":false,"conversations":false,"toolOutput":true}"#))
        guard case .open(let body) = SharePanel(kind: .project).step(to: .anyoneWithTheLink) else {
            return XCTFail("choosing Anyone with the link opens a link")
        }
        let link = try await client().putShareLink(.project, "p1", body)
        XCTAssertEqual(link.kind, .project)
        XCTAssertEqual(recorder.sent, [.init(method: "PUT", path: "/api/projects/p1/share", body: "{}")])
    }

    func testNeverIsAnExplicitNullOnTheSessionsDoor() async throws {
        let recorder = answer(Self.link(kind: "SESSION", include: #"{"toolOutput":true}"#))
        var panel = SharePanel(kind: .session)
        let body = try XCTUnwrap(panel.chooseExpiry("never", now: Date()))
        _ = try await client().putShareLink(.session, "s1", body)
        XCTAssertEqual(recorder.sent, [
            .init(method: "PUT", path: "/api/sessions/s1/share", body: #"{"expiresAt":null}"#),
        ])
    }

    func testTurningOffIsADeleteAtTheRootsPath() async throws {
        let recorder = answer("")
        let api = client()
        try await api.turnOffShareLink(.task, "t1")
        try await api.turnOffShareLink(.project, "p1")
        try await api.turnOffShareLink(.session, "s1")
        XCTAssertEqual(recorder.sent.map { "\($0.method ?? "") \($0.path ?? "")" }, [
            "DELETE /api/tasks/t1/share", "DELETE /api/projects/p1/share", "DELETE /api/sessions/s1/share",
        ])
    }

    func testARefusalSurfacesAsTheServersAnswer() async throws {
        _ = answer(#"{"message":"this session is in the trash — restore it before sharing it","statusCode":409}"#,
                   status: 409)
        do {
            _ = try await client().putShareLink(.session, "s1", PutShareLinkRequest())
            XCTFail("a 409 is not a link")
        } catch APIError.http(let status, let body) {
            XCTAssertEqual(status, 409)
            XCTAssertTrue(body?.contains("in the trash") == true)
        }
    }
}
