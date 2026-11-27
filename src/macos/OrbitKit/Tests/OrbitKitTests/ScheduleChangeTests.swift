import Foundation
import XCTest
@testable import OrbitKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class ScheduleChangeURLProtocol: URLProtocol, @unchecked Sendable {
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

/// What reached the wire: the method, the path, and the body as a JSON object (nil when empty).
private final class ScheduleChangeRecorder: @unchecked Sendable {
    struct Sent {
        let method: String?
        let path: String?
        let body: [String: Any]?
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(contentsOf: buffer[0..<read])
            }
        }
        let body = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        lock.lock()
        storage.append(Sent(method: request.httpMethod, path: request.url?.path, body: body))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// A schedule's change conversation (docs/scheduled-tasks-design.md §8.2, board 03-change): the two doors
/// (`GET/POST /schedules/:id/change`), the opening carried by `GET /sessions/:id/schedule-cards`, and the
/// record's `askedText`.
final class ScheduleChangeTests: XCTestCase {
    override func tearDown() {
        ScheduleChangeURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScheduleChangeURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> ScheduleChangeRecorder {
        let recorder = ScheduleChangeRecorder()
        ScheduleChangeURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    private static let openingJSON = #"""
    {"scheduleId":"sch1","title":"Codex stable check","revision":3,
     "does":"Checks the latest stable Codex against the pinned version, opens a PR when there is a new one",
     "when":"Every day at 09:00 · Asia/Shanghai","runsIn":"apiserver · Codex agent",
     "may":"Open a PR","costs":"Up to 7 runs a week, 30 min each"}
    """#

    func testChangeReadNamesTheOpenConversationOrTheOpeningANewOneStartsWith() async throws {
        var recorder = answer(#"{"sessionId":"sess9","opening":\#(Self.openingJSON)}"#)
        var read = try await client().scheduleChangeConversation("sch1")
        XCTAssertEqual(read.sessionId, "sess9")
        XCTAssertEqual(recorder.sent.map(\.method), ["GET"])
        XCTAssertEqual(recorder.sent.map(\.path), ["/api/schedules/sch1/change"])

        recorder = answer(#"{"sessionId":null,"opening":\#(Self.openingJSON)}"#)
        read = try await client().scheduleChangeConversation("sch1")
        XCTAssertNil(read.sessionId)
        let opening = read.opening
        XCTAssertEqual(opening.scheduleId, "sch1")
        XCTAssertEqual(opening.title, "Codex stable check")
        XCTAssertEqual(opening.revision, 3)
        XCTAssertEqual(opening.when, "Every day at 09:00 · Asia/Shanghai")
        XCTAssertEqual(opening.costs, "Up to 7 runs a week, 30 min each")
    }

    func testChangeOpenPostsTheWordsAndAnswersCreated() async throws {
        var recorder = answer(#"{"sessionId":"sess9","created":true}"#)
        var opened = try await client().openScheduleChange("sch1", text: "weekdays at 8")
        XCTAssertEqual(opened, ScheduleChangeAnswer(sessionId: "sess9", created: true))
        XCTAssertEqual(recorder.sent.map(\.method), ["POST"])
        XCTAssertEqual(recorder.sent.map(\.path), ["/api/schedules/sch1/change"])
        XCTAssertEqual(recorder.sent.first?.body?["text"] as? String, "weekdays at 8")

        recorder = answer(#"{"sessionId":"sess7","created":false}"#)
        opened = try await client().openScheduleChange("sch1", text: "weekdays at 8")
        XCTAssertEqual(opened, ScheduleChangeAnswer(sessionId: "sess7", created: false))
    }

    func testSessionScheduleCardsCarriesTheOpeningOnAChangeConversation() throws {
        let json = #"{"run":null,"cards":[],"records":[],"change":\#(Self.openingJSON)}"#
        let read = try JSONDecoder().decode(SessionScheduleCardsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(read.change?.title, "Codex stable check")
        XCTAssertEqual(read.change?.may, "Open a PR")

        let plain = try JSONDecoder().decode(SessionScheduleCardsResponse.self,
                                             from: Data(#"{"run":null,"cards":[],"records":[]}"#.utf8))
        XCTAssertNil(plain.change)
    }

    func testChangeRecordCarriesThePersonsWords() throws {
        let json = #"""
        {"scheduleId":"sch1","title":"Codex stable check","revision":4,"changedBy":"USER",
         "sessionId":"sess9","before":{},"after":{"rule":{"kind":"DAILY","time":"08:00"}},
         "askedText":"改成工作日早上 8 点","createdAt":"2026-11-19T07:02:00.000Z","undo":null}
        """#
        let record = try JSONDecoder().decode(ScheduleChangeRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.askedText, "改成工作日早上 8 点")
        XCTAssertEqual(record.sessionId, "sess9")
        XCTAssertEqual(record.changedBy, "USER")

        let older = try JSONDecoder().decode(ScheduleChangeRecord.self, from: Data(#"""
        {"scheduleId":"sch1","title":"Codex stable check","revision":2,"changedBy":"SESSION",
         "before":{},"after":{},"createdAt":"2026-11-18T10:00:00.000Z","undo":null}
        """#.utf8))
        XCTAssertNil(older.askedText)
    }

    /// The opening's rows, in order, as label and text — the shared `scheduleChangeOpeningRows`.
    func testChangeOpeningRows() throws {
        let opening = try JSONDecoder().decode(ScheduleChangeConversationResponse.self,
                                               from: Data(#"{"sessionId":null,"opening":\#(Self.openingJSON)}"#.utf8)).opening
        XCTAssertEqual(ScheduleDisplay.changeOpeningRows(opening).map(\.label),
                       [ScheduleCopy.ChangeConversation.does, ScheduleCopy.ChangeConversation.when,
                        ScheduleCopy.ChangeConversation.runsIn, ScheduleCopy.ChangeConversation.may,
                        ScheduleCopy.ChangeConversation.costs])
        XCTAssertEqual(ScheduleDisplay.changeOpeningRows(opening).map(\.text),
                       [opening.does, opening.when, opening.runsIn, opening.may, opening.costs])
        XCTAssertEqual(ScheduleDisplay.changeConversationTitle(opening.title), "Change Codex stable check")
        XCTAssertEqual(ScheduleDisplay.changeConversationLead(opening.title),
                       "What should change about Codex stable check? This is what it does now:")
    }
}
