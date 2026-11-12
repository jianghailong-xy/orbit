import Foundation
import XCTest
@testable import OrbitKit

/// The done card's follow-ups (`ProjectDoneFollowUps.swift`), held to the browser's own examples in
/// `components/ProjectDoneFollowUps.test.tsx` and `ProjectDoneRecords.test.tsx`: the CBAI shape on
/// the decided board ③, Ran without a branch (board ④), and the criteria met by confirmation
/// (follow-up board 03). The words themselves are `ProjectDoneCopyParityTests`'.
final class ProjectDoneFollowUpsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func finding(_ json: String) throws -> ProjectDoneFinding {
        try JSONDecoder().decode(ProjectDoneFinding.self, from: Data(json.utf8))
    }

    /// Four criteria, three met, the fourth held by one open task, nothing landed.
    private func cbai(nonCode: Bool = false) -> ProjectDoneSubject {
        let texts = ["Criterion 1 (placeholder text)", "Criterion 2 (91 tasks)", "Criterion 3 (2 tasks)",
                     "External prerequisites settled"]
        let items = texts.enumerated().map {
            ProjectDoneSubject.Criterion(id: "c\($0.offset + 1)", key: "k\($0.offset + 1)",
                                         ordinal: $0.offset + 1, text: $0.element, revision: 1)
        }
        let criteria = items.enumerated().map {
            ProjectDoneCriterion(definitionId: $0.element.id, satisfied: $0.offset < 3, landing: "UNKNOWN",
                                 landingReason: nonCode ? nil : .codeless)
        }
        let counts = ProjectDoneCounts(criteria: 4, met: 3, landed: 0, onMain: 0,
                                       byReason: nonCode ? [:] : [.codeless: 4])
        return ProjectDoneSubject(
            title: "CBAI Phase 0", status: "OPEN", criteria: items,
            derivedDone: ProjectDerivedDone(withheld: ["CRITERION_UNSATISFIED"], criteria: criteria,
                                            counts: counts, nonCode: nonCode),
            projectID: "P1",
            nonCodeMark: nonCode ? NonCodeMark(setBy: "COORDINATOR", setAt: "2026-11-11T10:20:00.000Z") : nil)
    }

    private var unmet4: ProjectDoneFinding {
        get throws {
            try finding(#"""
            {"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"diagnostic","requiredAction":"",
             "criterion":{"key":"k4","ordinal":4,"text":"External prerequisites settled"},"reason":null,
             "tasks":[{"taskId":"T1","title":"Settle external prerequisites (SMS, WeChat, payment, ICP)"}],
             "items":[],"jobs":[]}
            """#)
        }
    }

    // MARK: the decided board ③

    func testTheCBAIShapeIsOneBlockerNamingItsOpenTask() throws {
        let findings = ProjectDone.Findings([try unmet4])
        XCTAssertEqual(findings.blockingHeading, "1 thing stands in the way")
        XCTAssertNil(findings.warningsHeading)
        XCTAssertEqual(findings.unmet.first?.line(main: "main"), "Criterion 4 is not met — 1 task is still open")
        XCTAssertEqual(findings.unmet.first?.tasks.first?.title,
                       "Settle external prerequisites (SMS, WeChat, payment, ICP)")
        XCTAssertEqual(ProjectDone.moveHint(4), "takes criterion 4 and its open tasks out of this project")
        XCTAssertEqual(findings.explanation,
                       "If you record it done anyway, Orbit keeps criterion 4 as the gap you accepted.")
        // Its row is "not met" and nothing more — never "No code to land".
        let subject = cbai()
        XCTAssertEqual(ProjectDone.criterionRowState(subject.derivedDone!.criteria[3]).text, "not met")
    }

    func testRefusalsStandInTheWayAndLandingWarningsAreWhatOrbitCannotProve() throws {
        let running = try finding(#"{"severity":"REFUSE","code":"DONE_TASKS_IN_FLIGHT","message":"m","criterion":null,"tasks":[{"taskId":"a","title":"A"},{"taskId":"b","title":"B"}],"items":[],"jobs":[]}"#)
        let unlanded = try finding(#"{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"k2","ordinal":2,"text":""},"reason":"NO_RECEIPT","tasks":[],"items":[],"jobs":[]}"#)
        let findings = ProjectDone.Findings([unlanded, running])
        XCTAssertEqual(findings.blockingHeading, "1 thing stands in the way")
        XCTAssertEqual(findings.otherRefusals.map { $0.line(main: "main") }, ["2 tasks are still running"])
        XCTAssertEqual(findings.warningsHeading, "Orbit can’t prove 1 thing")
        XCTAssertEqual(findings.warnings.map { $0.line(main: "main") }, ["Criterion 2 is not on main"])
        XCTAssertEqual(findings.explanation, ProjectDone.findingsAccepted)
        XCTAssertEqual(ProjectDone.Findings([try unmet4, try unmet4]).blockingHeading, "2 things stand in the way")
        XCTAssertEqual(ProjectDone.criteriaPhrase([3, 4]), "criteria 3 and 4")
        XCTAssertEqual(ProjectDone.criteriaPhrase([2, 3, 4]), "criteria 2, 3 and 4")
    }

    func testANonCodeProjectReadsNoLanding() throws {
        let subject = cbai(nonCode: true)
        XCTAssertTrue(subject.nonCode)
        XCTAssertEqual(ProjectDone.nonCodeProvenance(subject.nonCodeMark, timeZone: utc),
                       "Marked by the coordinator · Nov 11")
        XCTAssertEqual(ProjectDone.nonCodeProvenance(subject.nonCodeMark, withTime: true, timeZone: utc),
                       "Marked by the coordinator · Nov 11, 10:20")
        XCTAssertEqual(ProjectDone.nonCodeProvenance(NonCodeMark(setBy: "OWNER"), timeZone: utc), "Marked by you")
        XCTAssertNil(ProjectDone.nonCodeProvenance(nil))
        XCTAssertEqual(ProjectDone.nonCodeReasonLine(NonCodeMark(reason: " All work is documents. ")),
                       "“All work is documents.”")
        XCTAssertNil(ProjectDone.nonCodeReasonLine(NonCodeMark(reason: "  ")))
        XCTAssertEqual(ProjectDone.cardTally(subject), "3 of 4 met")
        XCTAssertEqual(ProjectDone.whyNotDoneTally(subject.derivedDone), "4 criteria · 3 met · 1 not met")
        let met = ProjectDoneCriterion(definitionId: "x", satisfied: true, landingReason: .noBranch)
        XCTAssertEqual(ProjectDone.criterionRowState(met, nonCode: true).text, "met")
        XCTAssertEqual(ProjectDone.receiptTally(subject.counts, acceptedGaps: 0, nonCode: true),
                       "4 criteria met · 0 gaps accepted")
        for line in [ProjectDone.cardTally(subject), ProjectDone.whyNotDoneTally(subject.derivedDone)] {
            XCTAssertNil(line.range(of: "landed|nothing to land|No code to land|Landed on", options: .regularExpression))
        }
    }

    func testTheMarkIsReadOffTheProjectDocument() throws {
        let json = #"""
        {"id":"P1","title":"CBAI","status":"OPEN","nonCode":true,"nonCodeSetBy":"COORDINATOR",
         "nonCodeSetAt":"2026-11-11T10:20:00.000Z","nonCodeReason":"All documents",
         "criteriaMovedOut":[{"criterionKey":"k4","definitionId":"c4","ordinal":4,"text":"External",
           "toProjectId":"P2","toProjectTitle":"CBAI · follow-up","movedAt":"2026-11-11T19:40:00.000Z"}],
         "acceptanceCriteriaItems":[{"id":"c1","key":"k1","ordinal":1,"text":"One","revision":3,
           "verificationMethod":"Look","satisfiedBy":"CONFIRMATION","satisfied":false,
           "confirmation":{"state":"UNCONFIRMED","current":null,"stale":false,"checkRunning":null},
           "movedFrom":{"fromProjectId":"P0","fromProjectTitle":"Origin","movedAt":"2026-11-11T19:40:00.000Z"}}],
         "derivedDone":{"status":"OPEN","done":false,"withheld":[],"criteria":[],"confirmation":"CONFIRMED",
           "counts":{"criteria":1,"met":0,"landed":0,"onMain":0,"byReason":{}},"nonCode":true}}
        """#
        let document = try JSONDecoder().decode(ProjectDocument.self, from: Data(json.utf8))
        XCTAssertTrue(document.nonCode)
        XCTAssertEqual(document.followUps.nonCodeMark, NonCodeMark(setBy: "COORDINATOR",
                                                                   setAt: "2026-11-11T10:20:00.000Z",
                                                                   reason: "All documents"))
        let subject = document.doneSubject
        XCTAssertEqual(subject.projectID, "P1")
        XCTAssertEqual(subject.criteria.first?.revision, 3)
        XCTAssertEqual(subject.criteria.first?.verificationMethod, "Look")
        XCTAssertEqual(ProjectDone.movedOutLead(subject.criteriaMovedOut[0]), "Criterion 4 moved to")
        XCTAssertEqual(ProjectDone.movedByLine(subject.criteriaMovedOut[0].movedAt, timeZone: utc),
                       "by you · Nov 11, 19:40")
        let item = document.acceptanceCriteriaItems[0]
        XCTAssertEqual(item.satisfiedBy, .confirmation)
        XCTAssertEqual(item.movedFrom?.fromProjectTitle, "Origin")
        XCTAssertEqual(item.confirmation?.state, "UNCONFIRMED")
        // A round trip keeps the mark.
        let again = try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(document))
        XCTAssertEqual(again.followUps, document.followUps)
        // An older document says nothing, and is not marked.
        let old = try JSONDecoder().decode(ProjectDocument.self, from: Data(#"{"id":"P","title":"T"}"#.utf8))
        XCTAssertFalse(old.nonCode)
        XCTAssertEqual(old.acceptanceCriteriaItems.count, 0)
    }

    // MARK: Ran without a branch (board ④)

    func testRanWithoutABranchLabelsTheRowTheTallyAndTheFinding() throws {
        let counts = ProjectDoneCounts(criteria: 3, met: 3, landed: 2, onMain: 2, byReason: [.noBranch: 1])
        XCTAssertEqual(ProjectDone.cardTally(counts), "3 met · 2 landed on main · 1 ran without a branch")
        let row = ProjectDone.criterionRowState(
            ProjectDoneCriterion(definitionId: "c3", satisfied: true, landing: "UNKNOWN", landingReason: .noBranch))
        XCTAssertEqual(row.text, "met · Ran without a branch")
        XCTAssertTrue(row.warn)
        let tasks = (0..<6).map { #"{"taskId":"t\#($0)","title":"t\#($0)"}"# }.joined(separator: ",")
        let noBranch = try finding(#"{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"k3","ordinal":3,"text":"Criterion 3"},"reason":"NO_BRANCH","tasks":[\#(tasks)],"items":[],"jobs":[]}"#)
        XCTAssertEqual(noBranch.line(main: "main"),
                       "Criterion 3: 6 tasks ran without a branch, so Orbit can’t see whether their changes reached main. "
                           + "Check main yourself before recording it done.")
        XCTAssertEqual(ProjectDone.cardTally(ProjectDoneCounts(criteria: 2, met: 2, landed: 2, onMain: 2)),
                       "2 met · 2 landed on main")
    }

    func testEveryUnlandedFindingReadsItsReason() throws {
        func at(_ reason: String) throws -> String {
            try finding(#"{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"k","ordinal":2,"text":""},"reason":"\#(reason)","tasks":[],"items":[],"jobs":[]}"#)
                .line(main: "master")
        }
        XCTAssertEqual(try at("NO_RECEIPT"), "Criterion 2 is not on master")
        XCTAssertEqual(try at("ON_PROJECT_BRANCH"), "Criterion 2 is on the project branch, not on master yet")
        XCTAssertEqual(try at("IN_FLIGHT"), "Criterion 2 is being landed on master")
        XCTAssertEqual(try at("NOTHING_TO_LAND"), "Criterion 2 has nothing to land")
        XCTAssertEqual(try at("CODELESS"), "Criterion 2 has no code to land")
        XCTAssertTrue(try at("NO_BRANCH").hasPrefix("Criterion 2: its work ran without a branch"))
        XCTAssertEqual(try at("SOMETHING_NEW"), "Criterion 2 is not on master")
    }

    func testAnUnmetFindingNamesWhatHoldsIt() throws {
        let two = try finding(#"{"code":"DONE_CRITERION_UNSATISFIED","message":"m","criterion":{"ordinal":5},"tasks":[{"taskId":"a"},{"taskId":"b"}],"items":[],"jobs":[]}"#)
        XCTAssertEqual(two.line(main: "main"), "Criterion 5 is not met — 2 tasks are still open")
        XCTAssertEqual(two.line(main: "main", confirmation: true), "Criterion 5 is not met — it waits for confirmation")
        // A finding from an older server says no severity: it still sorts by its code.
        let findings = ProjectDone.Findings([two])
        XCTAssertEqual(findings.unmet.count, 1)
        XCTAssertTrue(findings.otherRefusals.isEmpty)
    }

    // MARK: criteria met by confirmation (board 03)

    private func view(_ kind: String, note: String? = "Aliyun SMS template approved", outcome: String = "CONFIRMED",
                      attachments: [String] = []) -> CriterionConfirmationView {
        CriterionConfirmationView(confirmerKind: kind, outcome: outcome, revision: 1,
                                  sessionId: kind == "OWNER" ? nil : "S1", note: note,
                                  attachmentIds: attachments, at: "2026-11-10T08:02:00.000Z")
    }

    func testTheDoneCardSaysWhoConfirmedAndWhatWaits() {
        let criteria = [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true, satisfiedBy: .confirmation,
                                 confirmation: .init(state: "CONFIRMED", current: view("OWNER"))),
            ProjectDoneCriterion(definitionId: "c3", satisfied: false, satisfiedBy: .confirmation,
                                 confirmation: .init(state: "UNCONFIRMED")),
            ProjectDoneCriterion(definitionId: "c4", satisfied: false, satisfiedBy: .confirmation,
                                 confirmation: .init(state: "STALE", current: view("OWNER"), stale: true)),
            ProjectDoneCriterion(definitionId: "c5", satisfied: true, satisfiedBy: .confirmation,
                                 confirmation: .init(state: "CONFIRMED", current: view("AGENT_CHECK"))),
            ProjectDoneCriterion(definitionId: "c6", satisfied: false, satisfiedBy: .confirmation,
                                 confirmation: .init(state: "UNCONFIRMED", checkRunning: view("AGENT_CHECK", note: nil))),
        ]
        let rows = criteria.map { ProjectDone.criterionRowState($0).text }
        XCTAssertEqual(rows, ["met · Landed on main", "met · by you", "not met · waits for confirmation",
                              "not met · confirmed for an earlier wording", "met · Agent check PASS",
                              "not met · checking…"])
        XCTAssertTrue(ProjectDone.criterionRowState(criteria[3]).warn)
        XCTAssertEqual(ProjectDone.confirmationLine(criteria[1].confirmation?.current, timeZone: utc),
                       "Confirmed by you · Nov 10 · “Aliyun SMS template approved”")
        XCTAssertEqual(ProjectDone.confirmationLine(view("OWNER", note: "SMS_4821 shows Approved.", attachments: ["f1"]),
                                                    timeZone: utc),
                       "Confirmed by you · Nov 10 · “SMS_4821 shows Approved.” · 1 screenshot")
        XCTAssertEqual(ProjectDone.waitingConfirmation(ProjectDerivedDone(criteria: criteria)), 3)
        let counts = ProjectDoneCounts(criteria: 6, met: 3, landed: 6, onMain: 6)
        XCTAssertEqual(ProjectDone.cardTally(counts, waitingConfirmation: 2),
                       "3 met · 6 landed on main · 2 wait for confirmation")
        XCTAssertEqual(ProjectDone.cardTally(counts, nonCode: true, waitingConfirmation: 2),
                       "3 of 6 met · 2 wait for confirmation")
        XCTAssertEqual(ProjectDone.confirmLabel(criteria[3].confirmation), "Confirm again…")
        XCTAssertEqual(ProjectDone.confirmLabel(criteria[2].confirmation), "Confirm…")
        XCTAssertEqual(ProjectDone.confirmSheetTitle(6), "Confirm criterion 6")
    }

    func testTheAcceptanceRowsSayEachConfirmer() {
        let now = RelativeTime.parse("2026-11-10T08:04:00.000Z")!
        let coordinator = ProjectDone.confirmationRow(.init(state: "CONFIRMED", current: view("COORDINATOR", note: "AppID shows Approved.")),
                                                      now: now, timeZone: utc)
        XCTAssertEqual(coordinator.sentence, "Met · confirmed by the coordinator")
        XCTAssertEqual(coordinator.note, "“AppID shows Approved.”")
        XCTAssertEqual(coordinator.when, "Nov 10, 08:02")
        XCTAssertEqual(coordinator.openConversation, "S1")
        XCTAssertTrue(coordinator.met)
        let passed = ProjectDone.confirmationRow(.init(state: "CONFIRMED", current: view("AGENT_CHECK", note: "merchant is Active")),
                                                 now: now, timeZone: utc)
        XCTAssertEqual(passed.sentence, "Met · Agent check passed")
        XCTAssertEqual(passed.note, "PASS — merchant is Active")
        XCTAssertEqual(passed.viewRun, "S1")
        let failed = ProjectDone.confirmationRow(.init(state: "CHECK_FAILED",
                                                       current: view("AGENT_CHECK", note: "no filing number", outcome: "FAILED")),
                                                 now: now, timeZone: utc)
        XCTAssertEqual(failed.sentence, "Not met · Agent check failed")
        XCTAssertEqual(failed.note, "FAIL — no filing number")
        XCTAssertEqual(ProjectDone.runCheckLabel(.init(state: "CHECK_FAILED")), "Run the check again")
        let stale = ProjectDone.confirmationRow(.init(state: "STALE", current: view("OWNER"), stale: true),
                                                now: now, timeZone: utc)
        XCTAssertEqual(stale.sentence, "Not met · confirmed for an earlier wording")
        XCTAssertEqual(stale.note, "You confirmed revision 1 on Nov 10. The wording has changed since.")
        XCTAssertNotNil(stale.staleConfirmation)
        let running = ProjectDone.confirmationRow(.init(state: "UNCONFIRMED", checkRunning: view("AGENT_CHECK", note: nil)),
                                                  now: now, timeZone: utc)
        XCTAssertEqual(running.sentence, "Checking… · Agent check running")
        XCTAssertEqual(running.when, "started 2m ago")
        XCTAssertTrue(running.running)
        XCTAssertEqual(ProjectDone.confirmationRow(nil).sentence, "Waits for confirmation")
        XCTAssertEqual(ProjectDone.acceptanceStanding(total: 5, confirmed: 4),
                       "5 criteria stated. 1 met by their tasks; 4 by a confirmation — from you, the coordinator, or an Agent check.")
        XCTAssertEqual(ProjectDone.metByLabel(.tasks), "Met by: its tasks")
        XCTAssertEqual(ProjectDone.metByLabel(.confirmation), "Met by: confirmation")
    }

    func testTheConfirmAndModeWritesAreTheBrowsers() throws {
        let body = ConfirmCriterionBody(note: "  ", revision: 2, attachmentIds: [])
        XCTAssertEqual(String(data: try JSONEncoder().encode(body), encoding: .utf8), #"{"revision":2}"#)
        let full = ConfirmCriterionBody(note: " ICP 123 ", revision: 2, attachmentIds: ["a"])
        XCTAssertEqual(full.note, "ICP 123")
        let criteria = [
            ProjectCriterion(id: "c1", ordinal: 1, text: "One", verificationMethod: "Look"),
            ProjectCriterion(id: "c2", ordinal: 2, text: "Two", satisfiedBy: .confirmation),
        ]
        let mode = CriteriaModeBody(criteria: criteria, criterionID: "c1", mode: .confirmation)
        XCTAssertEqual(mode.acceptanceCriteriaItems.map(\.satisfiedBy), [.confirmation, .confirmation])
        XCTAssertEqual(mode.acceptanceCriteriaItems[1].verificationMethod, "")
    }

    // MARK: Move to a follow-up… (board 02)

    func testTheMoveSheetSaysWhatMovesWhatStaysAndWhere() {
        XCTAssertEqual(ProjectDone.moveTasksPhrase(1), "and its 1 open task")
        XCTAssertEqual(ProjectDone.moveTasksPhrase(3), "and its 3 open tasks")
        XCTAssertEqual(ProjectDone.moveFollowUpTitle("CBAI Phase 0"), "CBAI Phase 0 · follow-up")
        XCTAssertEqual(ProjectDone.moveFollowUpGoal("CBAI Phase 0", ordinal: 4), "Follow-up of “CBAI Phase 0”: criterion 4.")
        XCTAssertEqual(ProjectDone.moveKeepsLine(3, allMet: true), "This project keeps 3 criteria, all met.")
        XCTAssertEqual(ProjectDone.moveKeepsLine(3, allMet: true, confirming: true),
                       "This project keeps 3 criteria, all met. You can record it as done right after.")
        XCTAssertEqual(ProjectDone.moveKeepsLine(3, allMet: false, confirming: true), "This project keeps 3 criteria.")
        XCTAssertEqual(ProjectDone.moveConfirmTitle(4, project: "CBAI Phase 1"), "Move criterion 4 to “CBAI Phase 1”?")
        XCTAssertEqual(ProjectDone.moveConfirmDestination("CBAI Phase 1", ordinal: 4, openTasks: 1, newProject: false),
                       "CBAI Phase 1 gets criterion 4 and its 1 open task, after its own criteria.")
        XCTAssertEqual(ProjectDone.moveConfirmDestination("CBAI · follow-up", ordinal: 4, openTasks: 0, newProject: true),
                       "CBAI · follow-up is created, not started, and gets criterion 4.")
        XCTAssertEqual(ProjectDone.moveConfirmAction(4), "Move criterion 4")
        let new = MoveCriterionBody.new(title: "F", goal: "G")
        XCTAssertNil(new.toProjectId)
        XCTAssertEqual(MoveCriterionBody.existing("P2").toProjectId, "P2")
    }

    func testOwnerInitiatedPressIsPlainOnceEverythingLeftIsMet() {
        let counts = ProjectDoneCounts(criteria: 3, met: 3, landed: 0, onMain: 0)
        XCTAssertEqual(ProjectDone.recordLabel(counts, asked: false, check: ProjectDoneCheck(findings: [])), "Record as done")
        XCTAssertEqual(ProjectDone.recordLabel(counts, asked: false, check: nil), "Record as done anyway")
    }
}
