import Foundation
import XCTest
@testable import OrbitKit

/// The project page's crossings, as `GET /projects/:id/handoffs` serves them and as the card reads
/// them: what decodes, which rows can still be answered, the order they are listed in, and what the
/// second press says it is agreeing to. Web's `ProjectCrossingsCard.test.tsx`, for this client.
final class ProjectCrossingsTests: XCTestCase {

    private static let key = String(repeating: "c", count: 64)

    /// Three rows the way the production server writes them: every id twinned with its Base62
    /// spelling, the two ends joined by title, and the bookkeeping columns the card does not read.
    private static let list = """
    [
      {"id":"34bMoveRow","publicId":"34bMoveRow","ownerId":"34aOwner","ownerPublicId":"34aOwner",
       "fromProjectId":"34bFrom","fromProjectPublicId":"34bFrom","toProjectId":"34bTo","toProjectPublicId":"34bTo",
       "kind":"MOVE_TASK","subjectTaskId":"34bMovedTask","subjectTaskPublicId":"34bMovedTask",
       "payloadDigest":"\(String(repeating: "d", count: 64))","crossingKey":"\(ProjectCrossingsTests.key)",
       "state":"PENDING","title":"Watchdog (as first asked)","reason":"the watchdog belongs to the runner goal",
       "requestedBySessionId":"34bAsker","requestedBySessionPublicId":"34bAsker",
       "requestedAt":"2026-10-06T09:00:00.000Z","decidedBy":null,"decidedByUserId":null,"decidedAt":null,
       "expiresAt":null,"appliedTaskId":null,"appliedAt":null,
       "requestedCriterionDefinitionId":"34bTargetCriterion","requestedCriterionDefinitionPublicId":"34bTargetCriterion",
       "fromProject":{"title":"Coordinator control loop","status":"DONE"},
       "toProject":{"title":"Runner hardening","status":"OPEN"},
       "subjectTask":{"id":"34bMovedTask","publicId":"34bMovedTask","title":"Wire the drain watchdog"},
       "requestedBySession":{"id":"34bAsker","publicId":"34bAsker","title":"Coordinate runner hardening"},
       "requestedCriterion":{"key":"34bTargetCriterion","text":"A wedged drain restarts within a minute."},
       "withdrawnCriterion":{"key":"34bSourceCriterion","text":"The control loop never drops a turn."}},
      {"id":"34bFileRow","publicId":"34bFileRow","fromProjectId":"34bTo","fromProjectPublicId":"34bTo",
       "toProjectId":"34bOther","toProjectPublicId":"34bOther","kind":"FILE_TASK","subjectTaskId":null,
       "crossingKey":"\(String(repeating: "e", count: 64))","state":"APPLIED","title":"Fix the drain race",
       "reason":null,"requestedAt":"2026-10-05T09:00:00.000Z","decidedAt":"2026-10-05T10:00:00.000Z",
       "expiresAt":"2026-10-06T10:00:00.000Z","fromProject":{"title":"Runner hardening","status":"OPEN"},
       "toProject":{"title":"Release train","status":"OPEN"},"subjectTask":null,"requestedBySession":null,
       "requestedCriterion":null,"withdrawnCriterion":null},
      {"id":"0195c0de-0000-7000-8000-0000000000f3","fromProjectId":"0195c0de-0000-7000-8000-000000000001",
       "toProjectId":"0195c0de-0000-7000-8000-000000000002","kind":"DEPEND_ON_TASK",
       "subjectTaskId":"0195c0de-0000-7000-8000-0000000000a1","crossingKey":"\(String(repeating: "f", count: 64))",
       "state":"DENIED","title":"Wait on the schema change","reason":null,
       "requestedAt":"2026-10-04T09:00:00.000Z","decidedAt":"2026-10-04T09:30:00.000Z","expiresAt":null}
    ]
    """

    private func decoded() throws -> [ProjectCrossing] {
        try JSONDecoder().decode([ProjectCrossing].self, from: Data(Self.list.utf8))
    }

    private func move(state: String = "PENDING", fromProject: ProjectCrossing.ProjectEnd? = ProjectCrossing.ProjectEnd(title: "Coordinator control loop", status: "OPEN"),
                      toProject: ProjectCrossing.ProjectEnd? = ProjectCrossing.ProjectEnd(title: "Runner hardening", status: "OPEN"),
                      subjectTask: ProjectCrossing.SubjectTask? = ProjectCrossing.SubjectTask(id: "AAAMovedTask", title: "Wire the drain watchdog"),
                      requestedAt: String = "2026-08-22T00:00:00.000Z") -> ProjectCrossing {
        ProjectCrossing(id: "0195c0de-0000-7000-8000-0000000000f1", publicId: "AAACrossing",
                        fromProjectId: "0195c0de-0000-7000-8000-000000000001", fromProjectPublicId: "AAAFrom",
                        toProjectId: "0195c0de-0000-7000-8000-000000000002", toProjectPublicId: "AAATo",
                        fromProject: fromProject, toProject: toProject, kind: "MOVE_TASK",
                        subjectTaskId: "AAAMovedTask", subjectTaskPublicId: "AAAMovedTask", subjectTask: subjectTask,
                        crossingKey: Self.key, state: state, title: "Watchdog (as first asked)",
                        requestedAt: requestedAt)
    }

    private func filing(kind: String = "FILE_TASK", state: String = "PENDING",
                        requestedAt: String = "2026-08-22T00:00:00.000Z", id: String = "AAAFiling") -> ProjectCrossing {
        ProjectCrossing(id: id, fromProjectId: "AAAFrom", toProjectId: "AAATo",
                        fromProject: ProjectCrossing.ProjectEnd(title: "Coordinator control loop", status: "OPEN"),
                        toProject: ProjectCrossing.ProjectEnd(title: "Runner hardening", status: "OPEN"), kind: kind,
                        crossingKey: Self.key, state: state, title: "Fix the drain race", requestedAt: requestedAt)
    }

    // MARK: decoding

    func testAMoveDecodesWithItsTaskItsEndsAndTheTwoCriteriaItChanges() throws {
        let row = try XCTUnwrap(try decoded().first)
        XCTAssertEqual(row.id, "34bMoveRow")
        XCTAssertEqual(row.publicId, "34bMoveRow")
        XCTAssertTrue(row.isMove)
        XCTAssertEqual(row.kind, "MOVE_TASK")
        XCTAssertEqual(row.state, "PENDING")
        XCTAssertEqual(row.crossingKey, Self.key)
        XCTAssertEqual(row.fromProjectPublicId, "34bFrom")
        XCTAssertEqual(row.toProjectPublicId, "34bTo")
        XCTAssertEqual(row.fromProject, ProjectCrossing.ProjectEnd(title: "Coordinator control loop", status: "DONE"))
        XCTAssertEqual(row.toProject, ProjectCrossing.ProjectEnd(title: "Runner hardening", status: "OPEN"))
        XCTAssertEqual(row.subjectTask, ProjectCrossing.SubjectTask(id: "34bMovedTask", publicId: "34bMovedTask", title: "Wire the drain watchdog"))
        XCTAssertEqual(row.requestedCriterion, ProjectCrossing.Criterion(key: "34bTargetCriterion", text: "A wedged drain restarts within a minute."))
        XCTAssertEqual(row.withdrawnCriterion, ProjectCrossing.Criterion(key: "34bSourceCriterion", text: "The control loop never drops a turn."))
        XCTAssertEqual(row.reason, "the watchdog belongs to the runner goal")
        XCTAssertEqual(row.title, "Watchdog (as first asked)")
        XCTAssertEqual(row.requestedAt, "2026-10-06T09:00:00.000Z")
        XCTAssertNil(row.decidedAt)
    }

    /// A row from a server older than the move request — no joined titles, no subject read, no
    /// criteria — is a row with less on it, and the list around it still decodes.
    func testAnOlderServersRowDecodesWithLessOnIt() throws {
        let rows = try decoded()
        XCTAssertEqual(rows.count, 3)
        let filing = rows[1]
        XCTAssertFalse(filing.isMove)
        XCTAssertEqual(filing.state, "APPLIED")
        XCTAssertNil(filing.subjectTask)
        XCTAssertNil(filing.requestedCriterion)
        XCTAssertNil(filing.withdrawnCriterion)
        XCTAssertNil(filing.reason)

        let older = rows[2]
        XCTAssertEqual(older.kind, "DEPEND_ON_TASK")
        XCTAssertNil(older.publicId)
        XCTAssertNil(older.fromProject)
        XCTAssertNil(older.toProject)
        XCTAssertNil(older.subjectTask)
        XCTAssertNil(older.fromProjectPublicId)
        XCTAssertEqual(ProjectCrossings.fromID(older), "0195c0de-0000-7000-8000-000000000001")
        XCTAssertEqual(ProjectCrossings.doorID(older), "0195c0de-0000-7000-8000-0000000000f3",
                       "a row with no twin is answered at its own id")
    }

    /// A deleted target criterion keeps its key and loses its words, and the card says so.
    func testATargetCriterionSinceDeletedDecodesWithNoWords() throws {
        let json = #"{"id":"r","fromProjectId":"a","toProjectId":"b","kind":"MOVE_TASK","crossingKey":"k","state":"PENDING","#
            + #""title":"t","requestedAt":"2026-10-06T00:00:00.000Z","requestedCriterion":{"key":"34bGone","text":null}}"#
        let row = try JSONDecoder().decode(ProjectCrossing.self, from: Data(json.utf8))
        XCTAssertEqual(row.requestedCriterion, ProjectCrossing.Criterion(key: "34bGone", text: nil))
    }

    /// What a row cannot be answered without is required: its key, its state, its ends.
    func testARowWithNoCrossingKeyDoesNotDecode() {
        let json = #"{"id":"r","fromProjectId":"a","toProjectId":"b","kind":"MOVE_TASK","state":"PENDING","#
            + #""title":"t","requestedAt":"2026-10-06T00:00:00.000Z"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(ProjectCrossing.self, from: Data(json.utf8)))
    }

    // MARK: which rows can be answered

    func testOnlyAPendingCrossingCanBeAnswered() throws {
        XCTAssertTrue(ProjectCrossings.isAnswerable("PENDING"))
        for state in ["APPROVED", "DENIED", "APPLIED", "EXPIRED", ""] {
            XCTAssertFalse(ProjectCrossings.isAnswerable(state), "\(state) is not a question any more")
        }
        let rows = try decoded()
        XCTAssertEqual(rows.map { ProjectCrossings.isAnswerable($0.state) }, [true, false, false])
        XCTAssertEqual(ProjectCrossings.waitingCount(rows), 1)
        XCTAssertEqual(ProjectCrossings.waiting(1), "1 waiting")
    }

    /// The questions first, the one that has waited longest leading; then history, newest first.
    func testQuestionsLeadOldestFirstAndHistoryFollowsNewestFirst() {
        let rows = [
            filing(state: "APPLIED", requestedAt: "2026-10-01T00:00:00.000Z", id: "old-answer"),
            filing(state: "PENDING", requestedAt: "2026-10-05T00:00:00.000Z", id: "new-question"),
            filing(state: "DENIED", requestedAt: "2026-10-03T00:00:00.000Z", id: "new-answer"),
            filing(state: "PENDING", requestedAt: "2026-10-02T00:00:00.000Z", id: "old-question"),
        ]
        XCTAssertEqual(ProjectCrossings.ordered(rows).map(\.id),
                       ["old-question", "new-question", "new-answer", "old-answer"])
    }

    // MARK: what each state means

    func testAStateIsCalledByItsWordAndAnUnknownOneByItsCode() {
        XCTAssertEqual(ProjectCrossings.label("PENDING"), "Waiting for your answer")
        XCTAssertEqual(ProjectCrossings.label("APPROVED"), "Approved, not yet applied")
        XCTAssertEqual(ProjectCrossings.label("DENIED"), "Refused")
        XCTAssertEqual(ProjectCrossings.label("APPLIED"), "Applied")
        XCTAssertEqual(ProjectCrossings.label("SOMETHING_NEW"), "SOMETHING_NEW")
    }

    /// A move is already filed, so the filing's "not filed anywhere until you answer" would be false
    /// of it: each state says what it means for a move — and the filing keeps its own words.
    func testAMoveSaysWhatEachStateMeansForAMoveAndAFilingKeepsItsOwnWords() {
        for state in ["PENDING", "APPROVED", "DENIED", "APPLIED"] {
            let meaning = ProjectCrossings.meaning(move(state: state))
            XCTAssertEqual(meaning, ProjectCrossings.moveStateMeaning[state])
            XCTAssertNotEqual(meaning, TaskDetailCopy.crossingStateMeaning[state])
            XCTAssertEqual(ProjectCrossings.meaning(filing(state: state)), TaskDetailCopy.crossingStateMeaning[state])
            XCTAssertEqual(ProjectCrossings.meaning(filing(kind: "DEPEND_ON_TASK", state: state)),
                           TaskDetailCopy.crossingStateMeaning[state])
        }
        XCTAssertEqual(ProjectCrossings.meaning(move()),
                       "the task stays in its project until you answer, and confirming moves it")
        XCTAssertEqual(ProjectCrossings.meaning(move(state: "APPLIED")),
                       "the task was moved when this request was confirmed")
    }

    // MARK: the second press

    func testTheSecondPressNamesTheMoveAndSaysThatConfirmingIsTheMove() {
        let approve = ProjectCrossings.prompt(move(), .approve)
        XCTAssertEqual(approve, ProjectCrossings.Prompt(verb: "Approve", from: "Coordinator control loop", to: "Runner hardening",
                                      subject: "Wire the drain watchdog",
                                      consequence: ProjectCrossings.moveApproveConsequence))
        XCTAssertEqual(ProjectCrossings.question(approve),
                       "Approve moving “Wire the drain watchdog” from Coordinator control loop to Runner hardening?")
        XCTAssertEqual(ProjectCrossings.confirmLabel(approve), "Yes, approve")
        XCTAssertEqual(ProjectCrossings.moveApproveConsequence,
                       "Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again.")

        let deny = ProjectCrossings.prompt(move(), .deny)
        XCTAssertEqual(deny.verb, "Refuse")
        XCTAssertEqual(deny.consequence, ProjectCrossings.moveDenyConsequence)
        XCTAssertEqual(ProjectCrossings.confirmLabel(deny), "Yes, refuse")
        XCTAssertEqual(ProjectCrossings.shortKey(Self.key), String(repeating: "c", count: 12))
    }

    /// The task as it reads now; a subject read that came back empty still names it, by the title it
    /// was asked under — and two ends the server sent no titles for are named by id.
    func testTheSecondPressFallsBackToTheAskedTitleAndToIds() {
        let bare = ProjectCrossings.prompt(move(fromProject: nil, toProject: nil, subjectTask: nil), .approve)
        XCTAssertEqual(bare.subject, "Watchdog (as first asked)")
        XCTAssertEqual(bare.from, "AAAFrom")
        XCTAssertEqual(bare.to, "AAATo")
        XCTAssertEqual(ProjectCrossings.subjectID(move()), "AAAMovedTask")
    }

    func testAFilingAndADependencyKeepTheirOwnConsequences() {
        for kind in ["FILE_TASK", "DEPEND_ON_TASK"] {
            let approve = ProjectCrossings.prompt(filing(kind: kind), .approve)
            XCTAssertEqual(approve, ProjectCrossings.Prompt(verb: "Approve", from: "Coordinator control loop", to: "Runner hardening",
                                          subject: "Fix the drain race",
                                          consequence: "The writer may then file this work under the target project. It is not filed by this answer."))
            XCTAssertEqual(ProjectCrossings.prompt(filing(kind: kind), .deny).consequence,
                           "Refusing is final for this crossing. If you change your mind, file the work yourself.")
        }
    }

    /// The press's body: the answer, and the key of the crossing it was given on — what the server
    /// fences an answer on (`APPROVAL_TARGET_MISMATCH`).
    func testThePressSendsTheAnswerWithTheCrossingKeyItWasGivenOn() throws {
        let body = try JSONEncoder().encode(ProjectCrossings.request(move(), .approve))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["decision": "APPROVE", "acknowledgedCrossingKey": Self.key])
        XCTAssertEqual(ProjectCrossings.request(move(), .deny).decision.rawValue, "DENY")
        XCTAssertEqual(ProjectCrossings.doorID(move()), "AAACrossing", "the door is addressed by the public id")
    }

    func testARefusalKeepsTheDoorsCodeAndItsReason() {
        let body = #"{"statusCode":409,"error":"Conflict","code":"MOVE_TASK_LANDING_IN_FLIGHT","#
            + #""message":"task AAAMovedTask is being landed — nothing was written and the request is still waiting."}"#
        let refusal = ProjectCrossings.refusal(APIError.http(status: 409, body: body))
        XCTAssertEqual(refusal.code, "MOVE_TASK_LANDING_IN_FLIGHT")
        XCTAssertEqual(refusal.message,
                       "task AAAMovedTask is being landed — nothing was written and the request is still waiting.")
        let plain = ProjectCrossings.refusal(APIError.http(
            status: 409, body: #"{"statusCode":409,"message":"handoff approval X is APPLIED and cannot be APPROVED"}"#))
        XCTAssertNil(plain.code)
        XCTAssertEqual(plain.message, "handoff approval X is APPLIED and cannot be APPROVED")
    }
}
