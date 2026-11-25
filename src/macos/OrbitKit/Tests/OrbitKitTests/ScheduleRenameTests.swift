import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class RenameURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> Data)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let body = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class RenameSeenRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var held: (method: String?, path: String?, body: Data)?

    func record(_ request: URLRequest) {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        lock.lock()
        defer { lock.unlock() }
        held = (request.httpMethod, request.url?.path, body)
    }

    var request: (method: String?, path: String?, body: Data)? {
        lock.lock()
        defer { lock.unlock() }
        return held
    }
}

/// Rename (docs/scheduled-tasks-design.md §8.4): `POST /schedules/:id/rename {title}`, answered as Undo is, and the
/// history line and field rules the clients share with the web.
final class ScheduleRenameTests: XCTestCase {
    override func tearDown() {
        RenameURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RenameURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    private let schedule = """
    {"id":"s1","title":"US app 1070 data readiness","intent":"Check yesterday's data.","state":"ACTIVE",\
    "workspaceId":"w1","rule":{"kind":"DAILY","time":"09:07"},"timezone":"Asia/Singapore",\
    "accessLevel":"CHECK_ONLY","envelope":{"accessLevel":"CHECK_ONLY","runsPerWeek":7,"runLimitMinutes":30},\
    "revision":2}
    """

    func testRenamePostsTheTitleAloneAndDecodesTheAnswer() async throws {
        let seen = RenameSeenRequest()
        let answer = #"{"outcome":"APPLIED","changed":true,"note":"Recorded.","schedule":\#(schedule),"record":{}}"#
        RenameURLProtocol.handler = { request in
            seen.record(request)
            return Data(answer.utf8)
        }
        let renamed = try await client().renameSchedule("s1", title: "US app 1070 data readiness")
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/schedules/s1/rename")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: String])
        XCTAssertEqual(body, ["title": "US app 1070 data readiness"])
        XCTAssertEqual(renamed.outcome, "APPLIED")
        XCTAssertEqual(renamed.schedule?.title, "US app 1070 data readiness")
        XCTAssertNil(renamed.card)
    }

    func testAnUnchangedTitleAnswersUnchanged() async throws {
        let answer = #"{"outcome":"UNCHANGED","changed":false,"schedule":\#(schedule)}"#
        RenameURLProtocol.handler = { _ in Data(answer.utf8) }
        let renamed = try await client().renameSchedule("s1", title: "US app 1070 data readiness")
        XCTAssertEqual(renamed.outcome, "UNCHANGED")
        XCTAssertEqual(renamed.schedule?.id, "s1")
    }

    private func record(by: String, before: [String: JSONValue]?, after: [String: JSONValue]) -> ScheduleChangeRecord {
        ScheduleChangeRecord(scheduleId: "s1", title: "New", revision: 2, changedBy: by, before: before, after: after)
    }

    func testAPersonsRenameReadsRenamedFrom() {
        let renamed = record(by: "USER", before: ["title": .string("Codex check")], after: ["title": .string("New")])
        XCTAssertEqual(ScheduleDisplay.renamedText(renamed), "Renamed from “Codex check”")
    }

    func testOtherRecordsKeepTheirOwnLine() {
        let title: [String: JSONValue] = ["title": .string("Codex check")]
        XCTAssertNil(ScheduleDisplay.renamedText(record(by: "SESSION", before: title, after: ["title": .string("New")])))
        XCTAssertNil(ScheduleDisplay.renamedText(record(by: "USER", before: title,
                                                        after: ["title": .string("New"), "prompt": .string("p")])))
        XCTAssertNil(ScheduleDisplay.renamedText(record(by: "USER", before: nil, after: ["title": .string("New")])))
    }

    func testTheFieldSavesOnlyATrimmedNewName() {
        XCTAssertEqual(ScheduleDisplay.renameTitle("  Data readiness ", from: "Old"), "Data readiness")
        XCTAssertNil(ScheduleDisplay.renameTitle("   ", from: "Old"))
        XCTAssertNil(ScheduleDisplay.renameTitle(" Old ", from: "Old"))
    }
}
