import Foundation
import XCTest
@testable import OrbitKit

/// THE TASK-MOVE ROW WORDS, AND THE ONE CARD THE MOVES ARE ANSWERED ON.
///
/// The server counts open owner requests and PENDING task moves on session rows, and serves a
/// session its MOVE_TASK batches (`GET /sessions/:id/task-moves`) with one door that answers a whole
/// batch. The owner kept main's crossing decision card as the one card (`CrossingBatches` /
/// `CrossingDecisionCard`); this task adds the row words, feeds the card from the session read when
/// the conversation is the ASKER, and sends a move batch through the batch door. The app's wiring is
/// asserted by reading its sources, as the other wiring tests do.
final class TaskMovesTests: XCTestCase {

    // MARK: the row words

    /// A row counting only moves says how many, in the shared copy's words — and the glyph stays
    /// the amber pause it always was, because the one act available is the owner's.
    func testTheRowSaysHowManyTaskMovesWait() throws {
        let row = try decodeSession("""
            {"id":"coordinator","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"MOVE_REQUEST",
             "taskMoves":[
               {"requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
                "count":5,"since":"2026-11-01T08:31:00Z","title":"First","handoffIds":["h1"]},
               {"requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p3",
                "count":3,"since":"2026-11-01T09:00:00Z","title":"Second","handoffIds":["h2"]}]}
            """)
        XCTAssertEqual(row.waitingKind, .moveRequest)
        XCTAssertEqual(row.taskMoves?.count, 2)
        XCTAssertEqual(SessionLine.make(for: row, live: true),
                       SessionLine(text: "Approve 8 task moves", tone: .approval))
        XCTAssertEqual(SessionHeader.statusWord(for: row), "Approve 8 task moves")
        let glyph = SessionStatusGlyph.make(for: row)
        XCTAssertEqual(glyph.shape, .symbol("pause.circle"), "the row is still the amber needs-you glyph")
        XCTAssertEqual(glyph.tone, .warning)

        let single = try decodeSession("""
            {"id":"asker","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"MOVE_REQUEST",
             "taskMoves":[{"requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
                           "count":1,"since":"2026-11-01T08:31:00Z","title":"Only","handoffIds":["h1"]}]}
            """)
        XCTAssertEqual(SessionLine.make(for: single, live: true).text, "Approve task move")
    }

    /// A row naming a request kind says that kind's own word. Two kinds on one row are a mix, and
    /// the server names no kind then — the row keeps what it always said.
    func testTheRowNamesTheOwnerRequestKind() throws {
        let cases: [(String, String)] = [
            ("DECISION", "Decision for you"),
            ("SECRET", "Key needed"),
            ("MANUAL_STEP", "Steps for you"),
            ("CONFIRM", "Confirm for you"),
        ]
        for (kind, word) in cases {
            let row = try decodeSession("""
                {"id":"asker","status":"AWAITING_INPUT","pendingApprovals":1,
                 "waitingKind":"OWNER_REQUEST",
                 "ownerRequests":[{"ownerRequestId":"r1","kind":"\(kind)","title":"t",
                                   "since":"2026-11-01T08:31:00Z"}]}
                """)
            XCTAssertEqual(row.waitingKind, .ownerRequest)
            XCTAssertEqual(SessionLine.make(for: row, live: true).text, word, kind)
            XCTAssertEqual(SessionLine.make(for: row, live: true).tone, .approval)
        }

        // A kind this build cannot name, and a row whose list did not arrive, both keep the
        // generic words rather than going silent.
        let unknown = try decodeSession("""
            {"id":"asker","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"OWNER_REQUEST",
             "ownerRequests":[{"ownerRequestId":"r1","kind":"NEW_KIND","title":"t",
                               "since":"2026-11-01T08:31:00Z"}]}
            """)
        XCTAssertEqual(unknown.ownerRequests?.first?.kind, .unknown)
        XCTAssertEqual(SessionLine.make(for: unknown, live: true).text, "Waiting for approval")

        let noList = try decodeSession("""
            {"id":"asker","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"MOVE_REQUEST"}
            """)
        XCTAssertEqual(SessionLine.make(for: noList, live: true).text, "Waiting for approval")
    }

    /// The summary carries the two lists with the count they belong to: a row lit by a move stops
    /// lighting when the event says none is waiting, and an older control plane's omission keeps
    /// what the row knows.
    func testTheSummaryOwnsTheListsItCarries() throws {
        let row = try decodeSession("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":1,
             "waitingKind":"MOVE_REQUEST",
             "taskMoves":[{"requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
                           "count":2,"since":"2026-11-01T08:31:00Z","title":"T","handoffIds":["h","i"]}]}
            """)
        let cleared = row.applying(try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":0,"waitingKind":null,
             "taskMoves":[],"ownerRequests":[]}
            """.utf8)))
        XCTAssertEqual(cleared.taskMoves, [])
        XCTAssertEqual(cleared.ownerRequests, [])
        XCTAssertEqual(SessionLine.make(for: cleared, live: true).text, "Waiting for your reply")

        let older = row.applying(try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":1,"waitingKind":null}
            """.utf8)))
        XCTAssertEqual(older.taskMoves?.count, 1, "an older summary that never sends the key keeps the row's")
    }

    // MARK: the read

    /// `GET /sessions/:id/task-moves` decodes into batches of crossings: each move with the task,
    /// the criterion and the crossing key, grouped as the server grouped them.
    func testTheReadDecodesIntoBatchesOfCrossings() throws {
        let batches = try JSONDecoder().decode([TaskMoveBatch].self, from: Data("""
            [{"batchKey":"b1","requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
              "state":"PENDING","since":"2026-11-01T08:31:00.000Z","decidedAt":null,
              "drawnAs":["REQUESTER"],
              "moves":[
                {"id":"h1","publicId":"AAA1","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "fromProject":{"title":"Runner link v1","status":"DONE"},
                 "toProject":{"title":"Runner link hardening","status":"OPEN"},
                 "subjectTask":{"id":"t1","title":"An apiserver never stops gracefully"},
                 "requestedCriterion":{"key":"4","text":"An apiserver never stops gracefully"},
                 "crossingKey":"d81f99d9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                 "state":"PENDING","title":"asked title","requestedAt":"2026-11-01T08:31:00.000Z"},
                {"id":"h2","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "subjectTask":{"id":"t2","title":"A later sudo orbit runs as root"},
                 "crossingKey":"55db32cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                 "state":"PENDING","requestedAt":"2026-11-01T08:32:00.000Z"}]},
             {"batchKey":"b2","requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
              "state":"APPLIED","since":"2026-10-01T08:31:00.000Z","decidedAt":"2026-10-02T09:00:00.000Z",
              "drawnAs":["REQUESTER","TARGET_COORDINATOR"],"moves":[]}]
            """.utf8))
        XCTAssertEqual(batches.map(\.batchKey), ["b1", "b2"])
        let waiting = try XCTUnwrap(batches.first)
        XCTAssertTrue(waiting.isWaiting)
        XCTAssertEqual(waiting.count, 2)
        XCTAssertEqual(waiting.drawnAs, ["REQUESTER"])
        XCTAssertEqual(waiting.moves.first?.fromProject?.title, "Runner link v1")
        XCTAssertEqual(waiting.moves.first?.subjectTask?.title, "An apiserver never stops gracefully")
        XCTAssertEqual(waiting.moves.first?.requestedCriterion?.text, "An apiserver never stops gracefully")
        XCTAssertFalse(batches[1].isWaiting)
        XCTAssertNotNil(batches[1].decidedAt)
    }

    // MARK: one card, from either read

    /// The session read becomes the same crossing card the project read draws — same rows, same
    /// card id (the first row's door), so a session that is both ends of a batch draws ONE card.
    func testTheSessionReadBecomesTheSameCrossingCard() throws {
        let read = try XCTUnwrap(JSONDecoder().decode([TaskMoveBatch].self, from: Data("""
            [{"batchKey":"b1","requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
              "state":"PENDING","since":"2026-11-01T08:31:00.000Z","drawnAs":["REQUESTER"],
              "moves":[
                {"id":"h1","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "fromProject":{"title":"Runner link v1","status":"DONE"},
                 "toProject":{"title":"Runner link hardening","status":"OPEN"},
                 "requestedBySession":{"id":"asker","title":"Runner link v1 coordinator"},
                 "crossingKey":"a1aaaa","state":"PENDING","requestedAt":"2026-11-01T08:31:00Z"},
                {"id":"h2","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "toProject":{"title":"Runner link hardening","status":"OPEN"},
                 "requestedBySession":{"id":"asker","title":"Runner link v1 coordinator"},
                 "crossingKey":"a2aaaa","state":"PENDING","requestedAt":"2026-11-01T08:32:00Z"}]}]
            """.utf8)).first)
        let batch = try XCTUnwrap(CrossingBatches.batch(from: read, inTarget: false))
        XCTAssertEqual(batch.id, "crossing-batch-h1")
        XCTAssertEqual(batch.kind, ProjectCrossings.moveKind)
        XCTAssertEqual(batch.rows.map(\.id), ["h1", "h2"])
        XCTAssertTrue(batch.isLive)

        // The project read groups the same rows under the same first row — one card.
        let fromProject = CrossingBatches.batches(batch.rows, projectID: "p2")
        XCTAssertEqual(fromProject.map(\.id), [batch.id])

        // The asking session's copy names the project the work goes into; the target's says here.
        XCTAssertEqual(CrossingBatches.title(batch), "Move these tasks into Runner link hardening?")
        XCTAssertEqual(CrossingBatches.toText(batch), "Runner link hardening")
        let target = try XCTUnwrap(CrossingBatches.batch(from: read, inTarget: true))
        XCTAssertEqual(CrossingBatches.title(target), "Move these tasks here?")
        XCTAssertEqual(CrossingBatches.toText(target), "this project")
    }

    /// An answered read is the card's receipt: fully answered, its verdict, and the line one place
    /// shows when the other end answered it.
    func testAnAnsweredReadIsTheCardsReceipt() throws {
        let read = try XCTUnwrap(JSONDecoder().decode([TaskMoveBatch].self, from: Data("""
            [{"batchKey":"b2","requestedBySessionId":"asker","fromProjectId":"p1","toProjectId":"p2",
              "state":"APPLIED","since":"2026-11-01T08:31:00Z",
              "decidedAt":"2026-11-01T09:00:00Z","drawnAs":["REQUESTER"],
              "moves":[
                {"id":"h1","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "crossingKey":"a1aaaa","state":"APPLIED","decidedAt":"2026-11-01T09:00:00Z",
                 "requestedAt":"2026-11-01T08:31:00Z"},
                {"id":"h2","fromProjectId":"p1","toProjectId":"p2","kind":"MOVE_TASK",
                 "crossingKey":"a2aaaa","state":"APPLIED","decidedAt":"2026-11-01T09:00:00Z",
                 "requestedAt":"2026-11-01T08:32:00Z"}]}]
            """.utf8)).first)
        let batch = try XCTUnwrap(CrossingBatches.batch(from: read))
        XCTAssertTrue(batch.answered)
        XCTAssertEqual(batch.verdict, .approved)
        XCTAssertEqual(batch.decidedAt, "2026-11-01T09:00:00Z")
        let elsewhere = CrossingBatches.standing(batch, sawLive: true, pressedAt: nil)
        XCTAssertEqual(CrossingBatches.receiptVerdict(elsewhere), "Approved at another end")
    }

    // MARK: the batch answer

    /// One press answers every waiting move in one body, each with the crossing key the card read.
    func testTheAnswerCarriesEveryWaitingMoveAndItsKey() throws {
        let rows = [crossing(id: "h1", key: "a1"), crossing(id: "h2", key: "a2")]
        let body = TaskMoves.answer(rows, .approve)
        XCTAssertEqual(body.decision, .approve)
        XCTAssertEqual(body.moves.map(\.handoffId), ["h1", "h2"])
        XCTAssertEqual(body.moves.map(\.crossingKey), ["a1", "a2"])

        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        XCTAssertEqual(json?["decision"] as? String, "APPROVE")
        let sent = try XCTUnwrap(json?["moves"] as? [[String: String]])
        XCTAssertEqual(sent.first?["handoffId"], "h1")
        XCTAssertEqual(sent.first?["crossingKey"], "a1")
        XCTAssertEqual(TaskMoves.answer(rows, .deny).decision, .deny)
    }

    /// The batch door's 409 is the card's refusal: its code, and the sentence naming every move
    /// whose key no longer matched (or that is no longer waiting).
    func testTheFenceRefusalIsReadForTheCard() {
        let fence = APIError.http(status: 409, body: """
            {"statusCode":409,"error":"Conflict","code":"APPROVAL_TARGET_MISMATCH",
             "message":"1 of the 2 moves in this answer cannot take it — 2wndAAHBC95f4Al8rNFxZ names a different crossing. Nothing was written; re-read the moves and answer what they say now"}
            """)
        let refusal = ProjectCrossings.refusal(fence)
        XCTAssertEqual(refusal.code, "APPROVAL_TARGET_MISMATCH")
        XCTAssertTrue(refusal.message.contains("Nothing was written"))

        let stale = APIError.http(status: 409, body: """
            {"statusCode":409,"code":"HANDOFF_ALREADY_ANSWERED","message":"1 of the 2 moves in this answer cannot take it — 2wndAAHBC95f4Al8rNFxZ is APPLIED."}
            """)
        XCTAssertEqual(ProjectCrossings.refusal(stale).code, "HANDOFF_ALREADY_ANSWERED")
    }

    // MARK: the card in the asking session

    /// The batch a session asked for is grouped by asker as well as source, so the card the batch
    /// door answers is one asker's: two sessions' moves from one project are two cards.
    func testAMoveBatchIsOneAsker() {
        let first = crossing(id: "h1", key: "a1", asker: "asker-a")
        let second = crossing(id: "h2", key: "a2", asker: "asker-b")
        XCTAssertEqual(CrossingBatches.batches([first, second], projectID: "p2").count, 2)
        let same = [first, crossing(id: "h3", key: "a3", asker: "asker-a")]
        XCTAssertEqual(CrossingBatches.batches(same, projectID: "p2").count, 1,
                       "one asker's moves out of one project into another are one card")
    }

    // MARK: the app's wiring

    /// The one card answers a move batch through the session door — ONE POST — and keeps its 409 on
    /// the card; the session read feeds it in the asking conversation; no second move card exists.
    func testTheAppAnswersMovesThroughTheBatchDoor() throws {
        let console = try appSource("ConsoleModel.swift")
        XCTAssertTrue(console.contains("if batch.kind == ProjectCrossings.moveKind {"))
        XCTAssertTrue(console.contains("api.decideTaskMoveBatch(sessionID: sessionID, moves: batch.pending,"),
                      "a MOVE_TASK batch is one POST of every waiting move")
        XCTAssertTrue(console.contains("crossingBatchRefusals[batchID] = ProjectCrossings.refusal(error)"),
                      "the server's 409 is kept on the card")
        XCTAssertTrue(console.contains("api.sessionTaskMoves(sessionID: sessionID)"),
                      "the asking session's batches come from the session read")
        XCTAssertTrue(console.contains("CrossingBatches.batch(from: read, inTarget: inTarget)"))

        let card = try appSource("Views/CrossingDecisionCard.swift")
        XCTAssertTrue(card.contains("console.crossingBatchRefusals[batch.id]"),
                      "the card draws the batch door's refusal")
        XCTAssertTrue(card.contains("CrossingBatches.toText(batch)"),
                      "the asking session names the target project rather than 'this project'")

        // No second move card: the row kind, the view and the card copy this task first shipped are
        // gone, and only the crossing card's kind remains.
        let rows = try orbitKitSource("Transcript/TranscriptRows.swift")
        XCTAssertFalse(rows.contains("taskMoveBatch"), "the task-move row case is gone")
        XCTAssertTrue(rows.contains("case crossingBatch"), "the crossing card is the one card")
        XCTAssertNil(try appSourceIfPresent("Views/TaskMoveCard.swift"),
                     "this task's own move card view is removed")
    }

    // MARK: fixtures

    private func decodeSession(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func crossing(id: String = "h1", key: String, asker: String? = nil,
                          state: String = "PENDING") -> ProjectCrossing {
        ProjectCrossing(
            id: id, fromProjectId: "p1", toProjectId: "p2",
            fromProject: .init(title: "Runner link v1", status: "DONE"),
            toProject: .init(title: "Runner link hardening", status: "OPEN"), kind: "MOVE_TASK",
            subjectTask: .init(id: "t1", title: "An apiserver never stops gracefully"),
            requestedBySession: asker.map { .init(id: $0, title: "Asker") },
            requestedCriterion: .init(key: "4", text: "Criterion 4"),
            crossingKey: key, state: state, title: "asked title",
            requestedAt: "2026-11-01T08:31:00Z")
    }

    /// An app source under `src/macos/OrbitApp/Sources/OrbitApp`, found above this test file.
    private func appSource(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("OrbitApp/Sources/OrbitApp/\(relative)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(relative) was not found above this test file")
    }

    private func appSourceIfPresent(_ relative: String) throws -> String? {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("OrbitApp/Sources/OrbitApp/\(relative)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    /// A file under `src/macos/OrbitKit/Sources/OrbitKit`, found above this test file.
    private func orbitKitSource(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("OrbitKit/Sources/OrbitKit/\(relative)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(relative) was not found above this test file")
    }
}
