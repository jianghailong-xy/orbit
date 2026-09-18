import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records what reached it and answers with the door's receipt.
private final class OwnerDoorURLProtocol: URLProtocol, @unchecked Sendable {
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
private func ownerSentBody(_ request: URLRequest) -> Data {
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

/// What reached the wire: the method, the path, the headers, and the body as the server's JSON
/// parser sees it.
private final class OwnerDoorRecorder: @unchecked Sendable {
    struct Sent {
        let method: String?
        let path: String?
        let headers: [String: String]
        let body: [String: Any]
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func append(_ request: URLRequest) {
        let body = (try? JSONSerialization.jsonObject(with: ownerSentBody(request))) as? [String: Any]
        var headers: [String: String] = [:]
        for (key, value) in request.allHTTPHeaderFields ?? [:] {
            headers[key.lowercased()] = value
        }
        lock.lock()
        storage.append(Sent(method: request.httpMethod, path: request.url?.path, headers: headers,
                            body: body ?? [:]))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// THE OWNER-CONFIRMATION CARD'S PRESS GOES STRAIGHT TO THE DOOR — WHAT IT SENDS, WHEN IT MAY, AND
/// WHERE A DELIVERED CARD STANDS.
///
/// The card is drawn from `GET /tasks/:id/owner-confirmation` and pressed at the same path with this
/// device's own sign-in. Three things the door holds a client to are pinned here: the path and the
/// body's bindings (with the session header it must NOT carry — a request that names a session is an
/// agent's, and the door refuses it), a send-back that carries no reason never becoming a request,
/// and the standings a delivered card derives from the read, which are the only thing that says
/// whether its two buttons may be pressed at all.
final class OwnerConfirmationDoorTests: XCTestCase {

    override func tearDown() {
        OwnerDoorURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerDoorURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    // MARK: fixtures

    private static let task = "34LMiluvx0jK63cj8arWl"
    private static let reportSession = "34JbyLO3TvHgOmBBHLgZu"
    private static let request = "6f2b0f7c-8f1a-4a3d-9d5e-2c6b7a8e9f01"
    private static let otherRequest = "8a1c2d3e-4f50-4617-8b9a-0c1d2e3f4a5b"

    private func waiting(requestId: String = OwnerConfirmationDoorTests.request,
                         sessionId: String = OwnerConfirmationDoorTests.reportSession,
                         report: OwnerConfirmationReport? = OwnerConfirmationReport(
                            text: "把迁移写上去了，pg spec 全绿。", reportedAt: "2026-09-16T07:30:00.000Z")
    ) -> OwnerConfirmationWaiting {
        OwnerConfirmationWaiting(requestId: requestId, sessionId: sessionId,
                                 requestedAt: "2026-09-16T07:30:00.000Z", report: report)
    }

    private func view(waiting: OwnerConfirmationWaiting?,
                      decisions: [RecordedOwnerDecision] = [],
                      criterion: String = "OWNER_CONFIRMED",
                      status: String = "OPEN") -> OwnerConfirmationView {
        OwnerConfirmationView(taskId: Self.task, title: "把确认卡接到原生端", status: status,
                              projectId: nil, completionCriterion: criterion,
                              acceptanceCriteria: "原生端能确认，且与 web 同一句话。",
                              waiting: waiting, decisions: decisions)
    }

    /// The door's receipt as it answers: a whole `OwnerDecisionReceipt`, of which the card reads the
    /// answer, the moment and the session.
    private static func receipt(decision: String, note: String?) -> Data {
        let noteJSON = note.map { "\"\($0)\"" } ?? "null"
        return Data("""
            {"id":"4d3N0t5l0tXkqz3cYbG7aB","taskId":"34LMiluvx0jK63cj8arWl",
             "decision":"\(decision)","note":\(noteJSON),
             "decidedAt":"2026-09-16T08:00:00.000Z","decidedByType":"USER",
             "requestId":"6f2b0f7c-8f1a-4a3d-9d5e-2c6b7a8e9f01",
             "sessionId":"34JbyLO3TvHgOmBBHLgZu","completed":true,"turnId":null}
            """.utf8)
    }

    // MARK: 1 — what one press sends

    /// `Confirm done` is one POST to the task's own door, and its body names the report it answers.
    /// A confirm carries no reason: the door takes a note with a send-back only.
    func testConfirmPostsTheDecisionAndTheRequestItAnswers() async throws {
        let recorder = OwnerDoorRecorder()
        OwnerDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (201, OwnerConfirmationDoorTests.receipt(decision: "CONFIRM", note: nil))
        }
        let asked = waiting()
        let request = try XCTUnwrap(OwnerConfirmations.request(waiting: asked, decision: .confirm))

        let result = try await client().decideOwnerConfirmation(taskID: Self.task, request)

        XCTAssertEqual(recorder.sent.count, 1, "one press is one request")
        let sent = try XCTUnwrap(recorder.sent.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/tasks/34LMiluvx0jK63cj8arWl/owner-confirmation")
        XCTAssertEqual(Set(sent.body.keys), ["decision", "requestId"],
                       "a confirm carries the decision and the report it answers, and no reason")
        XCTAssertEqual(sent.body["decision"] as? String, "CONFIRM")
        XCTAssertEqual(sent.body["requestId"] as? String, Self.request,
                       "the requestId read from the card, which the door compares with what waits now")

        XCTAssertEqual(result.decision, .confirm)
        XCTAssertEqual(result.completed, true)
        XCTAssertEqual(result.sessionId, Self.reportSession)
    }

    /// A press that answers no run — the task panel's `Confirm done` — says so by sending a null
    /// requestId rather than by leaving the question implied. The door takes that as "no run is
    /// waiting" and refuses it the moment one is.
    func testAPanelConfirmSendsANullRequestId() async throws {
        let recorder = OwnerDoorRecorder()
        OwnerDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (201, OwnerConfirmationDoorTests.receipt(decision: "CONFIRM", note: nil))
        }

        _ = try await client().decideOwnerConfirmation(taskID: Self.task,
                                                       OwnerConfirmations.panelRequest())

        let sent = try XCTUnwrap(recorder.sent.first)
        XCTAssertEqual(sent.path, "/api/tasks/34LMiluvx0jK63cj8arWl/owner-confirmation")
        XCTAssertEqual(Set(sent.body.keys), ["decision", "requestId"])
        XCTAssertTrue(sent.body["requestId"] is NSNull,
                      "the key is present and null, so the door is told which question this answers")
    }

    /// A send-back sends the same two bindings with the reason beside them, trimmed.
    func testSendBackPostsTheTrimmedReasonBesideTheBindings() async throws {
        let recorder = OwnerDoorRecorder()
        OwnerDoorURLProtocol.handler = { request in
            recorder.append(request)
            return (201, OwnerConfirmationDoorTests.receipt(decision: "SEND_BACK",
                                                            note: "把 iOS 的 job 结论贴上"))
        }
        let asked = waiting()
        let request = try XCTUnwrap(OwnerConfirmations.request(
            waiting: asked, decision: .sendBack, note: "  把 iOS 的 job 结论贴上 \n"))

        let result = try await client().decideOwnerConfirmation(taskID: Self.task, request)

        let sent = try XCTUnwrap(recorder.sent.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/tasks/34LMiluvx0jK63cj8arWl/owner-confirmation")
        XCTAssertEqual(Set(sent.body.keys), ["decision", "requestId", "note"])
        XCTAssertEqual(sent.body["decision"] as? String, "SEND_BACK")
        XCTAssertEqual(sent.body["requestId"] as? String, Self.request)
        XCTAssertEqual(sent.body["note"] as? String, "把 iOS 的 job 结论贴上")

        XCTAssertEqual(result.decision, .sendBack)
        XCTAssertEqual(result.note, "把 iOS 的 job 结论贴上")
    }

    /// THE PRESS CARRIES NO SESSION. The door refuses an answer that names a session — that is how
    /// every agent tool and CLI call reaches Orbit — so the native client must be as anonymous as
    /// the browser is, whatever credential it is holding.
    func testThePressNeverCarriesASessionHeader() async throws {
        let recorder = OwnerDoorRecorder()
        OwnerDoorURLProtocol.handler = { request in
            recorder.append(request)
            guard request.httpMethod == "GET" else {
                return (201, OwnerConfirmationDoorTests.receipt(decision: "CONFIRM", note: nil))
            }
            return (200, Data(#"{"taskId":"x","title":"t","status":"OPEN","projectId":null,"completionCriterion":"OWNER_CONFIRMED","acceptanceCriteria":null,"waiting":null,"decisions":[]}"#.utf8))
        }

        _ = try await client().ownerConfirmation(taskID: Self.task)
        _ = try await client().decideOwnerConfirmation(taskID: Self.task,
                                                       OwnerConfirmations.panelRequest())

        for sent in recorder.sent {
            XCTAssertNil(sent.headers["x-orbit-session-id"],
                         "an owner decision is made by the account owner, not by a session")
        }
    }

    // MARK: 2 — a send-back without a reason is never sent

    /// The door refuses a SEND_BACK carrying no note and writes nothing at all — and, with nothing
    /// waiting, refuses a send-back outright. So there is no request to make: not for a missing
    /// reason, an empty one, or whitespace.
    func testASendBackWithoutAReasonIsNoRequest() {
        let asked = waiting()
        let reasonless: [String?] = [nil, "", "   \n\t "]
        for note in reasonless {
            XCTAssertNil(OwnerConfirmations.request(waiting: asked, decision: .sendBack, note: note),
                         "a send-back with note \(String(describing: note)) must not be sendable")
        }
        XCTAssertEqual(OwnerConfirmations.request(waiting: asked, decision: .sendBack,
                                                  note: "  说清缺什么  ")?.note,
                       "说清缺什么")

        // The card no longer holds the reason — the composer does, and its own "nothing typed,
        // nothing sends" rule is what keeps a reasonless send-back from ever being built. This
        // request builder is the second gate, and the one that survives on any path to the door:
        // whatever the composer let through, a blank still makes no request.
        XCTAssertNil(OwnerConfirmations.request(waiting: asked, decision: .sendBack,
                                                note: "\u{00A0}"),
                     "a non-breaking space is not a reason either")
    }

    // MARK: 3 — where a delivered card stands

    /// The request is still the one waiting in THIS session: the one standing whose buttons are
    /// live, and the one carrying the report the owner decides from.
    func testTheWaitingRequestIsAnswerable() {
        let asked = waiting()
        let standing = OwnerConfirmations.standing(view(waiting: asked), sessionID: Self.reportSession,
                                                   requestID: Self.request)

        XCTAssertEqual(standing.state, .waiting(asked))
        XCTAssertEqual(standing.waiting?.report?.text, asked.report?.text)
        XCTAssertTrue(standing.answerable)
        XCTAssertTrue(OwnerConfirmations.isOpen(standing))
        XCTAssertNil(standing.receipt)
        XCTAssertNil(OwnerConfirmations.staleExplanation(standing))
    }

    /// A decision answering this request is in the read: the card is a receipt now, and the receipt
    /// is what it draws — with no buttons to press, because there is nothing left to answer.
    func testARequestADecisionAnswersIsAReceipt() {
        let decided = RecordedOwnerDecision(id: "4d3N0t5l0tXkqz3cYbG7aB", decision: .confirm,
                                            decidedAt: "2026-09-16T08:00:00.000Z",
                                            decidedByType: "USER", requestId: Self.request,
                                            sessionId: Self.reportSession)
        // The same task can have been asked again since; the answer to THIS one still ends it.
        let standing = OwnerConfirmations.standing(
            view(waiting: waiting(requestId: Self.otherRequest), decisions: [decided]),
            sessionID: Self.reportSession, requestID: Self.request)

        XCTAssertEqual(standing.state, .answered(decided))
        XCTAssertEqual(standing.receipt, decided)
        XCTAssertFalse(standing.answerable)
        XCTAssertFalse(OwnerConfirmations.isOpen(standing))
        XCTAssertNil(OwnerConfirmations.staleExplanation(standing),
                     "a receipt needs no explanation of why its buttons are gone — they are gone")
        XCTAssertEqual(OwnerConfirmations.receipt(view(waiting: nil, decisions: [decided]),
                                                  decisionID: decided.id), decided)
    }

    /// A LATER report is waiting — the same session asked again, or another run's session entirely.
    /// The door compares the request it is answering with the one waiting now, so every answer this
    /// card could send would be refused: the buttons are dead and the card says which refusal it
    /// met. The newer report has its own card.
    func testALaterReportSupersedesTheCard() {
        let later = waiting(requestId: Self.otherRequest)
        let elsewhere = waiting(sessionId: "34JVxqhGAi1xul4wjUHP")
        for (label, read, current) in [("asked again in this session", view(waiting: later), later),
                                       ("reported in another session",
                                        view(waiting: elsewhere), elsewhere)] {
            let standing = OwnerConfirmations.standing(read, sessionID: Self.reportSession,
                                                       requestID: Self.request)
            XCTAssertEqual(standing.state, .superseded(current), label)
            XCTAssertFalse(standing.answerable, label)
            XCTAssertFalse(OwnerConfirmations.isOpen(standing), label)
            XCTAssertNil(standing.waiting, "a stale card shows its address, not another report")
            let explanation = OwnerConfirmations.staleExplanation(standing)
            XCTAssertEqual(explanation?.lead,
                           "Nothing was recorded — there's a newer report waiting instead.")
            // The refusal's own spelling is kept, for whoever reports the problem — in the detail
            // the card folds, not in the reader's way.
            XCTAssertTrue(explanation?.detail.contains("OWNER_CONFIRMATION_STALE") ?? false,
                          explanation?.detail ?? "")
        }
    }

    /// Nothing is waiting and nothing answers this request: the task settled, or was reopened, and
    /// this card is neither a question nor a receipt.
    func testNothingWaitingIsNeitherQuestionNorReceipt() {
        let standing = OwnerConfirmations.standing(view(waiting: nil, status: "DONE"),
                                                   sessionID: Self.reportSession,
                                                   requestID: Self.request)

        XCTAssertEqual(standing.state, .notWaiting)
        XCTAssertFalse(standing.answerable)
        XCTAssertFalse(OwnerConfirmations.isOpen(standing))
        XCTAssertEqual(OwnerConfirmations.staleExplanation(standing)?.lead,
                       "Nothing to confirm here right now.")
        XCTAssertTrue(OwnerConfirmations.staleExplanation(standing)?
                        .detail.contains("OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK") ?? false)
    }

    /// The read has not come back. That is not "nothing is waiting": the card cannot say what it is
    /// asking, so it offers nothing — and it is still a question, because nobody said it was
    /// answered.
    func testNoReadIsUnreadRatherThanAnswered() {
        let standing = OwnerConfirmations.standing(nil, sessionID: Self.reportSession,
                                                   requestID: Self.request)

        XCTAssertEqual(standing.state, .unread)
        XCTAssertFalse(standing.answerable)
        XCTAssertTrue(OwnerConfirmations.isOpen(standing),
                      "a failed read is this device's problem, not an answer")
        XCTAssertNotNil(OwnerConfirmations.staleExplanation(standing))
    }

    /// The card is drawn in the session that REPORTED and in no other: a question waiting on the
    /// same task in another session is that session's card, so this one is out of date rather than
    /// pressable from here.
    func testTheCardOnlyEverAnswersItsOwnSessionsReport() {
        let asked = waiting()
        XCTAssertEqual(OwnerConfirmations.waitingIn(view(waiting: asked),
                                                    sessionID: Self.reportSession), asked)
        XCTAssertNil(OwnerConfirmations.waitingIn(view(waiting: asked), sessionID: "34OtherSession"))
        XCTAssertNil(OwnerConfirmations.waitingIn(view(waiting: asked), sessionID: nil))
        XCTAssertNil(OwnerConfirmations.waitingIn(nil, sessionID: Self.reportSession))

        // And a receipt belongs in its own session too.
        let decided = RecordedOwnerDecision(id: "d1", decision: .sendBack,
                                            decidedAt: "2026-09-16T08:00:00.000Z",
                                            requestId: Self.request, sessionId: Self.reportSession)
        XCTAssertEqual(OwnerConfirmations.receiptsIn(view(waiting: nil, decisions: [decided]),
                                                     sessionID: Self.reportSession), [decided])
        XCTAssertEqual(OwnerConfirmations.receiptsIn(view(waiting: nil, decisions: [decided]),
                                                     sessionID: "34OtherSession"), [])
    }

    // MARK: 4 — the task panel: one state, one place to answer

    /// While a run waits, the panel only POINTS at the card in that run's session — a second place
    /// to answer is a second answer racing the first.
    func testThePanelPointsAtTheSessionWhileARunWaits() {
        let asked = waiting()
        XCTAssertEqual(OwnerConfirmations.panelAction(view(waiting: asked), taskIsOwnerConfirmed: true,
                                                      taskUnsettled: true, taskHasRuns: true),
                       .pointer(sessionId: Self.reportSession))
    }

    /// With no run waiting, the panel confirms the task itself — including before the read lands,
    /// for a task that has no runs at all, which cannot have one waiting.
    func testThePanelConfirmsWhenNoRunIsWaiting() {
        XCTAssertEqual(OwnerConfirmations.panelAction(view(waiting: nil),
                                                      taskIsOwnerConfirmed: true,
                                                      taskUnsettled: true, taskHasRuns: true),
                       .confirm)
        XCTAssertEqual(OwnerConfirmations.panelAction(nil, taskIsOwnerConfirmed: true,
                                                      taskUnsettled: true, taskHasRuns: false),
                       .confirm, "a task that never ran cannot have a run waiting on its owner")
        XCTAssertNil(OwnerConfirmations.panelAction(nil, taskIsOwnerConfirmed: true,
                                                    taskUnsettled: true, taskHasRuns: true),
                     "with the read still out and runs that could be waiting, it offers nothing")
    }

    /// The task's own criterion and status decide the rest: the door refuses a confirmation against
    /// a task that does not declare OWNER_CONFIRMED, and one that has already settled.
    func testThePanelOffersNothingForATaskThisDoorWouldRefuse() {
        for read in [view(waiting: nil, criterion: "EXECUTABLE"),
                     view(waiting: nil, status: "DONE"),
                     view(waiting: nil, status: "CANCELLED")] {
            XCTAssertNil(OwnerConfirmations.panelAction(read, taskIsOwnerConfirmed: true,
                                                        taskUnsettled: true, taskHasRuns: true),
                         "\(read.completionCriterion) · \(read.status)")
        }
        XCTAssertNil(OwnerConfirmations.panelAction(nil, taskIsOwnerConfirmed: false,
                                                    taskUnsettled: false, taskHasRuns: false))
    }

    // MARK: 5 — what an answer leaves, and the words the card uses

    /// The receipt's line names the answer and the moment; the report's heading names the report and
    /// when it was said. Both are the web card's own sentences, with the time supplied.
    func testTheReceiptAndReportLinesAreTheWebCardsOwn() {
        let confirmed = RecordedOwnerDecision(id: "d1", decision: .confirm,
                                              decidedAt: "2026-09-16T08:00:00.000Z")
        let sentBack = RecordedOwnerDecision(id: "d2", decision: .sendBack, note: "N",
                                             decidedAt: "2026-09-15T08:00:00.000Z")
        XCTAssertEqual(OwnerConfirmations.receiptLine(confirmed, time: "08:00"),
                       "Confirmed done by you · 08:00")
        XCTAssertEqual(OwnerConfirmations.receiptLine(sentBack, time: "9/15 08:00"),
                       "Asked for more by you · 9/15 08:00")

        let report = OwnerConfirmationReport(text: "t", reportedAt: "2026-09-16T07:30:00.000Z")
        XCTAssertEqual(OwnerConfirmations.reportHeading(report, time: "07:30"),
                       "WHAT THE AGENT SAID · 07:30")
        XCTAssertEqual(OwnerConfirmations.reportHeading(nil, time: nil),
                       "WHAT THE AGENT SAID",
                       "a run that said nothing still gets the box, and the box still has a heading")
    }

    /// The moment, as the receipts render it: a clock time on the same day, and the day prefixed on
    /// any other.
    func testReceiptTimePrefersTheClockAndNamesTheDayOnlyWhenItDiffers() throws {
        let calendar = Calendar(identifier: .gregorian)
        let timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let now = try XCTUnwrap(RelativeTime.parse("2026-09-16T12:00:00.000Z"))

        XCTAssertEqual(OwnerConfirmations.receiptTime("2026-09-16T08:05:00.000Z", now: now,
                                                      calendar: calendar, timeZone: timeZone),
                       "08:05")
        XCTAssertEqual(OwnerConfirmations.receiptTime("2026-09-15T08:05:00.000Z", now: now,
                                                      calendar: calendar, timeZone: timeZone),
                       "9/15 08:05")
        XCTAssertNil(OwnerConfirmations.receiptTime("not a time", now: now, calendar: calendar,
                                                    timeZone: timeZone))
    }

    /// The refusal a press met is said as staleness when that is what the door's code means. Each of
    /// the door's three "this card is out of date" codes is spelled here, because a client that
    /// re-spells one is a client that stops recognising it.
    func testTheStaleRefusalCodesAreTheDoorsOwn() {
        XCTAssertEqual(OwnerConfirmations.staleCodes,
                       ["OWNER_CONFIRMATION_STALE", "OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK",
                        "OWNER_CONFIRMATION_TASK_SETTLED"])
        for code in OwnerConfirmations.staleCodes {
            XCTAssertEqual(OwnerConfirmations.refusalTitle(code: code),
                           "Not recorded: this card is out of date")
        }
        XCTAssertEqual(OwnerConfirmations.refusalTitle(code: "OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER"),
                       "Not recorded")
        XCTAssertEqual(OwnerConfirmations.refusalTitle(code: nil), "Not recorded")
    }

    /// The door's `code` is read off the error the API client throws, so a press that lost a race
    /// can say WHICH refusal it met rather than a bare "not recorded".
    func testARefusalCodeIsReadOffTheDoorsAnswer() async throws {
        OwnerDoorURLProtocol.handler = { _ in
            (409, Data("""
                {"code":"OWNER_CONFIRMATION_STALE","kind":"REFUSAL",
                 "requiredAction":"READ_THE_TASK_AGAIN_AND_DECIDE_WHAT_IS_WAITING_NOW",
                 "message":"a run of this task is waiting on your confirmation"}
                """.utf8))
        }
        do {
            _ = try await client().decideOwnerConfirmation(taskID: Self.task,
                                                           OwnerConfirmations.panelRequest())
            XCTFail("the door refused this press")
        } catch {
            XCTAssertEqual(APIClient.refusalCode(error), "OWNER_CONFIRMATION_STALE")
            XCTAssertEqual(OwnerConfirmations.refusalTitle(code: APIClient.refusalCode(error)),
                           "Not recorded: this card is out of date")
        }
    }

    // MARK: 6 — the signal that gets you to the door

    /// The session DTO carries the signal: `waitingKind` names what `pendingApprovals` is counting,
    /// and a kind this client does not know reads as no kind rather than failing the payload.
    func testWaitingKindDecodesAndNamesTheConfirmation() throws {
        let json = """
            {"id":"s1","title":"run","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"OWNER_CONFIRMATION","taskId":"34LMiluvx0jK63cj8arWl"}
            """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.waitingKind, .ownerConfirmation)
        XCTAssertEqual(session.taskId, "34LMiluvx0jK63cj8arWl")
        XCTAssertEqual(SessionHeader.statusWord(for: session),
                       OwnerConfirmations.waitingForConfirmation)
        XCTAssertEqual(SessionLine.make(for: session, live: true),
                       SessionLine(text: OwnerConfirmations.waitingForConfirmation, tone: .approval))

        let unknown = """
            {"id":"s2","title":"run","status":"RUNNING","pendingApprovals":1,
             "waitingKind":"SOMETHING_NEW"}
            """
        let other = try JSONDecoder().decode(Session.self, from: Data(unknown.utf8))
        XCTAssertEqual(other.waitingKind, .unknown)
        XCTAssertNil(other.taskId, "a session that is not a task's run links to no task")
        XCTAssertEqual(SessionHeader.statusWord(for: other), "Waiting for approval")
        XCTAssertEqual(SessionLine.make(for: other, live: true),
                       SessionLine(text: "Waiting for approval", tone: .approval))
    }

    /// The kind arrives and leaves with the count it qualifies — on both events that carry a count,
    /// because the row's words are the only thing on the list that says "there is a card for you in
    /// here": a row left saying so after the answer landed points at a card that is gone.
    func testTheKindArrivesAndLeavesWithTheCount() throws {
        let row = try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"s1","title":"run","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"OWNER_CONFIRMATION"}
            """.utf8))
        XCTAssertEqual(SessionLine.make(for: row, live: true).text,
                       OwnerConfirmations.waitingForConfirmation)

        // The event that reports the owner's answer: a total and no kind.
        let answered = try JSONDecoder().decode(ControlApproval.self, from: Data("""
            {"approvalId":"ap1","pendingApprovals":0,"waitingKind":null}
            """.utf8))
        let after = row.settingPendingApprovals(answered.pendingApprovals,
                                                waitingKind: answered.waitingKind)
        XCTAssertNil(after.waitingKind)
        XCTAssertEqual(SessionHeader.statusWord(for: after), "Waiting for your reply",
                       "nothing is waiting any more; the row stops naming a card")

        // A later run ends its turn and asks again: a count with the kind beside it.
        let asked = try JSONDecoder().decode(ControlApproval.self, from: Data("""
            {"approvalId":"ap2","pendingApprovals":1,"waitingKind":"OWNER_CONFIRMATION"}
            """.utf8))
        let again = row.settingPendingApprovals(asked.pendingApprovals,
                                                waitingKind: asked.waitingKind)
        XCTAssertEqual(again.waitingKind, .ownerConfirmation)

        // The same pair rides on the session summary, which is the other way a loaded row hears it.
        let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","title":null,"status":"AWAITING_INPUT","runStatus":"AWAITING_INPUT",
             "sessionState":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
             "pendingApprovals":1,"waitingKind":"OWNER_CONFIRMATION","lastTurnAt":null,
             "taskId":"34LMiluvx0jK63cj8arWl"}
            """.utf8))
        let merged = row.applying(summary)
        XCTAssertEqual(merged.waitingKind, .ownerConfirmation)
        XCTAssertEqual(merged.taskId, "34LMiluvx0jK63cj8arWl",
                       "and the row keeps the task whose card it is about, without a refetch")
    }

    /// A parked conversation waiting on its owner is exactly the case the wording exists for: the
    /// turn ended underneath the card, so nothing is generating.
    func testAParkedSessionWaitingOnItsOwnerSaysSoInTheHeadersWords() throws {
        let json = """
            {"id":"s1","title":"run","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
             "pendingApprovals":1,"waitingKind":"OWNER_CONFIRMATION"}
            """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertFalse(session.isGenerating)
        XCTAssertEqual(SessionHeader.statusWord(for: session),
                       OwnerConfirmations.waitingForConfirmation)
        XCTAssertEqual(SessionHeader.subtitle(for: session, now: Date.distantPast),
                       "\(OwnerConfirmations.waitingForConfirmation) · Open")
        // And the glyph beside that word says the same thing, because the two are read together.
        XCTAssertEqual(SessionStatusGlyph.make(for: session),
                       SessionStatusGlyph(shape: .symbol("pause.circle"), tone: .warning,
                                          label: OwnerConfirmations.waitingForConfirmation))
    }
}
