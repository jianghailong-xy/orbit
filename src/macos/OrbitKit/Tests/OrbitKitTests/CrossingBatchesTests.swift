import Foundation
import XCTest
@testable import OrbitKit

/// Cross-project requests drawn as a decision card in the target project's coordinator
/// conversation: which rows make a batch, where it is placed, what it says in each state, and the
/// bodies its two presses send (task 34vT0PEhdlq1lILqsg2WG's shared spec).
final class CrossingBatchesTests: XCTestCase {

    private static let here = "34bTarget"

    private func row(_ id: String, kind: String = "MOVE_TASK", from: String = "34bSource",
                     to: String = CrossingBatchesTests.here, state: String = "PENDING",
                     requestedAt: String, decidedAt: String? = nil, title: String? = nil,
                     subject: String? = nil, criterion: String? = nil, criterionText: String? = "text",
                     withdrawn: String? = nil, reason: String? = nil,
                     source: String? = "Runner v1") -> ProjectCrossing {
        ProjectCrossing(id: "uuid-\(id)", publicId: id, fromProjectId: "uuid-\(from)", fromProjectPublicId: from,
                        toProjectId: "uuid-\(to)", toProjectPublicId: to,
                        fromProject: source.map { ProjectCrossing.ProjectEnd(title: $0) },
                        toProject: ProjectCrossing.ProjectEnd(title: "Runner hardening"), kind: kind,
                        subjectTask: subject.map { ProjectCrossing.SubjectTask(id: "t-\(id)", title: $0) },
                        requestedCriterion: criterion.map { ProjectCrossing.Criterion(key: $0, text: criterionText) },
                        withdrawnCriterion: withdrawn.map { ProjectCrossing.Criterion(key: $0, text: "w") },
                        crossingKey: "key-\(id)", state: state, title: title ?? "Task \(id)", reason: reason,
                        requestedAt: requestedAt, decidedAt: decidedAt)
    }

    private func at(_ minute: Int) -> String {
        String(format: "2026-11-09T08:%02d:00.000Z", minute)
    }

    // MARK: batching

    func testOnlyRowsTargetingThisProjectMakeBatches() {
        let rows = [row("A", requestedAt: at(1)),
                    row("B", from: Self.here, to: "34bElsewhere", requestedAt: at(2))]
        let batches = CrossingBatches.batches(rows, projectID: Self.here)
        XCTAssertEqual(batches.map { $0.rows.map(\.publicId) }, [["A"]])
        // The raw id names the target as well as its public twin.
        XCTAssertEqual(CrossingBatches.batches(rows, projectID: "uuid-\(Self.here)").count, 1)
    }

    /// A move to no project has no target end: it never joins a batch, whatever id is asked, and
    /// the rows around it batch as before.
    func testAMoveToNoProjectTargetsNoProject() {
        let out = ProjectCrossing(id: "uuid-O", publicId: "O", fromProjectId: "uuid-34bSource",
                                  fromProjectPublicId: "34bSource", toProjectId: nil, kind: "MOVE_TASK",
                                  crossingKey: "key-O", state: "PENDING", title: "Task O", requestedAt: at(2))
        let rows = [row("A", requestedAt: at(1)), out, row("B", requestedAt: at(3))]
        XCTAssertFalse(CrossingBatches.targets(out, projectID: Self.here))
        XCTAssertFalse(CrossingBatches.targets(out, projectID: ""))
        XCTAssertFalse(CrossingBatches.targets(out, projectID: "34bSource"))
        XCTAssertEqual(CrossingBatches.batches(rows, projectID: Self.here).map { $0.rows.map(\.publicId) },
                       [["A", "B"]])
        XCTAssertEqual(CrossingBatches.batches([out], projectID: "34bSource").count, 0)
    }

    func testRowsAskedWhileTheBatchIsOpenJoinItAndLaterOnesStartANewOne() {
        let rows = [
            row("C", state: "DENIED", requestedAt: at(5), decidedAt: at(6)),
            row("A", state: "APPROVED", requestedAt: at(1), decidedAt: at(6)),
            row("B", state: "APPLIED", requestedAt: at(3), decidedAt: at(6)),
            // Asked after every member of the first batch was answered: a new batch.
            row("D", requestedAt: at(7)),
            // Same source, other kind: its own batch.
            row("F", kind: "FILE_TASK", requestedAt: at(2)),
            // Other source: its own batch.
            row("G", from: "34bOther", requestedAt: at(4)),
        ]
        let batches = CrossingBatches.batches(rows.shuffled(), projectID: Self.here)
        XCTAssertEqual(batches.map(\.id), ["crossing-batch-A", "crossing-batch-F", "crossing-batch-G",
                                           "crossing-batch-D"])
        XCTAssertEqual(batches[0].rows.map(\.publicId), ["A", "B", "C"], "oldest first")
        XCTAssertEqual(batches[0].moment, at(1))
        XCTAssertEqual(batches[0].pending.map(\.publicId), [])
        XCTAssertFalse(batches[0].isLive)
        XCTAssertEqual(batches[0].verdict, .mixed)
        XCTAssertEqual(batches[3].pending.map(\.publicId), ["D"])
        XCTAssertTrue(batches[3].isLive)
        XCTAssertNil(batches[3].verdict)
    }

    func testAPendingMemberKeepsTheBatchOpen() {
        let rows = [row("A", requestedAt: at(1)), row("B", requestedAt: at(50))]
        XCTAssertEqual(CrossingBatches.batches(rows, projectID: Self.here).count, 1)
    }

    func testAnAnswerAtTheSameMomentClosesTheBatch() {
        let rows = [row("A", state: "DENIED", requestedAt: at(1), decidedAt: at(3)),
                    row("B", requestedAt: at(3))]
        XCTAssertEqual(CrossingBatches.batches(rows, projectID: Self.here).count, 2)
    }

    func testTheBatchIdFallsBackToTheRawId() {
        let raw = ProjectCrossing(id: "raw-1", fromProjectId: "s", toProjectId: Self.here, kind: "FILE_TASK",
                                  crossingKey: "k", state: "PENDING", title: "x", requestedAt: at(1))
        XCTAssertEqual(CrossingBatches.batches([raw], projectID: Self.here).first?.id, "crossing-batch-raw-1")
        XCTAssertEqual(DeliveredDecisionCard(kind: .crossingBatch(batchID: "crossing-batch-raw-1")).id,
                       "crossing-batch-raw-1")
    }

    func testVerdictAndDecidedAt() {
        func batch(_ states: [String]) -> CrossingBatch {
            let rows = states.enumerated().map { i, s in
                row("R\(i)", state: s, requestedAt: at(1 + i), decidedAt: at(20 + i))
            }
            return CrossingBatches.batches(rows, projectID: Self.here)[0]
        }
        XCTAssertEqual(batch(["APPROVED", "APPLIED"]).verdict, .approved)
        XCTAssertEqual(batch(["DENIED", "DENIED"]).verdict, .refused)
        XCTAssertEqual(batch(["DENIED", "APPLIED"]).verdict, .mixed)
        XCTAssertEqual(batch(["DENIED", "APPLIED", "DENIED"]).decidedAt, at(22))
    }

    // MARK: where the card stands

    func testTheThreeAnsweredStates() throws {
        let answered = CrossingBatches.batches([row("A", state: "APPLIED", requestedAt: at(1), decidedAt: at(34))],
                                               projectID: Self.here)[0]
        let pressed = Date()
        XCTAssertEqual(CrossingBatches.standing(answered, sawLive: true, pressedAt: pressed),
                       .recorded(verdict: .approved, at: at(34)))
        XCTAssertEqual(CrossingBatches.standing(answered, sawLive: true, pressedAt: nil),
                       .elsewhere(verdict: .approved))
        XCTAssertEqual(CrossingBatches.standing(answered, sawLive: false, pressedAt: nil),
                       .recorded(verdict: .approved, at: at(34)))
        let live = CrossingBatches.batches([row("A", requestedAt: at(1))], projectID: Self.here)[0]
        XCTAssertEqual(CrossingBatches.standing(live, sawLive: true, pressedAt: pressed), .live)
        XCTAssertNil(CrossingBatches.receiptLine(.live))

        let clock = CriteriaDecisions.receiptClock(at(34))
        XCTAssertEqual(CrossingBatches.receiptLine(.recorded(verdict: .approved, at: at(34))),
                       "Decision recorded · ✓ Approved by you at \(clock)")
        XCTAssertEqual(CrossingBatches.receiptLine(.recorded(verdict: .refused, at: at(34))),
                       "Decision recorded · ✓ Refused by you at \(clock)")
        XCTAssertEqual(CrossingBatches.receiptLine(.recorded(verdict: .mixed, at: at(34))),
                       "Decision recorded · ✓ Answered by you at \(clock)")
        XCTAssertEqual(CrossingBatches.receiptLine(.elsewhere(verdict: .approved)), "Approved at another end")
        XCTAssertEqual(CrossingBatches.receiptLine(.elsewhere(verdict: .refused)), "Refused at another end")
        XCTAssertEqual(CrossingBatches.receiptLine(.elsewhere(verdict: .mixed)), "Answered at another end")
    }

    func testAnAnswerWithNoClockFallsBackToThePressTime() throws {
        let answered = CrossingBatches.batches([row("A", state: "DENIED", requestedAt: at(1))], projectID: Self.here)[0]
        let pressed = try XCTUnwrap(ThinkingSummary.date(at(40)))
        guard case .recorded(.refused, let stamp?) = CrossingBatches.standing(answered, sawLive: true, pressedAt: pressed)
        else { return XCTFail("recorded with the press time") }
        XCTAssertEqual(ThinkingSummary.date(stamp), pressed)
    }

    // MARK: the words

    func testTitlesBadgesNounsAndHeadsPerKind() {
        func batch(_ kind: String, _ n: Int, state: String = "PENDING") -> CrossingBatch {
            let rows = (0..<n).map { row("K\($0)", kind: kind, state: state, requestedAt: at(1 + $0), decidedAt: state == "PENDING" ? nil : at(30)) }
            return CrossingBatches.batches(rows, projectID: Self.here)[0]
        }
        XCTAssertEqual(CrossingBatches.title(batch("MOVE_TASK", 2)), "Move these tasks here?")
        XCTAssertEqual(CrossingBatches.title(batch("MOVE_TASK", 1)), "Move this task here?")
        XCTAssertEqual(CrossingBatches.title(batch("FILE_TASK", 2)), "File these tasks here?")
        XCTAssertEqual(CrossingBatches.title(batch("FILE_TASK", 1)), "File this task here?")
        XCTAssertEqual(CrossingBatches.title(batch("DEPEND_ON_TASK", 2)), "Allow these dependencies?")
        XCTAssertEqual(CrossingBatches.title(batch("DEPEND_ON_TASK", 1)), "Allow this dependency?")

        XCTAssertEqual(CrossingBatches.badge(batch("MOVE_TASK", 2)), "move")
        XCTAssertEqual(CrossingBatches.badge(batch("FILE_TASK", 2)), "file")
        XCTAssertEqual(CrossingBatches.badge(batch("DEPEND_ON_TASK", 2)), "depend")
        XCTAssertEqual(CrossingBatches.badge(batch("MOVE_TASK", 2, state: "APPLIED")), "moved")
        XCTAssertEqual(CrossingBatches.badge(batch("FILE_TASK", 2, state: "APPROVED")), "approved")
        XCTAssertEqual(CrossingBatches.badge(batch("DEPEND_ON_TASK", 2, state: "APPROVED")), "approved")
        XCTAssertEqual(CrossingBatches.badge(batch("MOVE_TASK", 2, state: "DENIED")), "refused")

        XCTAssertEqual(CrossingBatches.listHead("MOVE_TASK"), "Tasks to move")
        XCTAssertEqual(CrossingBatches.listHead("FILE_TASK"), "Tasks to file")
        XCTAssertEqual(CrossingBatches.listHead("DEPEND_ON_TASK"), "Tasks waited on")
        XCTAssertEqual(CrossingBatches.summary(batch("DEPEND_ON_TASK", 1)), "1 dependency from Runner v1")
        XCTAssertEqual(CrossingBatches.summary(batch("DEPEND_ON_TASK", 3)), "3 dependencies from Runner v1")
        XCTAssertEqual(CrossingBatches.summary(batch("FILE_TASK", 1)), "1 task from Runner v1")
        XCTAssertEqual(CrossingBatches.waitingLine(batch("MOVE_TASK", 8)), "move · 8 waiting")
    }

    func testTheSummaryNamesTheSourceAndTheCriteria() {
        let rows = (4...11).map { row("M\($0)", requestedAt: at($0), criterion: String($0)) }
        let batch = CrossingBatches.batches(rows, projectID: Self.here)[0]
        XCTAssertEqual(CrossingBatches.summary(batch), "8 tasks from Runner v1 · for criteria 4–11")
        let unnamed = CrossingBatches.batches([row("U", requestedAt: at(1), source: nil)], projectID: Self.here)[0]
        XCTAssertEqual(CrossingBatches.summary(unnamed), "1 task from unnamed project")
    }

    func testTheCriteriaRange() {
        XCTAssertNil(CrossingBatches.criteriaRange([]))
        XCTAssertEqual(CrossingBatches.criteriaRange(["4"]), "for criterion 4")
        XCTAssertEqual(CrossingBatches.criteriaRange(["4", "4"]), "for criterion 4")
        XCTAssertEqual(CrossingBatches.criteriaRange(["6", "4", "5"]), "for criteria 4–6")
        XCTAssertEqual(CrossingBatches.criteriaRange(["9", "4", "6"]), "for criteria 4, 6, 9")
        XCTAssertEqual(CrossingBatches.criteriaRange(["10", "9"]), "for criteria 9–10")
        XCTAssertEqual(CrossingBatches.criteriaRange(["b", "a"]), "for criteria a, b")
    }

    func testTheReviewRows() {
        let move = row("A", requestedAt: at(1), title: "As first asked", subject: "Wire the watchdog",
                       criterion: "4", withdrawn: "2")
        XCTAssertEqual(CrossingBatches.rowTitle(move), "Wire the watchdog")
        XCTAssertEqual(CrossingBatches.requestedLine(move), "Target criterion requested: 4")
        XCTAssertEqual(CrossingBatches.withdrawnLine(move), "Source criterion it serves now: 2")
        XCTAssertNil(CrossingBatches.stateLine(move))
        let gone = row("B", requestedAt: at(1), criterion: "7", criterionText: nil)
        XCTAssertEqual(CrossingBatches.requestedLine(gone),
                       "Target criterion requested: 7 — The target project no longer states this criterion.")
        XCTAssertEqual(CrossingBatches.rowTitle(row("C", requestedAt: at(1), title: "Moved title")), "Moved title")
        let file = row("F", kind: "FILE_TASK", requestedAt: at(1), title: "Plan title", subject: "Other")
        XCTAssertEqual(CrossingBatches.rowTitle(file), "Plan title")
        let depend = row("D", kind: "DEPEND_ON_TASK", requestedAt: at(1), title: "Old", subject: "Schema change")
        XCTAssertEqual(CrossingBatches.rowTitle(depend), "Schema change")
        XCTAssertEqual(CrossingBatches.stateLine(row("E", state: "APPLIED", requestedAt: at(1))),
                       ProjectCrossings.label("APPLIED"))
        XCTAssertEqual(CrossingBatches.showMore(5), "Show 5 more")
        XCTAssertEqual(CrossingBatches.shownRows, 3)
        XCTAssertEqual(CrossingBatches.provenance, "From Orbit — not the requesting agent.")
    }

    func testReasonsAreDistinctAndQuoted() {
        let rows = [row("A", requestedAt: at(1), reason: "They serve 4–11 here."),
                    row("B", requestedAt: at(2), reason: "They serve 4–11 here."),
                    row("C", requestedAt: at(3), reason: "  "),
                    row("D", requestedAt: at(4), reason: "Old project is done.")]
        let batch = CrossingBatches.batches(rows, projectID: Self.here)[0]
        XCTAssertEqual(CrossingBatches.reasons(batch), ["“They serve 4–11 here.”", "“Old project is done.”"])
    }

    func testTheConsequencePerKindAndCount() {
        let one = CrossingBatches.batches([row("A", requestedAt: at(1))], projectID: Self.here)[0]
        let many = CrossingBatches.batches([row("A", requestedAt: at(1)), row("B", requestedAt: at(2))],
                                           projectID: Self.here)[0]
        let file = CrossingBatches.batches([row("F", kind: "FILE_TASK", requestedAt: at(1))], projectID: Self.here)[0]
        let depend = CrossingBatches.batches([row("D", kind: "DEPEND_ON_TASK", requestedAt: at(1))], projectID: Self.here)[0]
        XCTAssertEqual(CrossingBatches.consequence(one), ProjectCrossings.moveApproveConsequence)
        XCTAssertEqual(CrossingBatches.consequence(many),
                       "Confirming is the move: the tasks join the target project as soon as you answer, and nobody has to send the request again.")
        XCTAssertEqual(CrossingBatches.consequence(file),
                       "The writer may then file this work under the target project. It is not filed by this answer.")
        XCTAssertEqual(CrossingBatches.consequence(depend), ProjectCrossings.fileApproveConsequence)
    }

    func testTheRefusalNote() {
        XCTAssertNil(CrossingBatches.refusalNote(0))
        XCTAssertEqual(CrossingBatches.refusalNote(1), "1 answer was not recorded")
        XCTAssertEqual(CrossingBatches.refusalNote(3), "3 answers were not recorded")
    }

    // MARK: the presses

    func testAPressAnswersEveryPendingRowWithItsOwnKey() throws {
        let rows = [row("A", state: "APPLIED", requestedAt: at(1), decidedAt: at(9)),
                    row("B", requestedAt: at(2)), row("C", requestedAt: at(3))]
        let batch = CrossingBatches.batches(rows, projectID: Self.here)[0]
        let approve = CrossingBatches.requests(batch, .approve)
        XCTAssertEqual(approve.map { $0.row.publicId }, ["B", "C"])
        XCTAssertEqual(approve.map { $0.body }, [
            ProjectCrossingDecisionRequest(decision: .approve, acknowledgedCrossingKey: "key-B"),
            ProjectCrossingDecisionRequest(decision: .approve, acknowledgedCrossingKey: "key-C"),
        ])
        XCTAssertEqual(CrossingBatches.requests(batch, .deny).map { $0.body.decision }, [.deny, .deny])
        let json = String(decoding: try JSONEncoder().encode(approve[0].body), as: UTF8.self)
        XCTAssertTrue(json.contains("\"decision\":\"APPROVE\"") && json.contains("\"acknowledgedCrossingKey\":\"key-B\""))
        XCTAssertEqual(approve.map { ProjectCrossings.doorID($0.row) }, ["B", "C"])
    }
}
