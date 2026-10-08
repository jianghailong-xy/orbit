import Foundation
import XCTest
@testable import OrbitKit

/// The derivations behind "Is this project done?", its receipt and "Why is this project not done?",
/// held to the browser's own examples (`ProjectDoneSettlementCard.test.tsx`) and to the payloads the
/// server serves. The words themselves are `ProjectDoneCopyParityTests`'.
final class ProjectDoneTests: XCTestCase {

    private let utc = TimeZone(identifier: "UTC")!

    /// The browser's fixture: two criteria, both met, one on main and one with nothing to land.
    private func closeout(status: String = "OPEN", done: Bool = false,
                          criteria: [ProjectDoneCriterion]? = nil,
                          counts: ProjectDoneCounts? = nil) -> ProjectDoneSubject {
        ProjectDoneSubject(
            title: "Project closeout", status: status,
            criteria: [.init(id: "c1", ordinal: 1, text: "The release is on main"),
                       .init(id: "c2", ordinal: 2, text: "The live check was completed")],
            derivedDone: ProjectDerivedDone(
                done: done, withheld: done ? [] : ["CRITERION_UNLANDED"],
                criteria: criteria ?? [
                    ProjectDoneCriterion(definitionId: "c1", satisfied: true),
                    ProjectDoneCriterion(definitionId: "c2", satisfied: true, landingReason: .nothingToLand),
                ],
                counts: counts ?? ProjectDoneCounts(criteria: 2, met: 2, landed: 2, onMain: 1,
                                                    byReason: [.nothingToLand: 1])))
    }

    private let request = DoneRequest(
        criteriaDigest: String(repeating: "a", count: 64),
        judgment: "The goal is met. I checked the release evidence below.",
        gaps: [AcceptedGap(criterionKey: "c2", title: "The live check was completed",
                           whyNotProven: "The task made no commits.",
                           coordinatorChecked: "main contains the release files",
                           evidenceRefs: ["run-42"])])

    // MARK: the counts

    func testTheTalliesAreTheBrowsersExamples() {
        let counts = closeout().counts
        XCTAssertEqual(ProjectDone.tally(counts), "2 criteria · 2 met · 1 landed on main · 1 nothing to land")
        XCTAssertEqual(ProjectDone.cardTally(counts), "2 met · 1 landed on main · 1 nothing to land")
        XCTAssertEqual(ProjectDone.receiptTally(counts, acceptedGaps: 1),
                       "2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted")
        // Its parts add up to the criteria: no "2 met" counted a second time beside where they are.
        XCTAssertEqual(ProjectDone.whyNotDoneTally(closeout().derivedDone), "2 criteria · 1 on main · 1 nothing to land")
        XCTAssertEqual(ProjectDone.tally(nil), "", "a read without counts says nothing rather than zeros")
    }

    func testNoCodeToLandIsCountedAsNothingToLandOnTheCardButNamedInTheTally() {
        let counts = ProjectDoneCounts(criteria: 7, met: 4, landed: 3, onMain: 3,
                                       byReason: [.inFlight: 1, .noReceipt: 1, .codeless: 2])
        XCTAssertEqual(ProjectDone.cardTally(counts), "4 met · 3 landed on main · 2 nothing to land")
        // The Why-not-done tally names it for a met criterion; an unmet one is not met, whatever its
        // landing lane says — the same seven criteria, counted by their own answers.
        let derived = ProjectDerivedDone(criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true),
            ProjectDoneCriterion(definitionId: "c3", satisfied: true, landingReason: .inFlight),
            ProjectDoneCriterion(definitionId: "c4", satisfied: true, landingReason: .codeless),
            ProjectDoneCriterion(definitionId: "c5", satisfied: false),
            ProjectDoneCriterion(definitionId: "c6", satisfied: false, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "c7", satisfied: false, landingReason: .codeless),
        ])
        XCTAssertEqual(ProjectDone.whyNotDoneTally(derived),
                       "7 criteria · 2 on main · 1 in flight · 1 no code to land · 3 not met")
    }

    // MARK: the owner card

    func testACardNobodyAskedForCarriesOrbitsOwnGaps() {
        let subject = closeout(criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true, landingReason: .nothingToLand),
        ])
        let gaps = ProjectDone.syntheticGaps(subject)
        XCTAssertEqual(gaps.map(\.criterionKey), ["c1"],
                       "nothing to land is an outcome, not a gap to paper over")
        XCTAssertEqual(gaps.first?.title, "The release is on main")
        XCTAssertEqual(gaps.first?.whyNotProven,
                       "Orbit cannot prove this criterion is on main: Merged outside Orbit.")
        let unmet = closeout(criteria: [ProjectDoneCriterion(definitionId: "c2", satisfied: false,
                                                             landingReason: .codeless)])
        XCTAssertEqual(ProjectDone.syntheticGaps(unmet).first?.whyNotProven,
                       "Orbit cannot prove this criterion is met by its work yet.",
                       "an unmet criterion is a gap whatever its landing says")
        XCTAssertEqual(ProjectDone.gaps(subject, request: request), request.gaps,
                       "a request's own gaps are the card's, not Orbit's")
    }

    func testThePressSendsTheRequestsSealAndItsGapsAsTheyCame() throws {
        let subject = closeout()
        let body = try XCTUnwrap(ProjectDone.body(subject: subject, requestID: "34Y7req", request: request,
                                                  currentDigest: "ignored"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(json["requestId"] as? String, "34Y7req")
        XCTAssertEqual(json["criteriaDigest"] as? String, request.criteriaDigest,
                       "the request's own seal, so a request whose criteria moved is refused")
        let gap = try XCTUnwrap((json["acceptedGaps"] as? [[String: Any]])?.first)
        XCTAssertEqual(gap["criterionKey"] as? String, "c2")
        XCTAssertEqual(gap["evidenceRefs"] as? [String], ["run-42"])

        // Nobody asked: the seal standing now, Orbit's gaps, and a null request — as the browser sends.
        let own = try XCTUnwrap(ProjectDone.body(subject: subject, requestID: nil, request: nil,
                                                 currentDigest: "b"))
        let ownJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(own)) as? [String: Any])
        XCTAssertTrue(ownJSON["requestId"] is NSNull, "the request is sent as null, not left out")
        XCTAssertEqual(ownJSON["criteriaDigest"] as? String, "b")
        XCTAssertNil(ProjectDone.body(subject: subject, requestID: nil, request: nil, currentDigest: nil),
                     "no seal read yet is no press")
    }

    func testAGapKeepsTheKeysItArrivedWith() throws {
        let raw = #"{"criterionKey":"c2","title":"t","whyNotProven":"w","coordinatorChecked":"c","evidenceRefs":["e"],"severity":"minor"}"#
        let gap = try JSONDecoder().decode(AcceptedGap.self, from: Data(raw.utf8))
        XCTAssertEqual(gap.coordinatorChecked, "c")
        let back = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(gap)) as? [String: Any])
        XCTAssertEqual(back["severity"] as? String, "minor", "a key this build has no words for is sent back")
        XCTAssertThrowsError(try JSONDecoder().decode(AcceptedGap.self, from: Data(#"{"title":"t"}"#.utf8)),
                             "a gap that names no criterion is not a gap")
    }

    func testTheNoteNotYetSendsIsTrimmedAndNeverEmpty() {
        XCTAssertEqual(ProjectDone.declineNote("  the deploy is not verified \n"), "the deploy is not verified")
        XCTAssertNil(ProjectDone.declineNote(" \n "))
    }

    /// The request the card answers is not one of the open items Orbit checked: the close check
    /// refuses a request while any other item is open, so a card the coordinator asked for says
    /// "no open items" — mock ⑤ ①'s line, word for word — rather than counting itself (evidence
    /// revision 1's seventh gap). Only that one request is left out, though: every other open item
    /// counts, the START_REQUEST kept beside the groups included (the coordinator's ruling,
    /// 2026-10-06; the browser's `orbitCheckedOpenItemCount` since ccb406ad0).
    func testOrbitCheckedCountsEveryOpenItemButTheRequestItAnswers() {
        let row = ProjectOpenItemRow(itemId: "i1", kind: .unknown, title: "", waitingSince: "")
        let asking = ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: ProjectDone.heading,
                                        waitingSince: "", doneRequest: request)
        let onlyTheRequest = ProjectOpenItemsView(doneRequest: asking)
        XCTAssertEqual(ProjectDone.openItemsCount(onlyTheRequest), 0)
        XCTAssertEqual(ProjectDone.orbitCheckedLine(counts: closeout().counts,
                                                    confirmedAt: "2026-09-29T10:00:00.000Z",
                                                    openItems: ProjectDone.openItemsCount(onlyTheRequest),
                                                    running: 0, timeZone: utc),
                       "Orbit checked: every criterion is met by its work · nothing running · no open items · "
                        + "criteria confirmed by you on Sep 29")
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(needsYou: [asking], doneRequest: asking)), 0,
                       "nor counted when a server lists it among the owner's rows too")
        // Every other item is open: the owner's and the coordinator's alike.
        let items = ProjectOpenItemsView(needsYou: [row], withCoordinator: [row, row], doneRequest: asking)
        XCTAssertEqual(ProjectDone.openItemsCount(items), 3)
        XCTAssertEqual(ProjectDone.orbitCheckedLine(counts: closeout().counts, confirmedAt: nil,
                                                    openItems: ProjectDone.openItemsCount(items), running: 0),
                       "Orbit checked: every criterion is met by its work · nothing running · 3 open items")
        // …a request to start the project too, and any other row: only the one under review is out.
        let other = ProjectOpenItemRow(itemId: "req0", kind: .unknown, title: ProjectDone.heading,
                                       waitingSince: "", doneRequest: request)
        let start = ProjectOpenItemRow(itemId: "s1", kind: .unknown, title: "", waitingSince: "")
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(needsYou: [other], startRequest: start,
                                                                       doneRequest: asking)), 2)
        // A card nobody asked for answers no request: nothing is left out.
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(needsYou: [row], startRequest: start)), 2)
        XCTAssertEqual(ProjectDone.openItemsCount(nil), 0)
        XCTAssertEqual(ProjectDone.runningCount(closeout(counts: ProjectDoneCounts(
            criteria: 3, met: 3, landed: 1, onMain: 1, byReason: [.inFlight: 2]))), 2)
    }

    // MARK: the receipt

    func testTheReceiptSaysWhoRecordedItAndWhatWasAccepted() {
        let record = ProjectDoneRecord(projectId: "p1", doneAt: "2026-10-01T01:40:00.000Z",
                                       criteriaDigest: "d", acceptedGaps: request.gaps)
        let subject = closeout()
        XCTAssertTrue(ProjectDone.recorded(subject, record: record))
        XCTAssertEqual(ProjectDone.receiptMeta(subject, record: record, timeZone: utc),
                       "Project closeout · recorded by you · 1 gaps accepted · Oct 1")
        XCTAssertEqual(ProjectDone.receiptLine(subject, record: record, timeZone: utc),
                       "You recorded this project done · Oct 1, 01:40")
        XCTAssertEqual(ProjectDone.receiptTally(subject, record: record),
                       "2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted")

        // Recorded at another end, read back off the document after a reload.
        let reloaded = ProjectDoneSubject(title: "Project closeout", status: "DONE",
                                          derivedDone: closeout().derivedDone, doneBy: .owner,
                                          doneAt: "2026-10-01T01:40:00.000Z", acceptedGaps: request.gaps)
        XCTAssertTrue(ProjectDone.recorded(reloaded, record: nil))
        XCTAssertEqual(ProjectDone.receiptLine(reloaded, record: nil, timeZone: utc),
                       "You recorded this project done · Oct 1, 01:40")
        XCTAssertFalse(ProjectDone.recorded(closeout(), record: nil))
        XCTAssertTrue(ProjectDone.recorded(closeout(status: "DONE", done: true), record: nil),
                      "a project Orbit recorded done is shown its receipt too")
        // The status is the record — not who recorded it once (the coordinator's ruling, 2026-10-06):
        // `doneBy` outlives a reopen, and a projection that says done on a project the read still calls
        // OPEN has not been recorded.
        let reopened = ProjectDoneSubject(title: "Project closeout", status: "OPEN",
                                          derivedDone: closeout().derivedDone, doneBy: .owner,
                                          doneAt: "2026-10-01T01:40:00.000Z", acceptedGaps: request.gaps)
        XCTAssertFalse(ProjectDone.recorded(reopened, record: nil))
        XCTAssertFalse(ProjectDone.recorded(closeout(done: true), record: nil))
    }

    // MARK: which card the coordinator conversation draws

    func testTheConversationDrawsOneCardAndAskingOutranksExplaining() {
        let row = ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: ProjectDone.heading,
                                     waitingSince: "", doneRequest: request)
        let open = closeout()
        // An OPEN project nobody has asked about draws nothing, however finished it looks: the
        // owner's ruling of 2026-10-07 04:20Z took "Why is this project not done?" out of the
        // conversation (`ProjectWhyNotDoneGateTests` holds that state by state).
        XCTAssertEqual(ProjectDone.slot(subject: open, request: nil, waitingKind: nil, record: nil), .none)
        XCTAssertEqual(ProjectDone.slot(subject: open, request: row, waitingKind: .doneRequest, record: nil),
                       .done(requestID: "req1"), "the coordinator's request puts the owner's card up")
        XCTAssertEqual(ProjectDone.slot(subject: open, request: nil, waitingKind: .recordAsDone, record: nil),
                       .done(requestID: nil),
                       "a project that looks finished and was not asked about in time gets the card unasked")
        // DONE: the owner's record keeps its receipt in the conversation; a DONE Orbit recorded
        // itself is the old card's terminal state, "This project is done · recorded by Orbit"
        // (the coordinator's ruling, 2026-10-06; the browser since ccb406ad0).
        let ownerDone = ProjectDoneSubject(title: "t", status: "DONE", derivedDone: open.derivedDone,
                                           doneBy: .owner)
        XCTAssertEqual(ProjectDone.slot(subject: ownerDone, request: nil, waitingKind: nil, record: nil),
                       .done(requestID: nil),
                       "the owner's DONE keeps its receipt in the conversation")
        let orbitDone = closeout(status: "DONE", done: true)
        XCTAssertEqual(ProjectDone.slot(subject: orbitDone, request: nil, waitingKind: nil, record: nil), .notDone,
                       "Orbit's DONE is the old card's terminal state")
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: orbitDone, withCoordinator: 0, requested: false)
                        .settled(orbitDone))
        XCTAssertEqual(ProjectDone.slot(subject: closeout(done: true), request: nil, waitingKind: nil,
                                        record: nil), .none,
                       "an OPEN project the projection already calls done is asked nothing")
        let older = ProjectDoneSubject(title: "t", status: "OPEN", derivedDone: ProjectDerivedDone(counts: nil))
        XCTAssertEqual(ProjectDone.slot(subject: older, request: row, waitingKind: .doneRequest, record: nil),
                       .none, "a server without counts draws no card")
        XCTAssertEqual(ProjectDone.slot(subject: nil, request: nil, waitingKind: nil, record: nil),
                       .none, "a read that has not answered is not an answer")
    }

    /// The card's whole life in one conversation, read the way the console adopts it after each
    /// read: asked, recorded, read back after a reload — with the projection still withholding, as
    /// it does whenever the owner accepted a gap — reopened, and Not yet… answered, which both end
    /// at nothing at all.
    func testTheReceiptOutlivesAReloadAndNotYetOrReopenEndAtNothing() {
        let row = ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: ProjectDone.heading,
                                     waitingSince: "", doneRequest: request)
        let asked = closeout()
        XCTAssertEqual(ProjectDone.slot(subject: asked, request: row, waitingKind: .doneRequest, record: nil),
                       .done(requestID: "req1"))

        // Record as done: the door's record turns the same card into its receipt, in place.
        let record = ProjectDoneRecord(projectId: "p1", doneAt: "2026-10-01T01:40:00.000Z",
                                       criteriaDigest: request.criteriaDigest, acceptedGaps: request.gaps)
        XCTAssertEqual(ProjectDone.slot(subject: asked, request: nil, waitingKind: nil, record: record),
                       .done(requestID: nil))

        // Reloaded: no record in hand, no request, and a projection that still says not done —
        // the owner's DONE is the record, and the receipt is what the conversation keeps.
        let reloaded = ProjectDoneSubject(title: "Project closeout", status: "DONE",
                                          criteria: asked.criteria, derivedDone: asked.derivedDone,
                                          doneBy: .owner, doneAt: record.doneAt,
                                          acceptedGaps: request.gaps)
        XCTAssertEqual(reloaded.derivedDone?.done, false)
        XCTAssertEqual(ProjectDone.slot(subject: reloaded, request: nil, waitingKind: nil, record: nil),
                       .done(requestID: nil),
                       "a project the owner recorded done keeps its receipt")
        XCTAssertEqual(ProjectDone.receiptLine(reloaded, record: nil, timeZone: utc),
                       "You recorded this project done · Oct 1, 01:40")
        XCTAssertEqual(ProjectDone.receiptTally(reloaded, record: nil),
                       "2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted")

        // Reopen project, or Not yet… on a request: nothing is asked, and the conversation draws
        // nothing in its place — not the old question, which no conversation asks any more.
        XCTAssertEqual(ProjectDone.slot(subject: asked, request: nil, waitingKind: nil, record: nil), .none)
        // Reopened at another end and read back: the read says OPEN while the record of who closed it
        // remains — the conversation shows neither that old receipt nor a question about it.
        let reopened = ProjectDoneSubject(title: "Project closeout", status: "OPEN",
                                          criteria: asked.criteria, derivedDone: asked.derivedDone,
                                          doneBy: .owner, doneAt: record.doneAt, acceptedGaps: request.gaps)
        XCTAssertEqual(ProjectDone.slot(subject: reopened, request: nil, waitingKind: nil, record: nil), .none)
    }

    func testTheRequestIsLiveOnlyOnAnOpenProjectWithARequestThisBuildCanRead() {
        let row = ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: "", waitingSince: "",
                                     doneRequest: request)
        let bare = ProjectOpenItemRow(itemId: "req2", kind: .unknown, title: "", waitingSince: "")
        XCTAssertEqual(ProjectDone.live(openItems: ProjectOpenItemsView(doneRequest: row), status: "OPEN"), row)
        XCTAssertNil(ProjectDone.live(openItems: ProjectOpenItemsView(doneRequest: row), status: "DONE"))
        XCTAssertNil(ProjectDone.live(openItems: ProjectOpenItemsView(doneRequest: bare), status: "OPEN"))
        XCTAssertNil(ProjectDone.live(openItems: nil, status: "OPEN"))
    }

    // MARK: the Why-not-done card

    func testOnlyHandledWorkSaysTheCoordinatorIsOnItAndOffersNoButton() {
        // The browser's case: the one gap is already in flight, and an item is with the coordinator.
        let subject = closeout(criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true,
                                                               landing: "ON_INTEGRATION_LINE",
                                                               landingReason: .inFlight)])
        let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: 1, requested: false)
        XCTAssertEqual(why.waiting.map(\.definitionId), ["c1"])
        XCTAssertTrue(why.coordinatorOnIt)
        XCTAssertNil(why.action, "Ask the coordinator would be a second door to work somebody has")
        XCTAssertTrue(why.saysCoordinatorIsOnIt)
        // In flight alone is somebody on it, even before the open-items read caught up.
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: subject, withCoordinator: 0, requested: false).coordinatorOnIt)
    }

    /// An unmet criterion's row says its work has not met it — not its landing lane, which for work
    /// still to do describes nothing that happened: "Merged outside Orbit" for a task whose branch
    /// has no receipt yet, "No code to land" for one that has written nothing (web
    /// `WHY_NOT_DONE_NOT_MET_YET`, the web fix of 2026-10-05). A met criterion keeps its lane.
    func testAnUnmetCriterionSaysNotMetYetInsteadOfItsLandingLane() {
        let unmet = ProjectDoneCriterion(definitionId: "c6", satisfied: false, landing: "UNKNOWN",
                                         landingReason: .noReceipt)
        let codeless = ProjectDoneCriterion(definitionId: "c7", satisfied: false, landing: "UNKNOWN",
                                            landingReason: .codeless)
        let merged = ProjectDoneCriterion(definitionId: "c4", satisfied: true, landing: "UNKNOWN",
                                          landingReason: .noReceipt)
        let branch = ProjectDoneCriterion(definitionId: "c3", satisfied: true, landing: "ON_INTEGRATION_LINE",
                                          landingReason: .onProjectBranch)
        XCTAssertEqual(ProjectDone.rowState(unmet), "Not met yet")
        XCTAssertEqual(ProjectDone.rowState(codeless), "Not met yet")
        XCTAssertEqual(ProjectDone.rowDetail(unmet, waitingOnWork: true), "Its work has not met this criterion yet.")
        XCTAssertEqual(ProjectDone.rowState(merged), "Merged outside Orbit")
        XCTAssertEqual(ProjectDone.rowDetail(merged, waitingOnWork: false), ProjectDone.needsCallDetail)
        XCTAssertEqual(ProjectDone.rowState(branch), "On the project branch")
        XCTAssertEqual(ProjectDone.rowDetail(branch, waitingOnWork: true), ProjectDone.waitingDetail)
    }

    /// The request's age, in `formatSpan`'s words beside "waiting" — the browser's
    /// `doneRequestWaiting` — and nothing at all for an instant that cannot be read.
    func testTheRequestSaysHowLongItHasWaited() {
        let now = RelativeTime.parse("2026-10-05T21:00:00.000Z")!
        XCTAssertEqual(ProjectDone.requestWaiting("2026-10-05T20:35:00.000Z", now: now), "waiting 25m")
        XCTAssertEqual(ProjectDone.requestWaiting("2026-10-05T17:40:00.000Z", now: now), "waiting 3h 20m")
        XCTAssertEqual(ProjectDone.requestWaiting("2026-10-05T20:59:50.000Z", now: now), "waiting 10s")
        XCTAssertEqual(ProjectDone.requestWaiting("2026-10-05T21:00:30.000Z", now: now), "waiting 1s",
                       "a request a little ahead of this clock has waited no time, as formatSpan says it")
        XCTAssertNil(ProjectDone.requestWaiting("not a time", now: now))
        XCTAssertNil(ProjectDone.requestWaiting(nil, now: now))
    }

    /// A project that states no criteria — and one that states plenty — are both asked nothing
    /// while nobody has asked to close them out: the conversation's silence does not depend on what
    /// the project says about itself.
    func testAProjectNobodyAskedAboutIsDrawnACardForNoProjectionAtAll() {
        let none = ProjectDoneSubject(title: "t", status: "OPEN", derivedDone: ProjectDerivedDone(
            done: false, withheld: ["NO_CRITERIA_STATED"], criteria: [],
            counts: ProjectDoneCounts(criteria: 0, met: 0, landed: 0, onMain: 0, byReason: [:])))
        XCTAssertEqual(ProjectDone.slot(subject: none, request: nil, waitingKind: nil, record: nil), .none)
        XCTAssertEqual(ProjectDone.slot(subject: closeout(), request: nil, waitingKind: nil, record: nil), .none)
    }

    func testUnmetCodelessWorkStaysWaitingOnWork() {
        // The browser's case: CODELESS is an outcome only once its criterion is met.
        let subject = closeout(criteria: [ProjectDoneCriterion(definitionId: "c2", satisfied: false,
                                                               landing: "UNKNOWN", landingReason: .codeless)],
                               counts: ProjectDoneCounts(criteria: 1, met: 0, landed: 0, onMain: 0,
                                                         byReason: [.codeless: 1]))
        let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: 0, requested: false)
        XCTAssertEqual(why.waiting.map(\.definitionId), ["c2"])
        XCTAssertFalse(why.settled(subject))
        XCTAssertEqual(why.action, .askCoordinator, "work nobody has is handed to the coordinator")
    }

    func testAMergeOrbitNeverSawIsTheOwnersCallAndARequestIsReviewed() {
        let subject = closeout(criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true, landingReason: .noReceipt),
            ProjectDoneCriterion(definitionId: "c2", satisfied: true, landingReason: .onProjectBranch),
        ])
        let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: 0, requested: true)
        XCTAssertEqual(why.needsCall.map(\.definitionId), ["c1"])
        XCTAssertEqual(why.waiting.map(\.definitionId), ["c2"])
        XCTAssertEqual(why.action, .review, "asked, the button is Review")
        let settled = closeout(done: true, criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true)])
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: settled, withCoordinator: 0, requested: false).settled(settled))
        // A DONE project is done whatever its criteria still say: nothing is left to ask "why not".
        let doneWithGaps = closeout(status: "DONE", criteria: [
            ProjectDoneCriterion(definitionId: "c1", satisfied: true, landingReason: .noReceipt)])
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: doneWithGaps, withCoordinator: 0, requested: false)
                        .settled(doneWithGaps))
    }

    // MARK: the project page

    func testThePageRowIsTheRequestOrTheOwnersOwnAndReadyToCloseNeedsARequest() {
        let row = ProjectOpenItemRow(itemId: "req1", kind: .unknown, title: "", waitingSince: "",
                                     doneRequest: request)
        let derived = closeout().derivedDone
        XCTAssertEqual(ProjectDone.pageRow(status: .open, derivedDone: derived,
                                           openItems: ProjectOpenItemsView(doneRequest: row)), .asked(row))
        XCTAssertEqual(ProjectDone.pageRow(status: .open, derivedDone: derived, openItems: ProjectOpenItemsView()),
                       .own)
        XCTAssertNil(ProjectDone.pageRow(status: .open, derivedDone: derived, openItems: nil),
                     "a request still on its way is not a project nobody asked about")
        XCTAssertNil(ProjectDone.pageRow(status: .done, derivedDone: derived, openItems: ProjectOpenItemsView()))
        XCTAssertNil(ProjectDone.pageRow(status: .open, derivedDone: ProjectDerivedDone(counts: nil),
                                         openItems: ProjectOpenItemsView()),
                     "an older server keeps the status door it had")
        XCTAssertTrue(ProjectDone.readyToClose(status: .open, openItems: ProjectOpenItemsView(doneRequest: row)))
        XCTAssertFalse(ProjectDone.readyToClose(status: .open, openItems: ProjectOpenItemsView()),
                       "Ready to close is the coordinator asking, not every open project")
    }

    // MARK: what the server serves

    /// A project document as `GET /projects/:id` serves it today, cut to the fields these cards
    /// read (the projection is this very project's, 2026-10-05).
    private let documentJSON = #"""
    {"id":"34Y7My8sqhKLWtmCQYv1l","title":"项目收尾重做","status":"DONE","doneBy":"OWNER",
     "doneAt":"2026-10-05T06:00:00.000Z","doneCriteriaDigest":"d",
     "acceptedGaps":[{"criterionKey":"7Q9QX5mhj3EEKrstr3A9g4","title":"Go-live","whyNotProven":"w",
                      "coordinatorChecked":"c","evidenceRefs":["e1"]}],
     "_count":{"tasks":29},"startedAt":"2026-10-01T02:20:05.780Z",
     "acceptanceCriteriaItems":[{"id":"5hLCySeZVhf9jPvwD7DrNZ","key":"5hLCySeZVhf9jPvwD7DrNZ","ordinal":1,
                                 "text":"codeless","satisfied":true,"landing":"LANDED"},
                                {"id":"7Q9QX5mhj3EEKrstr3A9g4","key":"7Q9QX5mhj3EEKrstr3A9g4","ordinal":7,
                                 "text":"上线","satisfied":false,"landing":"UNKNOWN"}],
     "derivedDone":{"status":"OPEN","done":false,"withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"],
                    "criteria":[{"definitionId":"5hLCySeZVhf9jPvwD7DrNZ","satisfied":true,"landing":"LANDED",
                                 "independence":"INDEPENDENT","conflicts":[],"remedy":null,"landingReason":null,
                                 "withheld":[]},
                                {"definitionId":"7Q9QX5mhj3EEKrstr3A9g4","satisfied":false,"landing":"UNKNOWN",
                                 "independence":"INDEPENDENT","conflicts":[],"remedy":null,
                                 "landingReason":"CODELESS","withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"]}],
                    "confirmation":"CONFIRMED",
                    "counts":{"criteria":2,"met":1,"landed":1,"onMain":1,
                              "byReason":{"IN_FLIGHT":0,"ON_PROJECT_BRANCH":0,"NOTHING_TO_LAND":0,"NO_RECEIPT":0,"CODELESS":1}}}}
    """#

    func testBothDocumentReadsCarryTheProjectionAndTheRecord() throws {
        let page = try JSONDecoder().decode(ProjectDocument.self, from: Data(documentJSON.utf8))
        let console = try JSONDecoder().decode(ProjectCriteriaDocument.self, from: Data(documentJSON.utf8))
        XCTAssertEqual(page.doneSubject, console.doneSubject,
                       "the page and the conversation read the same facts off the same document")
        let subject = page.doneSubject
        XCTAssertEqual(subject.doneBy, .owner)
        XCTAssertEqual(subject.acceptedGaps.map(\.criterionKey), ["7Q9QX5mhj3EEKrstr3A9g4"])
        XCTAssertEqual(subject.counts?.count(.codeless), 1)
        XCTAssertEqual(subject.derivedDone?.criteria.last?.landingReason, .codeless)
        XCTAssertEqual(subject.criterion("7Q9QX5mhj3EEKrstr3A9g4")?.ordinal, 7)
        XCTAssertEqual(ProjectDone.receiptLine(subject, record: nil, timeZone: utc),
                       "You recorded this project done · Oct 5, 06:00")
        // And the page's document survives its own cache round trip.
        let again = try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(page))
        XCTAssertEqual(again.doneSubject, subject)
    }

    func testAnOlderServersDocumentDrawsNoDoneCard() throws {
        let old = #"{"id":"p1","title":"t","status":"OPEN","derivedDone":{"done":false}}"#
        let page = try JSONDecoder().decode(ProjectDocument.self, from: Data(old.utf8))
        XCTAssertNil(page.doneSubject.counts)
        XCTAssertEqual(ProjectDone.slot(subject: page.doneSubject, request: nil, waitingKind: .recordAsDone,
                                        record: nil), .none)
        let broken = #"{"id":"p1","title":"t","status":"OPEN","derivedDone":"nonsense","acceptedGaps":7}"#
        XCTAssertNoThrow(try JSONDecoder().decode(ProjectCriteriaDocument.self, from: Data(broken.utf8)),
                         "a projection this build cannot read must not fail the confirmation cards' read")
    }

    func testTheOpenItemsReadServesTheRequestBesideTheGroups() throws {
        let raw = #"""
        {"needsYou":[],"withCoordinator":[],"startRequest":null,
         "doneRequest":{"itemId":"34Y9req","kind":"DONE_REQUEST","title":"Is this project done?",
                        "detailLine":"","waitingSince":"2026-10-05T05:00:00.000Z","assignee":"OWNER",
                        "assigneeReason":"DEFAULT","actions":["REVIEW"],
                        "doneRequest":{"criteriaDigest":"\#(String(repeating: "c", count: 64))",
                                       "judgment":"The goal is met.","stateDigest":"s",
                                       "gaps":[{"criterionKey":"k","whyNotProven":"w","coordinatorChecked":"c",
                                                "evidenceRefs":["e"]}],
                                       "warnings":[{"severity":"WARN","code":"DONE_CRITERION_UNLANDED"}]}}}
        """#
        let items = try JSONDecoder().decode(ProjectOpenItemsView.self, from: Data(raw.utf8))
        let row = try XCTUnwrap(items.doneRequest)
        XCTAssertEqual(row.doneRequest?.judgment, "The goal is met.")
        XCTAssertEqual(row.doneRequest?.gaps.first?.evidenceRefs, ["e"])
        XCTAssertEqual(ProjectDone.live(openItems: items, status: "OPEN")?.itemId, "34Y9req")
        let unreadable = #"{"needsYou":[],"withCoordinator":[],"doneRequest":{"itemId":"x","doneRequest":{"judgment":1}}}"#
        let partial = try JSONDecoder().decode(ProjectOpenItemsView.self, from: Data(unreadable.utf8))
        XCTAssertNil(partial.doneRequest?.doneRequest, "a request this build cannot read is no request")
        XCTAssertNil(ProjectDone.live(openItems: partial, status: "OPEN"))
    }

    func testTheProjectsListSaysWhoRecordedADoneProject() throws {
        let raw = #"""
        [{"id":"p1","title":"a","status":"DONE","doneBy":"OWNER","acceptedGaps":[{"criterionKey":"k"},{"criterionKey":"j"}]},
         {"id":"p2","title":"b","status":"DONE","doneBy":"DERIVED","acceptedGaps":[]},
         {"id":"p3","title":"c","status":"OPEN","doneBy":null}]
        """#
        let rows = try JSONDecoder().decode([ProjectSummary].self, from: Data(raw.utf8))
        XCTAssertEqual(rows.map(\.doneProvenance), ["recorded by you · 2 gaps accepted", "recorded by Orbit", nil])
        let again = try JSONDecoder().decode([ProjectSummary].self, from: JSONEncoder().encode(rows))
        XCTAssertEqual(again.map(\.doneProvenance), rows.map(\.doneProvenance))
    }

    func testTheWaitingKindsDecode() throws {
        let kinds = try JSONDecoder().decode([SessionWaitingKind].self,
                                             from: Data(#"["DONE_REQUEST","RECORD_AS_DONE","LATER"]"#.utf8))
        XCTAssertEqual(kinds, [.doneRequest, .recordAsDone, .unknown])
        let reasons = try JSONDecoder().decode([CriterionLandingReason].self,
                                               from: Data(#"["IN_FLIGHT","SOMETHING_NEW"]"#.utf8))
        XCTAssertEqual(reasons, [.inFlight, .unknown])
        XCTAssertFalse(ProjectDone.isWaitingOnWork(.unknown))
        XCTAssertFalse(ProjectDone.isNeedsYourCall(.unknown))
    }
}
