import Foundation
import XCTest
@testable import OrbitKit

/// THE TASK-MOVE CARD: ITS READ, ITS ROW WORDS, AND THE ANSWER IT SENDS.
///
/// The server counts waiting `MOVE_TASK` crossings on the session rows — the one that asked and the
/// target project's coordinator — and serves them to a conversation as batches with one door that
/// answers a whole batch. This client's half is `TaskMoveBatch` (the read), `TaskMoves` (the words
/// and the answer body), and the row words `SessionHeader.waitingWord` gives `MOVE_REQUEST` /
/// `OWNER_REQUEST`. The card itself is drawn in the app; what it says and sends is asserted here.
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

    /// `GET /sessions/:id/task-moves` decodes into batches of crossings: the grouping the row's
    /// count uses, each move with the task, the criterion and the crossing key the answer echoes.
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
        XCTAssertEqual(waiting.moves.first?.fromProject?.status, "DONE")
        XCTAssertEqual(waiting.moves.first?.subjectTask?.title, "An apiserver never stops gracefully")
        XCTAssertEqual(waiting.moves.first?.requestedCriterion?.text, "An apiserver never stops gracefully")
        XCTAssertEqual(TaskMoves.title(waiting.count), "Move 2 tasks into this project")
        XCTAssertFalse(batches[1].isWaiting)
        XCTAssertNotNil(batches[1].decidedAt)
    }

    /// The id a row is drawn under, and where it goes: the same batch keeps its row as it becomes an
    /// answer, and the card sits where it was asked.
    func testTheCardKeepsItsRowAndSitsWhereItWasAsked() {
        let card = DeliveredDecisionCard(kind: .taskMoveBatch(batchKey: "b1"))
        XCTAssertEqual(card.id, "task-move-batch-b1")
        XCTAssertEqual(DeliveryAnchor.onArrival(of: .taskMoveBatch(batchKey: "b1"), items: []), nil,
                       "a batch is placed by its own moment, never only by arrival")
    }

    // MARK: the words

    func testTheCardSaysWhatTheBoardSays() {
        XCTAssertEqual(TaskMoves.title(1), "Move 1 task into this project")
        XCTAssertEqual(TaskMoves.title(8), "Move 8 tasks into this project")
        XCTAssertEqual(TaskMoves.approveAsk(8), "Approve 8 moves…")
        XCTAssertEqual(TaskMoves.approveAsk(1), "Approve move…")
        XCTAssertEqual(TaskMoves.approve(8), "Approve 8 moves")
        XCTAssertEqual(TaskMoves.approve(1), "Approve move")
        XCTAssertEqual(TaskMoves.refuse(8), "Refuse 8 moves")
        XCTAssertEqual(TaskMoves.refuse(1), "Refuse move")
        XCTAssertEqual(ProjectCrossings.refuseAsk, "Refuse…", "the first press refuses without a count")
        XCTAssertEqual(TaskMoves.confirmTitle(8, .approve), "Approve 8 task moves?")
        XCTAssertEqual(TaskMoves.confirmTitle(1, .deny), "Refuse 1 task move?")
        XCTAssertEqual(TaskMoves.showAll(8), "Show all 8")
        XCTAssertEqual(TaskMoves.showFewer, "Show fewer")
        XCTAssertEqual(TaskMoves.more(5), "and 5 more")
        XCTAssertEqual(TaskMoves.moved(1), "Moved 1 task into this project")
        XCTAssertEqual(TaskMoves.moved(8), "Moved 8 tasks into this project")
        XCTAssertEqual(TaskMoves.rowWord(1), "Approve task move")
        XCTAssertEqual(TaskMoves.rowWord(8), "Approve 8 task moves")
        // The consequence is the project page's own sentence, not a second wording of it.
        XCTAssertEqual(TaskMoves.consequence(.approve), ProjectCrossings.moveApproveConsequence)
        XCTAssertEqual(TaskMoves.consequence(.deny), ProjectCrossings.moveDenyConsequence)
    }

    /// The card's own heading and provenance differ in the two places it is drawn: the target's
    /// coordinator says "into this project" and names who asked; the asking session says which
    /// project the moves go into and that it asked here (Android's words, which web shares).
    func testTheHeadingAndTheAskerNameTheTwoPlacesTheCardIsDrawn() {
        let coordinator = batch(drawnAs: ["TARGET_COORDINATOR"])
        XCTAssertEqual(TaskMoves.title(coordinator), "Move 2 tasks into this project")
        XCTAssertTrue(TaskMoves.asked(coordinator).hasPrefix("Asked by Runner link v1 coordinator · Nov 1, 08:31"),
                      TaskMoves.asked(coordinator))

        let asker = batch(drawnAs: ["REQUESTER"])
        XCTAssertEqual(TaskMoves.title(asker), "Move 2 tasks into Runner link hardening")
        XCTAssertTrue(TaskMoves.asked(asker).hasPrefix("Asked here · Nov 1, 08:31"),
                      TaskMoves.asked(asker))

        // No joined asker and no readable stamp: the board's own words, with no date bolted on.
        let bare = batch(drawnAs: ["TARGET_COORDINATOR"], since: "not a date", asker: nil)
        XCTAssertEqual(TaskMoves.asked(bare), "Asked by its coordinator")
    }

    func testAMoveLineNamesTheTaskAndItsTargetCriterion() {
        let move = crossing(criterion: ("4", "Faster restarts"), key: "d81f99d9")
        XCTAssertEqual(TaskMoves.moveLine(move),
                       "Task to move · Target criterion requested: Faster restarts")
        XCTAssertEqual(TaskMoves.confirmLine(move), "Faster restarts · key d81f99d9…")

        let noCriterion = crossing(criterion: nil, key: "55db32cb")
        XCTAssertEqual(TaskMoves.moveLine(noCriterion), "Task to move")
        XCTAssertEqual(TaskMoves.confirmLine(noCriterion), "key 55db32cb…")

        let gone = crossing(criterion: ("4", nil), key: "b09aa76d")
        XCTAssertEqual(TaskMoves.moveLine(gone),
                       "Task to move · Target criterion requested: The target project no longer states this criterion.")
    }

    /// The one line an answered batch is left as, per state the server can leave it in.
    func testAnAnsweredBatchIsOneLine() {
        for (state, line) in [
            ("APPLIED", "Moved 3 tasks into this project"),
            ("DENIED", "Refused 3 task moves into this project"),
            ("APPROVED", "3 task moves into this project: \(ProjectCrossings.label("APPROVED"))"),
        ] {
            let batch = TaskMoveBatch(batchKey: "b", requestedBySessionId: "s",
                                      fromProjectId: "p1", toProjectId: "p2", state: state,
                                      since: "2026-11-01T08:31:00Z", moves: [])
            let counted = TaskMoveBatch(batchKey: batch.batchKey,
                                        requestedBySessionId: batch.requestedBySessionId,
                                        fromProjectId: batch.fromProjectId,
                                        toProjectId: batch.toProjectId, state: state,
                                        since: batch.since, moves: Array(repeating: crossing(criterion: nil,
                                                                                              key: "ab"),
                                                                          count: 3))
            XCTAssertEqual(TaskMoves.resolved(counted), line, state)
        }
    }

    // MARK: the answer

    /// The second press sends every move of the batch with the crossing key the card read, and the
    /// one decision — the body the server's fence checks row by row.
    func testTheAnswerCarriesEveryMoveAndItsKey() throws {
        let moves = [crossing(id: "h1", criterion: nil, key: "a1"),
                     crossing(id: "h2", criterion: nil, key: "a2")]
        let batch = TaskMoveBatch(batchKey: "b", requestedBySessionId: "s", fromProjectId: "p1",
                                  toProjectId: "p2", state: "PENDING",
                                  since: "2026-11-01T08:31:00Z", moves: moves)
        let body = TaskMoves.answer(batch, .approve)
        XCTAssertEqual(body.decision, .approve)
        XCTAssertEqual(body.moves.map(\.handoffId), ["h1", "h2"])
        XCTAssertEqual(body.moves.map(\.crossingKey), ["a1", "a2"])

        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        XCTAssertEqual(json?["decision"] as? String, "APPROVE")
        let sent = try XCTUnwrap(json?["moves"] as? [[String: String]])
        XCTAssertEqual(sent.first?["handoffId"], "h1")
        XCTAssertEqual(sent.first?["crossingKey"], "a1")
        XCTAssertEqual(TaskMoves.answer(batch, .deny).decision, .deny)
    }

    // MARK: the shared copy

    /// The row's words are the browser's, sentence for sentence: `@orbit/shared` declares them and
    /// the web row reads them, so a client that says the same thing holds them to that source. The
    /// card's own sentences have no web half yet; these are the ones both surfaces already say.
    func testTheRowWordsAgreeWithTheSharedCopy() throws {
        let shared = try source("src/shared/src/project-progress.ts")
        for (kind, word) in [("DECISION", "Decision for you"), ("SECRET", "Key needed"),
                             ("MANUAL_STEP", "Steps for you"), ("CONFIRM", "Confirm for you")] {
            XCTAssertTrue(shared.contains("\(kind): '\(word)'"),
                          "the shared row words no longer say \(kind) is \(word.debugDescription)")
        }
        XCTAssertTrue(shared.contains("return moves === 1 ? 'Approve task move' : `Approve ${moves} task moves`;"),
                      "the shared row word for moves drifted from TaskMoves.rowWord")
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(relative) was not found above this test file")
    }

    // MARK: fixtures

    /// Two moves out of Runner link v1 into Runner link hardening, as the read would hand them over.
    private func batch(drawnAs: [String], since: String = "2026-11-01T08:31:00Z",
                       asker: ProjectCrossing.AskSession? =
                        .init(id: "asker", title: "Runner link v1 coordinator")) -> TaskMoveBatch {
        func move(_ id: String) -> ProjectCrossing {
            ProjectCrossing(
                id: id, fromProjectId: "p1", toProjectId: "p2",
                fromProject: .init(title: "Runner link v1", status: "DONE"),
                toProject: .init(title: "Runner link hardening", status: "OPEN"), kind: "MOVE_TASK",
                subjectTask: .init(id: "t", title: "A task"),
                requestedBySession: asker, requestedCriterion: .init(key: "4", text: "Criterion 4"),
                crossingKey: String(repeating: "a", count: 64), state: "PENDING",
                title: "asked", requestedAt: since)
        }
        return TaskMoveBatch(batchKey: "b", requestedBySessionId: "asker", fromProjectId: "p1",
                             toProjectId: "p2", state: "PENDING", since: since,
                             drawnAs: drawnAs, moves: [move("h1"), move("h2")])
    }

    private func decodeSession(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func crossing(id: String = "h1", criterion: (String, String?)?,
                          key: String) -> ProjectCrossing {
        ProjectCrossing(
            id: id, fromProjectId: "p1", toProjectId: "p2", kind: "MOVE_TASK",
            subjectTask: .init(id: "t1", title: "An apiserver never stops gracefully"),
            requestedCriterion: criterion.map { .init(key: $0.0, text: $0.1) },
            crossingKey: key, state: "PENDING", title: "asked title",
            requestedAt: "2026-11-01T08:31:00Z")
    }
}
