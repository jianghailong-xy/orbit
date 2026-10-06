import Foundation
import XCTest
@testable import OrbitKit

/// "Why is this project not done?" is asked only of a project that LOOKS finished — OPEN and
/// started, every stated criterion met by its work, no task IN_PROGRESS — and that the projection
/// does not call done (the owner's ruling of 2026-10-06 09:29Z, which put back the condition the
/// browser had before 0f47238c1). A project with work still to do is not asked: "the work is not
/// done yet" is not news. The three other drawings stay as they were — the owner's card while a
/// DONE_REQUEST or a press here stands, Orbit's DONE as the card's terminal state, the owner's DONE
/// as its receipt.
///
/// And the card's tally adds up: each met criterion is counted where its work is, each unmet one as
/// "not met" and never by its landing lane. The browser holds the same rule and words in
/// `ProjectWhyNotDoneGate.test.tsx`; `ProjectDoneCopyParityTests` reads its source.
final class ProjectWhyNotDoneGateTests: XCTestCase {

    private let request = DoneRequest(criteriaDigest: String(repeating: "a", count: 64),
                                      judgment: "The goal is met.")

    private func row() -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: ProjectDone.heading, waitingSince: "",
                           doneRequest: request)
    }

    /// A started OPEN project whose every criterion is met and none of whose tasks is running, with
    /// one merge Orbit never saw — the project the card is for. Each case below changes one fact.
    private func project(status: String = "OPEN", done: Bool = false,
                         criteria: [ProjectDoneCriterion]? = nil,
                         tasksByStatus: [String: Int]? = ["DONE": 4],
                         doneBy: ProjectDoneBy? = nil) -> ProjectDoneSubject {
        let answers = criteria ?? [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true, landing: "UNKNOWN", landingReason: .noReceipt),
        ]
        return ProjectDoneSubject(
            title: "Closeout", status: status,
            criteria: answers.enumerated().map {
                .init(id: $0.element.definitionId, ordinal: $0.offset + 1, text: "criterion \($0.offset + 1)")
            },
            derivedDone: ProjectDerivedDone(
                status: done ? "DONE" : "OPEN", done: done,
                withheld: done ? [] : ["CRITERION_UNLANDED"], criteria: answers,
                counts: ProjectDoneCounts(criteria: answers.count, met: answers.filter(\.satisfied).count,
                                          landed: 0, onMain: 0)),
            doneBy: doneBy, tasksByStatus: tasksByStatus)
    }

    /// The antd migration the owner reported on 2026-10-06: started, OPEN, six criteria and every
    /// one of them Not met yet — whose coordinator conversation carried the card all the same.
    private func antdMigration(tasksByStatus: [String: Int]? = ["DONE": 2, "OPEN": 5]) -> ProjectDoneSubject {
        let reasons: [CriterionLandingReason?] = [.noReceipt, .noReceipt, .codeless, .codeless, .onProjectBranch, nil]
        return project(criteria: reasons.enumerated().map {
            ProjectDoneCriterion(definitionId: "a\($0.offset + 1)", satisfied: false, landing: "UNKNOWN",
                                 landingReason: $0.element)
        }, tasksByStatus: tasksByStatus)
    }

    private func slot(_ subject: ProjectDoneSubject?, request: ProjectOpenItemRow? = nil,
                      waitingKind: SessionWaitingKind? = nil, record: ProjectDoneRecord? = nil,
                      started: Bool? = true) -> ProjectDone.Slot {
        ProjectDone.slot(subject: subject, request: request, waitingKind: waitingKind, record: record,
                         started: started)
    }

    // MARK: whether the conversation asks

    func testAProjectWithACriterionStillUnmetIsNotAsked() {
        XCTAssertEqual(slot(antdMigration()), .none, "six criteria Not met yet is not a finished-looking project")
        let oneUnmet = project(criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: false, landing: "UNKNOWN", landingReason: .codeless),
        ])
        XCTAssertEqual(slot(oneUnmet), .none, "one unmet criterion is enough to leave the card down")
    }

    func testAllMetWithATaskStillInProgressIsNotAsked() {
        XCTAssertEqual(slot(project(tasksByStatus: ["DONE": 4, "IN_PROGRESS": 1])), .none,
                       "a task still running: the project has not stopped")
    }

    func testAllMetNothingRunningAndTheProjectionWithholdingIsAsked() {
        XCTAssertEqual(slot(project()), .notDone)
        // Only IN_PROGRESS holds it back — work that is not running is the projection's to explain.
        XCTAssertEqual(slot(project(tasksByStatus: ["DONE": 4, "OPEN": 1, "FAILED": 1])), .notDone)
        XCTAssertEqual(slot(project(tasksByStatus: [:])), .notDone, "no tasks at all is nothing running")
        XCTAssertEqual(slot(project(tasksByStatus: nil)), .notDone,
                       "a read without the tally is nothing it can say is running — the browser's `?? 0`")
    }

    func testEveryOtherHalfOfTheConditionHoldsTheCardBack() {
        XCTAssertEqual(slot(project(), started: false), .none, "not started: the start card asks")
        XCTAssertEqual(slot(project(), started: nil), .none, "a read that does not say it started")
        XCTAssertEqual(slot(project(status: "CANCELLED")), .none, "not OPEN")
        XCTAssertEqual(slot(project(criteria: [])), .none, "no criteria: nothing to explain")
        XCTAssertEqual(slot(project(done: true)), .none, "the projection already calls it done")
        XCTAssertEqual(slot(nil), .none, "a read that has not answered is not an answer")
        let older = ProjectDoneSubject(title: "t", status: "OPEN", derivedDone: ProjectDerivedDone(
            criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true)], counts: nil))
        XCTAssertEqual(slot(older), .none, "a server without counts draws no card")
    }

    // MARK: the three drawings that do not change

    func testARequestOrAPressHereDrawsTheOwnersCardWhateverTheProjectLooksLike() {
        let running = antdMigration(tasksByStatus: ["IN_PROGRESS": 2])
        XCTAssertEqual(slot(running, request: row(), waitingKind: .doneRequest), .done(requestID: "req1"),
                       "a DONE_REQUEST is answered on the owner's card, unmet criteria or not")
        XCTAssertEqual(slot(running, waitingKind: .recordAsDone), .done(requestID: nil))
        let record = ProjectDoneRecord(projectId: "p1", doneAt: "2026-10-06T09:40:00.000Z",
                                       criteriaDigest: request.criteriaDigest)
        XCTAssertEqual(slot(running, record: record), .done(requestID: nil),
                       "the local receipt keeps the card its press turned into")
        XCTAssertEqual(ProjectDone.receiptLine(running, record: record, timeZone: TimeZone(identifier: "UTC")!),
                       "You recorded this project done · Oct 6, 09:40")
    }

    func testOrbitsDoneIsTheCardsTerminalStateAndTheOwnersDoneIsTheReceipt() {
        for doneBy in [ProjectDoneBy.derived, nil] {
            let orbitDone = project(status: "DONE", done: true, doneBy: doneBy)
            XCTAssertEqual(slot(orbitDone), .notDone, "Orbit's DONE: This project is done · recorded by Orbit")
            XCTAssertTrue(ProjectDone.WhyNotDone(subject: orbitDone, withCoordinator: 0, requested: false)
                            .settled(orbitDone))
            XCTAssertEqual(ProjectDone.settledBadge(orbitDone.doneBy), ProjectDone.recordedByOrbit)
            XCTAssertEqual(ProjectDone.receiptLine(orbitDone, record: nil), "This project is done · recorded by Orbit")
        }
        let ownerDone = project(status: "DONE", criteria: antdMigration().derivedDone?.criteria,
                                tasksByStatus: ["IN_PROGRESS": 1], doneBy: .owner)
        XCTAssertEqual(slot(ownerDone), .done(requestID: nil), "the owner's DONE keeps its receipt")
        XCTAssertTrue(ProjectDone.recorded(ownerDone, record: nil))
        XCTAssertTrue(ProjectDone.ownerRecorded(ownerDone, record: nil))
    }

    // MARK: the tally

    /// The parts after "N criteria", summed — what "adds up to the criteria" means.
    private func partsSum(_ tally: String) -> (head: Int, parts: Int) {
        let numbers = tally.components(separatedBy: " · ").map {
            Int($0.prefix { $0.isNumber }) ?? -1
        }
        return (numbers.first ?? -1, numbers.dropFirst().reduce(0, +))
    }

    func testTheTallyCountsUnmetCriteriaAsNotMetAndAddsUpToTheCriteria() {
        // The owner's report: "8 criteria · 2 met · 2 on main · 1 on the project branch · 2 merged
        // outside Orbit · 3 no code to land", where six of the eight were Not met yet.
        let reported = ProjectDerivedDone(criteria: [
            ProjectDoneCriterion(definitionId: "r1", satisfied: true),
            ProjectDoneCriterion(definitionId: "r2", satisfied: true),
            ProjectDoneCriterion(definitionId: "r3", satisfied: false, landingReason: .onProjectBranch),
            ProjectDoneCriterion(definitionId: "r4", satisfied: false, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "r5", satisfied: false, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "r6", satisfied: false, landingReason: .codeless),
            ProjectDoneCriterion(definitionId: "r7", satisfied: false, landingReason: .codeless),
            ProjectDoneCriterion(definitionId: "r8", satisfied: false, landingReason: .codeless),
        ])
        XCTAssertEqual(ProjectDone.whyNotDoneTally(reported), "8 criteria · 2 on main · 6 not met")

        // Met criteria keep their landing reasons; an unmet one on main is not met, not on main.
        let mixed = ProjectDerivedDone(criteria: [
            ProjectDoneCriterion(definitionId: "m1", satisfied: true),
            ProjectDoneCriterion(definitionId: "m2", satisfied: true, landingReason: .inFlight),
            ProjectDoneCriterion(definitionId: "m3", satisfied: true, landingReason: .onProjectBranch),
            ProjectDoneCriterion(definitionId: "m4", satisfied: true, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "m5", satisfied: true, landingReason: .nothingToLand),
            ProjectDoneCriterion(definitionId: "m6", satisfied: true, landingReason: .codeless),
            ProjectDoneCriterion(definitionId: "m7", satisfied: false),
        ])
        XCTAssertEqual(ProjectDone.whyNotDoneTally(mixed),
                       "7 criteria · 1 on main · 1 in flight · 1 on the project branch · 1 merged outside Orbit"
                           + " · 1 nothing to land · 1 no code to land · 1 not met")

        // The card this gate draws: every criterion met, so nothing reads "not met".
        XCTAssertEqual(ProjectDone.whyNotDoneTally(project().derivedDone), "2 criteria · 1 on main · 1 merged outside Orbit")
        XCTAssertEqual(ProjectDone.whyNotDoneTally(antdMigration().derivedDone), "6 criteria · 0 on main · 6 not met")
        XCTAssertEqual(ProjectDone.whyNotDoneTally(nil), "")

        for derived in [reported, mixed, project().derivedDone!, antdMigration().derivedDone!] {
            let tally = ProjectDone.whyNotDoneTally(derived)
            let sum = partsSum(tally)
            XCTAssertEqual(sum.head, derived.criteria.count, tally)
            XCTAssertEqual(sum.parts, derived.criteria.count, "\(tally) does not add up to its criteria")
            let unmet = derived.criteria.filter { !$0.satisfied }.count
            XCTAssertEqual(tally.contains("\(unmet) \(ProjectDone.notMet)"), unmet > 0, tally)
        }
        XCTAssertEqual(ProjectDone.notMet, "not met")
    }

    // MARK: the conversation's read carries what the gate reads

    /// `GET /projects/:id` as the conversation reads it: `tasksByStatus` rides on the subject the
    /// slot is asked about, the same as the project page's read of the same document.
    func testTheConversationsReadCarriesTheRunningTally() throws {
        func document(_ tasksByStatus: String) -> Data {
            Data(#"""
            {"id":"p1","title":"Closeout","status":"OPEN","startedAt":"2026-10-01T00:00:00.000Z",
             "_count":{"tasks":5},\#(tasksByStatus)
             "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"It ships"}],
             "derivedDone":{"status":"OPEN","done":false,"withheld":["CRITERION_UNLANDED"],"confirmation":"CONFIRMED",
                            "criteria":[{"definitionId":"c1","satisfied":true,"landing":"UNKNOWN","landingReason":"NO_RECEIPT",
                                         "withheld":["CRITERION_UNLANDED"]}],
                            "counts":{"criteria":1,"met":1,"landed":0,"onMain":0,
                                      "byReason":{"IN_FLIGHT":0,"ON_PROJECT_BRANCH":0,"NOTHING_TO_LAND":0,"NO_RECEIPT":1,"CODELESS":0}}}}
            """#.utf8)
        }
        let running = try JSONDecoder().decode(ProjectCriteriaDocument.self,
                                               from: document(#""tasksByStatus":{"IN_PROGRESS":1,"DONE":4},"#))
        XCTAssertEqual(running.doneSubject.tasksByStatus, ["IN_PROGRESS": 1, "DONE": 4])
        XCTAssertEqual(ProjectDone.slot(subject: running.doneSubject, request: nil, waitingKind: nil, record: nil,
                                        started: running.started), .none)
        let page = try JSONDecoder().decode(ProjectDocument.self,
                                            from: document(#""tasksByStatus":{"IN_PROGRESS":1,"DONE":4},"#))
        XCTAssertEqual(page.doneSubject, running.doneSubject,
                       "the page and the conversation read the same facts off the same document")

        let stopped = try JSONDecoder().decode(ProjectCriteriaDocument.self,
                                               from: document(#""tasksByStatus":{"DONE":5},"#))
        XCTAssertEqual(ProjectDone.slot(subject: stopped.doneSubject, request: nil, waitingKind: nil, record: nil,
                                        started: stopped.started), .notDone)
        let again = try JSONDecoder().decode(ProjectCriteriaDocument.self, from: JSONEncoder().encode(running))
        XCTAssertEqual(again.tasksByStatus, running.tasksByStatus, "the tally survives the cache round trip")
    }
}
