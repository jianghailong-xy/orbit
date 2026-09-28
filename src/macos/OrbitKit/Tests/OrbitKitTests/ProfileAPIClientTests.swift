import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class ProfileURLProtocol: URLProtocol, @unchecked Sendable {
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

/// What reached the wire: the method, the path and the body. URLProtocol hands the body over as
/// `httpBodyStream`, so it is read off the stream when `httpBody` is gone.
private final class ProfileRecorder: @unchecked Sendable {
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
        lock.lock()
        storage.append("\(request.httpMethod ?? "") \(request.url?.path ?? "") \(body)")
        lock.unlock()
    }

    var sent: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// Settings' edit-profile card renames the account with one PATCH of `users/me`, and the account the
/// server answers with is the one the app goes on showing.
final class ProfileAPIClientTests: XCTestCase {
    override func tearDown() {
        ProfileURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testRenamingIsOnePatchOfTheAccountAndAnswersWithIt() async throws {
        let recorder = ProfileRecorder()
        ProfileURLProtocol.handler = { request in
            recorder.append(request)
            return (200, Data(#"""
            {"id":"u1","email":"owner@example.test","name":"Hailong Jiang","role":"ADMIN",
             "createdAt":"2026-09-01T00:00:00.000Z","preferences":{"theme":"light"}}
            """#.utf8))
        }

        let user = try await client().updateProfile(UpdateProfileRequest(name: "Hailong Jiang"))

        XCTAssertEqual(recorder.sent, [#"PATCH /api/users/me {"name":"Hailong Jiang"}"#])
        XCTAssertEqual(user.name, "Hailong Jiang")
        XCTAssertEqual(user.email, "owner@example.test")
        XCTAssertEqual(user.preferences?.theme, "light", "the answer is the whole account, as `me` reads it")
    }

    /// A refusal comes back in the server's own words, which is what the card shows under the field.
    func testARefusedNameSaysWhyInTheServersWords() async throws {
        ProfileURLProtocol.handler = { _ in
            (400, Data(#"{"statusCode":400,"message":"name must not be empty","error":"Bad Request"}"#.utf8))
        }

        do {
            _ = try await client().updateProfile(UpdateProfileRequest(name: " "))
            XCTFail("a refused rename returned an account")
        } catch {
            XCTAssertEqual(SettingsCopy.nameNotSaved(APIClient.failureReason(error)),
                           "Couldn't save your name — name must not be empty.")
        }
    }
}
