import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers as the door does.
private final class CrossingDoorURLProtocol: URLProtocol, @unchecked Sendable {
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
private func sentBody(_ request: URLRequest) -> Data {
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

/// What reached the wire: the method, the path, and the body as the server's JSON parser sees it.
private final class CrossingDoorRecorder: @unchecked Sendable {
    struct Sent {
        let method: String?
        let path: String?
        let body: [String: Any]
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        let body = (try? JSONSerialization.jsonObject(with: sentBody(request))) as? [String: Any]
        lock.lock()
        storage.append(Sent(method: request.httpMethod, path: request.url?.path, body: body ?? [:]))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// THE PROJECT PAGE'S CROSSINGS: ONE READ, AND ONE DOOR FOR EVERY ANSWER.
///
/// The read is `GET /projects/:id/handoffs`, both directions. The answer — a yes to a move included —
/// is `POST /projects/:id/handoffs/:handoffId/decision`: the door at which the server moves the task
/// and spends the request in one write (`ProjectHandoffService.decide` → `applyMoveApproval`). So
/// what is pinned is the door a confirmed move reaches, its body (the answer and the crossing key
/// it was given on, nothing else), and that a refusal comes back as the door's own code and reason.
final class ProjectCrossingsDoorTests: XCTestCase {

    private static let key = String(repeating: "c", count: 64)

    override func tearDown() {
        CrossingDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CrossingDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func answer(_ json: String, status: Int = 200) -> CrossingDoorRecorder {
        let recorder = CrossingDoorRecorder()
        CrossingDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (status, Data(json.utf8))
        }
        return recorder
    }

    private func move() -> ProjectCrossing {
        ProjectCrossing(id: "0195c0de-0000-7000-8000-0000000000f1", publicId: "34bMoveRow",
                        fromProjectId: "34bFrom", fromProjectPublicId: "34bFrom",
                        toProjectId: "34bTo", toProjectPublicId: "34bTo",
                        fromProject: ProjectCrossing.ProjectEnd(title: "Coordinator control loop", status: "DONE"),
                        toProject: ProjectCrossing.ProjectEnd(title: "Runner hardening", status: "OPEN"),
                        kind: "MOVE_TASK", subjectTaskId: "34bMovedTask", subjectTaskPublicId: "34bMovedTask",
                        subjectTask: ProjectCrossing.SubjectTask(id: "34bMovedTask", title: "Wire the drain watchdog"),
                        crossingKey: Self.key, state: "PENDING", title: "Wire the drain watchdog",
                        requestedAt: "2026-10-06T09:00:00.000Z")
    }

    func testTheProjectsCrossingsAreOneRead() async throws {
        let recorder = answer("""
        [{"id":"34bMoveRow","publicId":"34bMoveRow","fromProjectId":"34bFrom","toProjectId":"34bTo",
          "kind":"MOVE_TASK","subjectTaskId":"34bMovedTask","crossingKey":"\(Self.key)","state":"PENDING",
          "title":"Wire the drain watchdog","reason":null,"requestedAt":"2026-10-06T09:00:00.000Z",
          "decidedAt":null,"expiresAt":null}]
        """)
        let rows = try await client().projectCrossings(projectID: "34bTo")
        XCTAssertEqual(rows.map(\.id), ["34bMoveRow"])
        XCTAssertEqual(recorder.sent.map { "\($0.method ?? "") \($0.path ?? "")" }, ["GET /api/projects/34bTo/handoffs"])
    }

    /// Confirming a move goes to the decision door — the one that moves the task — addressed by the
    /// project the page shows and the request's own id, with the answer and the crossing key the
    /// row was read with. Nothing else travels, and no second write follows.
    func testConfirmingAMoveIsOnePostToTheDecisionDoorWithTheCrossingKey() async throws {
        let recorder = answer(#"{"row":{"id":"34bMoveRow","state":"APPLIED"},"filed":false}"#)
        try await client().decideProjectCrossing(projectID: "34bTo", crossing: move(), .approve)
        let sent = recorder.sent
        XCTAssertEqual(sent.count, 1, "one answer, one write")
        XCTAssertEqual(sent.first?.method, "POST")
        XCTAssertEqual(sent.first?.path, "/api/projects/34bTo/handoffs/34bMoveRow/decision")
        XCTAssertEqual(sent.first?.body.count, 2)
        XCTAssertEqual(sent.first?.body["decision"] as? String, "APPROVE")
        XCTAssertEqual(sent.first?.body["acknowledgedCrossingKey"] as? String, Self.key)
    }

    func testRefusingIsTheSameDoorWithDeny() async throws {
        let recorder = answer(#"{"row":{"id":"34bMoveRow","state":"DENIED"},"filed":false}"#)
        try await client().decideProjectCrossing(projectID: "34bFrom", crossing: move(), .deny)
        XCTAssertEqual(recorder.sent.first?.path, "/api/projects/34bFrom/handoffs/34bMoveRow/decision")
        XCTAssertEqual(recorder.sent.first?.body["decision"] as? String, "DENY")
        XCTAssertEqual(recorder.sent.first?.body["acknowledgedCrossingKey"] as? String, Self.key)
    }

    /// A confirmation refused while the task is being landed: nothing was written, the request still
    /// waits, and the card shows the door's code and its sentence.
    func testARefusedConfirmationSurfacesTheDoorsCodeAndReason() async throws {
        _ = answer(#"{"statusCode":409,"error":"Conflict","code":"MOVE_TASK_LANDING_IN_FLIGHT","#
                   + #""message":"task 34bMovedTask is being landed (LAND_TASK 34bJob is RUNNING) — nothing was written and the request is still waiting."}"#,
                   status: 409)
        do {
            try await client().decideProjectCrossing(projectID: "34bTo", crossing: move(), .approve)
            XCTFail("a 409 is not a confirmed move")
        } catch {
            let refusal = ProjectCrossings.refusal(error)
            XCTAssertEqual(refusal.code, "MOVE_TASK_LANDING_IN_FLIGHT")
            XCTAssertTrue(refusal.message.hasSuffix("nothing was written and the request is still waiting."))
        }
    }
}
