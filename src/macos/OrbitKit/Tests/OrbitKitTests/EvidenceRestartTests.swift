import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers as the restart door would.
private final class RestartDoorURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class Sent: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(method: String?, path: String?, body: [String: Any])] = []

    func append(_ request: URLRequest) {
        let body = (try? JSONSerialization.jsonObject(with: sentBody(request))) as? [String: Any]
        lock.lock()
        storage.append((request.httpMethod, request.url?.path, body ?? [:]))
        lock.unlock()
    }

    var all: [(method: String?, path: String?, body: [String: Any])] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// RESTART THE TASK ON THE OWNER'S EVIDENCE CARD (evidence-always-has-an-addressee §3, D2 = A).
///
/// What is pinned: the pending row decodes with `ownerAction` / `decidability.addressee` and without
/// them (a server older than the field), a delivered card derives the restart offer from the read
/// and from nothing else, and the press is one POST to the restart door with the Run press's name.
final class EvidenceRestartTests: XCTestCase {

    override func tearDown() {
        RestartDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RestartDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private static let task = "34vcF5TXYgAVx3dCr6pnS"
    private static let session = "34w8n4fPauzw4a2i7dfX5"
    private static let project = "34vcDOhN0OCStfnVuTyPq"

    /// One row as the server writes it, with or without the two fields this feature added.
    private static func rowJSON(ownerAction: String?, addressee: String?) -> String {
        let action = ownerAction.map { "\"ownerAction\":\"\($0)\"," } ?? ""
        let to = addressee.map { ",\"addressee\":\"\($0)\"" } ?? ""
        return """
            {"taskId":"\(task)","title":"Fix the login redirect","status":"OPEN",
             "projectId":"\(project)","criterion":null,"evidenceRevision":"1",
             "submittedAt":"2026-11-12T03:12:00.000Z","ageSeconds":13560,
             "claim":"The redirect keeps the path.","gaps":[],"gapClauses":[],"citations":[],
             "decidability":{"decidable":false,
               "refusal":"the standard this revision was judged against was reworded after it was submitted",
               "requiredAction":"SUBMIT_EVIDENCE_AGAIN"\(to)},
             "independence":{"independent":true,"disqualification":null,"requiredAction":null},
             \(action)
             "ownerCard":null}
            """
    }

    private static func queue(waitingOnYou: [String], pending: [String] = []) throws -> EvidenceDecisionQueue {
        let json = """
            {"decidingSessionId":"\(session)","count":\(pending.count),"oldestAgeSeconds":null,
             "pending":[\(pending.joined(separator: ","))],
             "waitingOnYou":[\(waitingOnYou.joined(separator: ","))],
             "waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}
            """
        return try JSONDecoder().decode(EvidenceDecisionQueue.self, from: Data(json.utf8))
    }

    // MARK: decoding

    func testARowCarryingTheActionDecodesItAndItsAddressee() throws {
        let queue = try Self.queue(waitingOnYou: [Self.rowJSON(ownerAction: "RESTART_TASK", addressee: "OWNER")])
        let row = try XCTUnwrap(queue.waitingOnYou.first)
        XCTAssertEqual(row.ownerAction, "RESTART_TASK")
        XCTAssertEqual(row.decidability.addressee, "OWNER")
        XCTAssertTrue(EvidenceRestart.offers(row))
        XCTAssertEqual(EvidenceRestart.rows(queue: queue).map(\.id), ["\(Self.task)#1"])
    }

    /// A server older than the field sends neither key: the row reads as before, and offers nothing.
    func testARowWithoutTheFieldDecodesAsNoAction() throws {
        let queue = try Self.queue(waitingOnYou: [Self.rowJSON(ownerAction: nil, addressee: nil)])
        let row = try XCTUnwrap(queue.waitingOnYou.first)
        XCTAssertNil(row.ownerAction)
        XCTAssertNil(row.decidability.addressee)
        XCTAssertFalse(EvidenceRestart.offers(row))
        XCTAssertTrue(EvidenceRestart.rows(queue: queue).isEmpty)
        let standing = EvidenceDecisions.standing(queue: queue, projectId: Self.project,
                                                  sessionId: Self.session, taskId: Self.task,
                                                  evidenceRevision: "1")
        XCTAssertNil(standing.restartRow, "no action on the row, no restart offer on the card")
    }

    /// An explicit null and an action this build does not know read the same as no action — and
    /// neither fails the queue, which would take every pending card down with it.
    func testANullOrUnknownActionOffersNothingAndKeepsTheQueue() throws {
        let unknown = Self.rowJSON(ownerAction: "SOMETHING_NEWER", addressee: "OWNER")
        let null = Self.rowJSON(ownerAction: nil, addressee: "RUN")
            .replacingOccurrences(of: "\"ownerCard\":null", with: "\"ownerAction\":null,\"ownerCard\":null")
        let queue = try Self.queue(waitingOnYou: [unknown, null])
        XCTAssertEqual(queue.waitingOnYou.count, 2)
        XCTAssertEqual(queue.waitingOnYou.last?.decidability.addressee, "RUN")
        XCTAssertTrue(EvidenceRestart.rows(queue: queue).isEmpty)
    }

    // MARK: the card's standing

    func testTheCardAtTheRowsAddressOffersRestartAndIsNoDecision() throws {
        let queue = try Self.queue(waitingOnYou: [Self.rowJSON(ownerAction: "RESTART_TASK", addressee: "OWNER")])
        let standing = EvidenceDecisions.standing(queue: queue, projectId: Self.project,
                                                  sessionId: Self.session, taskId: Self.task,
                                                  evidenceRevision: "1")
        XCTAssertEqual(standing.restartRow?.taskId, Self.task)
        XCTAssertNil(standing.row, "Confirm done and Send back stay dead: no decision can be recorded")
        XCTAssertFalse(standing.answerable)
        XCTAssertTrue(EvidenceDecisions.isOpen(standing), "the owner is being asked to act")
        XCTAssertFalse(EvidenceDecisions.holdsReply(standing), "there is nothing to send back")
        XCTAssertFalse(EvidenceDecisions.letsGo(standing, engaged: false))
        XCTAssertEqual(EvidenceDecisions.heading(standing), EvidenceRestart.heading)
        XCTAssertNil(EvidenceDecisions.staleExplanation(standing))
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue, projectId: Self.project,
                                                 sessionId: Self.session).isEmpty,
                      "an undecidable row never becomes a decision card")
    }

    /// Once the read no longer offers it — the task was restarted, here or elsewhere — the card
    /// reads as answered and lets go, the way a decided card does.
    func testTheOfferGoesWhenTheReadDropsIt() throws {
        let queue = try Self.queue(waitingOnYou: [])
        let standing = EvidenceDecisions.standing(queue: queue, projectId: Self.project,
                                                  sessionId: Self.session, taskId: Self.task,
                                                  evidenceRevision: "1")
        XCTAssertNil(standing.restartRow)
        XCTAssertEqual(standing.state, .alreadyDecided)
    }

    // MARK: the press

    func testThePressPostsTheRunPressNameToTheRestartDoor() async throws {
        let sent = Sent()
        RestartDoorURLProtocol.handler = { request in
            sent.append(request)
            return (201, Data("""
                {"taskId":"34vcF5TXYgAVx3dCr6pnS","evidenceRevision":"1","action":"RESTART_TASK",
                 "started":{"sessionId":"27H8nETlJtxEZoAYg6dTj5"}}
                """.utf8))
        }
        let result = try await client().restartTaskFromEvidence(
            taskID: Self.task, evidenceRevision: "1", triggerId: "34wTriggerPressAAAAAAA")

        XCTAssertEqual(sent.all.count, 1, "one press is one request")
        let first = try XCTUnwrap(sent.all.first)
        XCTAssertEqual(first.method, "POST")
        XCTAssertEqual(first.path, "/api/tasks/34vcF5TXYgAVx3dCr6pnS/evidence/1/restart")
        XCTAssertEqual(Set(first.body.keys), ["triggerId"])
        XCTAssertEqual(first.body["triggerId"] as? String, "34wTriggerPressAAAAAAA")
        XCTAssertEqual(result, EvidenceRestartResult(taskId: Self.task, evidenceRevision: "1",
                                                     action: "RESTART_TASK"))
    }

    /// A press that is no longer offered is said as out of date, with the server's own reason.
    func testANotOfferedRefusalReadsAsOutOfDate() async throws {
        RestartDoorURLProtocol.handler = { _ in
            (409, Data("""
                {"statusCode":409,"code":"EVIDENCE_RESTART_NOT_OFFERED",
                 "requiredAction":"READ_THE_PENDING_EVIDENCE_AGAIN",
                 "message":"a run of this task is live and has been told to submit the revision again; nothing was started"}
                """.utf8))
        }
        do {
            _ = try await client().restartTaskFromEvidence(taskID: Self.task, evidenceRevision: "1",
                                                           triggerId: "34wTriggerPressAAAAAAA")
            XCTFail("a 409 is a refusal")
        } catch {
            XCTAssertTrue(EvidenceRestart.isNotOffered(error))
            XCTAssertEqual(EvidenceRestart.refusalTitle(error), EvidenceRestart.stale)
            XCTAssertEqual(APIClient.failureReason(error),
                           "a run of this task is live and has been told to submit the revision again; nothing was started")
        }
    }

    func testAnyOtherFailureIsAPlainRefusal() {
        let other = APIError.http(status: 409, body: #"{"code":"TASK_RUN_REQUEST_MISMATCH"}"#)
        XCTAssertFalse(EvidenceRestart.isNotOffered(other))
        XCTAssertEqual(EvidenceRestart.refusalTitle(other), EvidenceRestart.refused)
        XCTAssertEqual(EvidenceRestart.refusalTitle(URLError(.timedOut)), EvidenceRestart.refused)
    }
}
