import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers with the door's receipt.
private final class EvidenceDoorURLProtocol: URLProtocol, @unchecked Sendable {
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
private final class DoorRecorder: @unchecked Sendable {
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

/// THE EVIDENCE CARD'S PRESS GOES STRAIGHT TO THE DECISION DOOR — WHAT IT SENDS, AND WHEN IT MAY.
///
/// The card no longer answers through an AskUserQuestion: a press is one
/// `POST /tasks/:taskId/evidence/decision` with this device's own credential. So the things worth
/// pinning are the ones the door holds a client to — the path, the three bindings in the body and
/// nothing else on a confirm, a send-back that carries no reason never becoming a request — and the
/// four standings a delivered card derives from the pending read, which are the only thing that
/// says whether its buttons may be pressed at all.
final class EvidenceDecisionDoorTests: XCTestCase {

    override func tearDown() {
        EvidenceDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EvidenceDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    // MARK: fixtures

    private static let project = "34JdnRJOxuG05yi0TpLq4"
    private static let decidingSession = "34JbyLO3TvHgOmBBHLgZu"

    private func row(taskId: String = "34LMiluvx0jK63cj8arWl",
                     revision: String = "3",
                     projectId: String? = EvidenceDecisionDoorTests.project,
                     decidable: Bool = true,
                     independent: Bool = true) -> EvidenceDecisionRow {
        EvidenceDecisionRow(
            taskId: taskId, title: "改掉 update() 的头注释", projectId: projectId,
            criterion: EvidenceDecisionCriterion(key: "6KG2mjp63PrtVvGwxRLvFY",
                                                 text: "提交一条完成证据后…"),
            evidenceRevision: revision, ageSeconds: 1200, claim: "改掉了头注释。",
            gaps: ["没跑 pg spec"], citations: [],
            decidability: EvidenceDecisionDecidability(
                decidable: decidable,
                refusal: decidable ? nil : "EVIDENCE_JUDGMENT_CRITERION_NOT_LIVE"),
            independence: EvidenceDecisionIndependence(
                independent: independent,
                disqualification: independent ? nil : "这条会话提交过这次证据"))
    }

    private func queue(_ rows: [EvidenceDecisionRow]) -> EvidenceDecisionQueue {
        EvidenceDecisionQueue(decidingSessionId: Self.decidingSession, count: rows.count,
                              pending: rows)
    }

    private func standing(_ rows: [EvidenceDecisionRow]?, revision: String = "3",
                          taskId: String = "34LMiluvx0jK63cj8arWl") -> EvidenceDecisionStanding {
        EvidenceDecisions.standing(queue: rows.map(queue), projectId: Self.project,
                                   taskId: taskId, evidenceRevision: revision)
    }

    /// The door's receipt as it answers: a whole `TaskEvidenceDecisionDto`, of which the card reads
    /// five fields.
    private static func receipt(decision: String, note: String?) -> Data {
        let noteJSON = note.map { "\"\($0)\"" } ?? "null"
        return Data("""
            {"id":"4d3N0t5l0tXkqz3cYbG7aB","taskId":"34LMiluvx0jK63cj8arWl",
             "evidenceId":"1b8LqB9oZkXyq0vW5nC2dE","evidenceRevision":"3","criterionRevision":"1",
             "evidenceDigest":"9f2c41d0","decision":"\(decision)","note":\(noteJSON),
             "decidedAt":"2026-09-10T16:00:00.000Z","decidedByType":"USER",
             "decidedById":"2p7QMFOwEGtL5oaTxZHihm","decidingSessionId":"34JbyLO3TvHgOmBBHLgZu"}
            """.utf8)
    }

    // MARK: 1 — what one press sends

    /// `确认完成` is one POST to the task's own decision door, and its body is the three bindings and
    /// nothing else — a note handed to a confirm is not sent, because the door takes a reason with a
    /// send-back only.
    func testConfirmPostsTheThreeBindingsToTheTasksDecisionDoor() async throws {
        let recorder = DoorRecorder()
        EvidenceDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (201, EvidenceDecisionDoorTests.receipt(decision: "CONFIRM", note: nil))
        }
        let pending = row()
        let request = try XCTUnwrap(EvidenceDecisions.request(
            row: pending, decision: .confirm, note: "a confirm carries no reason",
            decidingSessionID: Self.decidingSession))

        let result = try await client().decideEvidence(taskID: pending.taskId, request)

        XCTAssertEqual(recorder.sent.count, 1, "one press is one request")
        let sent = try XCTUnwrap(recorder.sent.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/tasks/34LMiluvx0jK63cj8arWl/evidence/decision")
        XCTAssertEqual(Set(sent.body.keys), ["decidingSessionId", "evidenceRevision", "decision"])
        XCTAssertEqual(sent.body["decidingSessionId"] as? String, "34JbyLO3TvHgOmBBHLgZu",
                       "the answer is given FROM this session, which the door checks for independence")
        XCTAssertEqual(sent.body["evidenceRevision"] as? String, "3",
                       "the revision read, as the decimal string the door compares against")
        XCTAssertEqual(sent.body["decision"] as? String, "CONFIRM")

        XCTAssertEqual(result.decision, .confirm)
        XCTAssertEqual(EvidenceDecisions.recordedLine(result), "已记下「确认完成」 · rev 3")
    }

    /// `退回` sends the same three bindings with the reason beside them, trimmed.
    func testSendBackPostsTheTrimmedReasonBesideTheThreeBindings() async throws {
        let recorder = DoorRecorder()
        EvidenceDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (201, EvidenceDecisionDoorTests.receipt(decision: "SEND_BACK",
                                                           note: "把 pg spec 跑一遍"))
        }
        let pending = row()
        let request = try XCTUnwrap(EvidenceDecisions.request(
            row: pending, decision: .sendBack, note: "  把 pg spec 跑一遍 \n",
            decidingSessionID: Self.decidingSession))

        let result = try await client().decideEvidence(taskID: pending.taskId, request)

        let sent = try XCTUnwrap(recorder.sent.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/tasks/34LMiluvx0jK63cj8arWl/evidence/decision")
        XCTAssertEqual(Set(sent.body.keys),
                       ["decidingSessionId", "evidenceRevision", "decision", "note"])
        XCTAssertEqual(sent.body["decidingSessionId"] as? String, "34JbyLO3TvHgOmBBHLgZu")
        XCTAssertEqual(sent.body["evidenceRevision"] as? String, "3")
        XCTAssertEqual(sent.body["decision"] as? String, "SEND_BACK")
        XCTAssertEqual(sent.body["note"] as? String, "把 pg spec 跑一遍")

        XCTAssertEqual(EvidenceDecisions.recordedLine(result),
                       "已记下「退回重做」 · rev 3：把 pg spec 跑一遍")
    }

    // MARK: 2 — a send-back without a reason is never sent

    /// The door refuses a SEND_BACK carrying no note and writes nothing at all, so there is no
    /// request to make: not for a missing reason, an empty one, or whitespace.
    func testASendBackWithoutAReasonIsNoRequest() {
        let pending = row()
        let reasonless: [String?] = [nil, "", "   \n\t "]
        for note in reasonless {
            XCTAssertNil(EvidenceDecisions.request(row: pending, decision: .sendBack, note: note,
                                                   decidingSessionID: Self.decidingSession),
                         "a send-back with note \(String(describing: note)) must not be sendable")
        }

        // And the control that would send one is dead by the same rule, until the moment there is
        // a reason — at which point the request carries exactly that reason.
        var box = EvidenceSendBackState(open: true)
        XCTAssertFalse(box.canSend, "an open box is not a reason")
        box.note = "  \n "
        XCTAssertFalse(box.canSend, "whitespace is not a reason either")
        box.note = " 把 pg spec 跑一遍 "
        XCTAssertTrue(box.canSend)
        XCTAssertEqual(EvidenceDecisions.request(row: pending, decision: .sendBack,
                                                 note: box.trimmedNote,
                                                 decidingSessionID: Self.decidingSession)?.note,
                       "把 pg spec 跑一遍")
    }

    // MARK: 3 — where a delivered card stands

    /// The revision is still in the read, and the read still says this session may answer it: the
    /// one standing whose buttons are live.
    func testARevisionStillInTheReadIsDecidable() {
        let pending = row()
        let now = standing([pending])

        XCTAssertEqual(now.state, .decidable(pending))
        XCTAssertEqual(now.row, pending)
        XCTAssertTrue(now.answerable)
        XCTAssertTrue(EvidenceDecisions.isOpen(now))
        XCTAssertEqual(EvidenceDecisions.heading(now), EvidenceDecisions.askHeading)
        XCTAssertNil(EvidenceDecisions.staleExplanation(now))
    }

    /// Gone from the read, and nothing later has taken its place: it was answered somewhere else.
    /// The card keeps its address, shows nothing else, and names the refusal a press would meet.
    func testARevisionThatLeftTheReadWasAlreadyDecided() {
        let now = standing([])

        XCTAssertEqual(now.state, .alreadyDecided)
        XCTAssertNil(now.row, "a stale card kept no copy of the evidence")
        XCTAssertFalse(now.answerable)
        XCTAssertFalse(EvidenceDecisions.isOpen(now), "and it is no longer counted as a question")
        XCTAssertEqual(EvidenceDecisions.heading(now), EvidenceDecisions.staleHeading)
        XCTAssertEqual(EvidenceDecisions.addressLine(now), "34LMiluvx0jK63cj8arWl · rev 3")
        XCTAssertTrue(EvidenceDecisions.staleExplanation(now)?
                        .contains("（EVIDENCE_JUDGMENT_ALREADY_DECIDED）") ?? false)
    }

    /// Gone, and the same task is in the read at a LATER revision: the door answers only the latest
    /// evidence, so this card is superseded. Revisions are compared as numbers — rev 10 comes after
    /// rev 9, which comparing the strings gets backwards — and an earlier revision is no replacement.
    func testARevisionDisplacedByALaterOneIsSuperseded() {
        let later = row(revision: "10")
        let now = standing([later], revision: "9")

        XCTAssertEqual(now.state, .superseded(replacement: later))
        XCTAssertFalse(now.answerable)
        XCTAssertFalse(EvidenceDecisions.isOpen(now))
        XCTAssertEqual(EvidenceDecisions.heading(now), EvidenceDecisions.staleHeading)
        let explanation = EvidenceDecisions.staleExplanation(now) ?? ""
        XCTAssertTrue(explanation.contains("又提交了第 10 版证据"), explanation)
        XCTAssertTrue(explanation.contains("对第 9 版的任何裁决都会被拒绝（EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED）"),
                      explanation)

        XCTAssertEqual(standing([row(revision: "2")], revision: "9").state, .alreadyDecided,
                       "an earlier revision of the same task did not displace this one")
        XCTAssertEqual(standing([row(taskId: "34LVxFqhGAi1xul4wjUHP", revision: "10")],
                                revision: "9").state,
                       .alreadyDecided, "and neither did a later revision of some other task")
    }

    /// The read has not come back. That is not an empty queue: the card cannot say what it is
    /// asking, so it offers nothing — and it is still a question, because nobody said it was
    /// answered.
    func testNoReadIsUnreadRatherThanAnswered() {
        let now = standing(nil)

        XCTAssertEqual(now.state, .unread)
        XCTAssertFalse(now.answerable)
        XCTAssertTrue(EvidenceDecisions.isOpen(now),
                      "a failed read is this device's problem, not an answer")
        XCTAssertEqual(EvidenceDecisions.heading(now), EvidenceDecisions.unreadHeading)
        XCTAssertNotNil(EvidenceDecisions.staleExplanation(now))
    }

    /// The standing reads the queue through the filter cards are delivered by, so a row this session
    /// could not answer — or one filed under another project, or under none — is never a live card,
    /// even while it sits in `pending`. The same row kept by the filter is the paired positive.
    func testARowTheCardFilterDropsIsNeverDecidable() {
        let dropped = [row(projectId: "34MPiBgZ80YpSKt0lmTQA"), row(projectId: nil),
                       row(independent: false), row(decidable: false)]
        for pending in dropped {
            XCTAssertFalse(standing([pending]).answerable,
                           "no live card for \(pending.projectId ?? "no project") · "
                               + "independent \(pending.independence.independent) · "
                               + "decidable \(pending.decidability.decidable)")
        }
        XCTAssertTrue(standing([row()]).answerable)
    }
}
