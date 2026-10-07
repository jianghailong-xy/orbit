import Foundation
import XCTest
@testable import OrbitKit

/// What a coordinator conversation draws about closing a project — and what it no longer draws.
///
/// "Why is this project not done?" is gone from the conversation: the owner's ruling of 2026-10-07
/// 04:20Z keeps the close-out request-driven, so a project nobody has asked about and nothing has
/// recorded draws NOTHING here — every state of it: every criterion met, one unmet, six unmet, a
/// task in flight, none started, no criteria stated, a read without counts. The gaps, and the
/// entries that act on them, are the project page's Open items row and the Needs you hint.
///
/// Three drawings stay, and each is asserted here with the words it puts on screen:
///   • a DONE_REQUEST (or the row's Record as done…, or this conversation's own press) → "Is this
///     project done?", whose press records the project and leaves its receipt;
///   • status DONE recorded by Orbit → "This project is done · recorded by Orbit";
///   • status DONE recorded by the owner → "You recorded this project done".
///
/// The browser holds the same rule in `ProjectDoneConversation.test.tsx` (which draws the same
/// states), and `ProjectDoneCopyParityTests` reads that file's source against this client's words.
final class ProjectDoneConversationTests: XCTestCase {

    private let utc = TimeZone(identifier: "UTC")!

    private let request = DoneRequest(criteriaDigest: String(repeating: "d", count: 64),
                                      judgment: "Every criterion is met and on main.",
                                      gaps: [AcceptedGap(criterionKey: "c2", title: "The live check ran",
                                                          whyNotProven: "No receipt.")])

    private func row(itemID: String = "req1") -> ProjectOpenItemRow {
        ProjectOpenItemRow(itemId: itemID, kind: .unknown, title: ProjectDone.heading, waitingSince: "",
                           doneRequest: request)
    }

    /// A project with criteria to be done against, in whichever state the case is about.
    private func project(status: String = "OPEN", done: Bool = false, doneBy: ProjectDoneBy? = nil,
                         doneAt: String? = nil, acceptedGaps: [AcceptedGap] = [],
                         criteria: [ProjectDoneCriterion]? = nil) -> ProjectDoneSubject {
        let answers = criteria ?? [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true, landing: "UNKNOWN", landingReason: .noReceipt),
        ]
        return ProjectDoneSubject(title: "Closeout", status: status,
                                  criteria: answers.enumerated().map {
                                      .init(id: $0.element.definitionId, ordinal: $0.offset + 1,
                                            text: "criterion \($0.offset + 1)")
                                  },
                                  derivedDone: ProjectDerivedDone(
                                      status: done ? "DONE" : "OPEN", done: done,
                                      withheld: done ? [] : ["CRITERION_UNLANDED"], criteria: answers,
                                      counts: ProjectDoneCounts(criteria: answers.count,
                                                                met: answers.filter(\.satisfied).count,
                                                                landed: 0, onMain: 0)),
                                  doneBy: doneBy, doneAt: doneAt, acceptedGaps: acceptedGaps)
    }

    private func slot(_ subject: ProjectDoneSubject?, request: ProjectOpenItemRow? = nil,
                      waitingKind: SessionWaitingKind? = nil,
                      record: ProjectDoneRecord? = nil) -> ProjectDone.Slot {
        ProjectDone.slot(subject: subject, request: request, waitingKind: waitingKind, record: record)
    }

    // MARK: the card that is not drawn

    func testNoOpenProjectNobodyAskedAboutDrawsAWhyNotDoneCard() {
        // The state the card used to be drawn in: started, OPEN, every criterion met by its work,
        // nothing IN_PROGRESS, and a projection that still withholds one landing.
        XCTAssertEqual(slot(project()), .none, "every criterion met and nothing running")
        // And the states it was deliberately never drawn in, which are no more a card now.
        XCTAssertEqual(slot(project(criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: false, landing: "UNKNOWN", landingReason: .codeless),
        ])), .none, "one criterion not met yet")
        XCTAssertEqual(slot(project(criteria: (1...6).map {
            ProjectDoneCriterion(definitionId: "a\($0)", satisfied: false, landing: "UNKNOWN",
                                 landingReason: .onProjectBranch)
        })), .none, "six criteria not met yet — the project the owner reported on 2026-10-06")
        XCTAssertEqual(slot(project(criteria: [])), .none, "no criteria stated")
        XCTAssertEqual(slot(project(status: "CANCELLED")), .none, "not OPEN")
        XCTAssertEqual(slot(project(done: true)), .none, "the projection already calls it done")
        XCTAssertEqual(slot(nil), .none, "a read that has not answered is not an answer")
        let older = ProjectDoneSubject(title: "t", status: "OPEN", derivedDone: ProjectDerivedDone(
            criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true)], counts: nil))
        XCTAssertEqual(slot(older), .none, "a server without counts draws no card")
    }

    /// The words of the card that is gone are not on screen in any of those states: nothing in this
    /// client draws `ProjectDone.whyHeading` for a project that is not recorded done, and the two
    /// groups the card had belong to a view reached only from the terminal state below.
    func testTheGoneCardsWordsReachNoConversationThatIsNotRecordedDone() {
        XCTAssertEqual(ProjectDone.whyHeading, "Why is this project not done?")
        let open = project()
        XCTAssertFalse(ProjectDone.recorded(open, record: nil))
        XCTAssertEqual(slot(open), .none)
        // The terminal state is the one drawing that still holds those words' view — and it is a
        // DONE project, which nothing asks a question about.
        let terminal = project(status: "DONE", done: true, doneBy: .derived)
        XCTAssertEqual(slot(terminal), .notDone)
        XCTAssertTrue(ProjectDone.recorded(terminal, record: nil))
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: terminal, withCoordinator: 0, requested: false)
                        .settled(terminal),
                      "the terminal drawing is the settled card, never the question")
    }

    // MARK: the three drawings that stay

    func testARequestDrawsTheOwnerCardWhosePressLeavesItsReceipt() {
        let asked = slot(project(), request: row(), waitingKind: .doneRequest)
        XCTAssertEqual(asked, .done(requestID: "req1"))
        // The card the request draws: its question, the coordinator's call, and both answers.
        XCTAssertEqual(ProjectDone.heading, "Is this project done?")
        XCTAssertEqual(ProjectDone.coordinatorCall, "Coordinator’s call")
        XCTAssertEqual(ProjectDone.notYet, "Not yet…")
        XCTAssertEqual(ProjectDone.recordLabel(project().counts), ProjectDone.recordAsDone)
        // The press sends the request it answers, that request's own seal, and the gaps it showed.
        XCTAssertEqual(ProjectDone.body(subject: project(), requestID: "req1", request: request,
                                        currentDigest: "wrong-digest"),
                       ProjectDoneRequestBody(requestId: "req1", criteriaDigest: request.criteriaDigest,
                                              acceptedGaps: request.gaps))
        // And what it leaves behind: the receipt, read off the record the door wrote.
        let record = ProjectDoneRecord(projectId: "p1", doneBy: .owner, doneAt: "2026-10-07T04:30:00.000Z",
                                       criteriaDigest: request.criteriaDigest, acceptedGaps: request.gaps,
                                       requestId: "req1")
        XCTAssertEqual(slot(project(), record: record), .done(requestID: nil),
                       "the receipt keeps the card where the press left it")
        XCTAssertEqual(ProjectDone.receiptLine(project(), record: record, timeZone: utc),
                       "You recorded this project done · Oct 7, 04:30")
    }

    func testTheUnaskedReminderDrawsTheOwnerCardToo() {
        XCTAssertEqual(slot(project(), waitingKind: .recordAsDone), .done(requestID: nil),
                       "the row's Record as done… puts the owner's card up without a request")
        XCTAssertEqual(ProjectDone.meta(projectTitle: "Closeout", asked: false, waiting: nil),
                       "Closeout · record as done anyway")
        XCTAssertEqual(ProjectDone.recordLabel(nil), ProjectDone.recordAsDone)
    }

    func testOrbitsDoneDrawsTheTerminalCardAndTheOwnersDoneItsReceipt() {
        let orbitDone = project(status: "DONE", done: true, doneBy: .derived,
                                doneAt: "2026-10-07T05:00:00.000Z")
        XCTAssertEqual(slot(orbitDone), .notDone)
        XCTAssertEqual(ProjectDone.receiptLine(orbitDone, record: nil, timeZone: utc),
                       "This project is done · recorded by Orbit")
        XCTAssertEqual(ProjectDone.settledBadge(orbitDone.doneBy), ProjectDone.recordedByOrbit)
        let unrecorded = project(status: "DONE", done: true)
        XCTAssertEqual(slot(unrecorded), .notDone, "a server that does not say who is not the owner")
        XCTAssertEqual(ProjectDone.receiptLine(unrecorded, record: nil, timeZone: utc),
                       "This project is done · recorded by Orbit")

        let ownerDone = project(status: "DONE", done: true, doneBy: .owner,
                                doneAt: "2026-10-07T05:00:00.000Z",
                                acceptedGaps: [AcceptedGap(criterionKey: "c2", title: "The live check ran")],
                                criteria: [ProjectDoneCriterion(definitionId: "c2", satisfied: false,
                                                                landing: "UNKNOWN", landingReason: .codeless)])
        XCTAssertEqual(slot(ownerDone), .done(requestID: nil),
                       "the owner's DONE is the receipt, unmet criteria or not")
        XCTAssertEqual(ProjectDone.receiptLine(ownerDone, record: nil, timeZone: utc),
                       "You recorded this project done · Oct 7, 05:00")
        XCTAssertEqual(ProjectDone.provenance(doneBy: ownerDone.doneBy, acceptedGaps: ownerDone.acceptedGaps.count),
                       "recorded by you · 1 gaps accepted")
        XCTAssertEqual(ProjectDone.settledBadge(ownerDone.doneBy), ProjectDone.recordedByYou)
    }

    // MARK: the tap the ruling puts in the conversation's place

    /// The rows and hints a reader is sent to instead — untouched by this ruling, and held here so
    /// the conversation's silence is read as a move rather than a gap.
    func testTheProjectPageStillCarriesTheRowsThatCloseAProject() {
        XCTAssertEqual(ProjectDone.readyToClose, "Ready to close")
        XCTAssertEqual(ProjectDone.requestRowDetail(row()), "The coordinator asked · 1 gaps it couldn’t prove")
        XCTAssertTrue(ProjectDone.readyToClose(status: .open, openItems: ProjectOpenItemsView(doneRequest: row())))
        XCTAssertFalse(ProjectDone.readyToClose(status: .open, openItems: ProjectOpenItemsView()))
        XCTAssertEqual(ProjectDone.recordAsDoneRow, "Record as done…")
        XCTAssertEqual(ProjectDone.notAskedYet, "not asked yet")
    }
}
