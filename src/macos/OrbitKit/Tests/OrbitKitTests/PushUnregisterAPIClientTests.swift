import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class PushUnregisterURLProtocol: URLProtocol, @unchecked Sendable {
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

/// What reached the wire: the method, the path, the bearer and the body. URLProtocol hands the body
/// over as `httpBodyStream`, so it is read off the stream when `httpBody` is gone.
private final class PushUnregisterRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ request: URLRequest) {
        var body = request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(contentsOf: buffer[0..<read])
            }
            stream.close()
            body = String(decoding: data, as: UTF8.self)
        }
        let bearer = request.value(forHTTPHeaderField: "Authorization") ?? "(no bearer)"
        lock.lock()
        storage.append("\(request.httpMethod ?? "") \(request.url?.path ?? "") \(bearer) \(body)")
        lock.unlock()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// Signing out on iOS drops the device's APNs registration (`POST /push/unregister`), or the server
/// goes on pushing to a signed-out phone — iOS draws those alerts itself. The request goes out after
/// `logout` has cleared the store, so it carries the access token it was handed.
final class PushUnregisterAPIClientTests: XCTestCase {
    // A host of its own: the process-wide refresher is per host, and a refresh must reach this stub.
    private let baseURL = URL(string: "https://push-unregister.test")!

    override func tearDown() {
        PushUnregisterURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(_ store: TokenStore) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushUnregisterURLProtocol.self]
        return APIClient(baseURL: baseURL, tokenStore: store, session: URLSession(configuration: configuration))
    }

    func testSignOutUnregistersWithTheAccessTokenItWasHanded() async {
        let recorder = PushUnregisterRecorder()
        PushUnregisterURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"{"ok":true}"#.utf8))
        }

        // The store is already empty: signed out.
        await client(InMemoryTokenStore()).unregisterDeviceToken(token: "a1b2c3", accessToken: "signed-out-access")

        XCTAssertEqual(recorder.sent, [#"POST /api/push/unregister Bearer signed-out-access {"token":"a1b2c3"}"#])
    }

    /// By the time a refusal comes back the store may hold the next sign-in's session: refreshing it
    /// and asking again would take the device off that account instead.
    func testARefusedUnregisterIsNotRefreshed() async {
        let recorder = PushUnregisterRecorder()
        PushUnregisterURLProtocol.handler = { request in
            recorder.append(request)
            return (401, Data(#"{"statusCode":401,"message":"Unauthorized"}"#.utf8))
        }
        let store = InMemoryTokenStore()
        store.setToken("next-access", for: baseURL)
        store.setRefreshToken("next-refresh", for: baseURL)

        await client(store).unregisterDeviceToken(token: "a1b2c3", accessToken: "expired-access")

        XCTAssertEqual(recorder.sent, [#"POST /api/push/unregister Bearer expired-access {"token":"a1b2c3"}"#])
        XCTAssertEqual(store.token(for: baseURL), "next-access")
        XCTAssertEqual(store.refreshToken(for: baseURL), "next-refresh")
    }
}
