import Foundation
import XCTest
@testable import OrbitKit

/// The wires between this logic and the SwiftUI that draws the evidence card on macOS and iOS.
///
/// OrbitKit is UI-free and that is what lets it be tested on Linux — but it also means the rules
/// proved next door (`EvidenceDecisionTests`, `EvidenceDecisionDoorTests`) prove nothing about the
/// card unless the card is actually attached to them. No compiler checks that on this platform:
/// SwiftUI does not exist here, and `ApprovalCards.swift` and `ConsoleModel.swift` are compiled only
/// by the macOS and iOS jobs. So the attachment is asserted the one way it can be from Linux — over
/// the source — and each assertion is written so that DETACHING the wire is what turns it red:
///
///  - every verdict control is disabled by the derived standing, and the send control by the
///    reason as well, so neither a dead card nor a send-back with no note can be pressed;
///  - the standing is re-derived from the console's read on every render and never kept;
///  - the body reads the ROW, through `EvidenceDecisions`;
///  - the console reads the queue in every conversation — with the ruler's reads, and on its own in
///    one that coordinates nothing — delivers `cardRows` as questions, and presses the door with the
///    request `EvidenceDecisions.request` builds, whichever of the queue and the project comes back
///    first;
///  - a version waiting for a paused coordinator gets the same card, drawn folded, whose Decide it
///    myself opens this card in the review sheet, and one handed over is drawn as one line — and
///    neither is counted by the bar;
///  - an AskUserQuestion is the ordinary question form, whatever its options say.
///
/// This is a weaker instrument than the web card's DOM test and it is used because it is the
/// strongest one available where these tests run. What it cannot see is layout.
final class EvidenceDecisionWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the evidence card is still wired to OrbitKit."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file — from a marker to the next occurrence of another — so a match
    /// somewhere else cannot answer for the part being asserted about. (A bare `contains` over a
    /// whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func card() throws -> String {
        try section(try source(Self.cardPath),
                    from: "private struct EvidenceDecisionCard: View",
                    to: "private struct EvidenceDecisionFacts: View")
    }

    // MARK: the rule both clients are under

    func testEveryVerdictControlIsDisabledByTheDerivedStanding() throws {
        let card = try card()
        let confirm = try section(card, from: "private func confirmButton",
                                  to: "private func sendBackButton")
        let sendBack = try section(card, from: "private func sendBackButton",
                                   to: "/// The press re-checks")

        XCTAssertTrue(confirm.contains(".disabled(deciding || !standing.answerable)"),
                      "Confirm done must be dead while the standing says the door would refuse it: a lit "
                          + "button that is refused every time it is pressed is the bug this rule "
                          + "was written for")
        XCTAssertTrue(sendBack.contains(".disabled(deciding || !standing.answerable)"),
                      "and so must the answer that hands its reason to the composer")
    }

    /// The second answer is the composer handoff, not a box: the press arms the composer with the
    /// row it is about, and the card keeps no text and no second submit of its own. What the
    /// composer then does with the typed sentence is asserted next door
    /// (`ComposerHandoffWiringTests`).
    func testTheSecondAnswerArmsTheComposerInsteadOfOpeningABox() throws {
        let card = try card()
        let sendBack = try section(card, from: "private func sendBackButton",
                                   to: "/// The press re-checks")

        XCTAssertTrue(sendBack.contains("console.startEvidenceSendBackReply(row)"),
                      "the press must hand the reply to the composer, with the row it was drawn "
                          + "for; without the row there is nothing to answer")
        XCTAssertTrue(sendBack.contains("Text(Approvals.chatAction).approvalActionLabel()"),
                      "the second action must be labelled from the word the other composer "
                          + "handoffs share — not from `EvidenceDecisions.sendBackAction`, which is "
                          + "what the RECORD says about an answer already given")
        // The old box, gone from the card entirely: not a field, not a second submit, and no local
        // reason state. A card that kept one would be a second place to type the same sentence.
        XCTAssertFalse(card.contains("TextField"), "the card must not take text: the composer does")
        XCTAssertFalse(card.contains("EvidenceSendBackState"),
                       "the card holds no reason state — the composer's draft is the reason")
        XCTAssertFalse(card.contains("EvidenceDecisions.sendAction"),
                       "the in-card submit is gone; the composer's own Send is the submit")
        // And the promise, on the card rather than in a tooltip alone: a touch screen never shows
        // a hover.
        XCTAssertTrue(card.contains("Text(EvidenceDecisions.sendBackHint)"),
                      "the card must print what pressing it does not do")
    }

    func testThePressReChecksTheStandingItWasRenderedFrom() throws {
        let press = try section(try card(), from: "private func decide", to: "\n}\n")
        XCTAssertTrue(press.contains("guard let row = standing.row, standing.answerable, !deciding else { return }"),
                      "a race between a render and a tap cannot send an answer the standing says "
                          + "is dead")
        XCTAssertTrue(press.contains("await console.decideEvidence(row, decision)"),
                      "and the one answer this card presses itself is the confirm")
    }

    func testTheStandingIsDerivedOnEveryRenderAndNeverKept() throws {
        let card = try card()
        XCTAssertTrue(card.contains("console.evidenceStanding(taskID, evidenceRevision)"),
                      "the standing is re-derived from the console's read, not stored")
        XCTAssertFalse(card.contains("@State private var standing"),
                       "a frozen frame is the one thing this card may not keep")
        XCTAssertTrue(card.contains("EvidenceDecisions.heading(standing)"),
                      "the heading says which of the standings the reader is looking at")
        XCTAssertTrue(card.contains("EvidenceDecisions.staleExplanation(standing)"),
                      "and a card that cannot be answered says which refusal it would meet")
    }

    func testTheBodyIsReadFromTheRow() throws {
        let file = try source(Self.cardPath)
        let facts = try section(file, from: "private struct EvidenceDecisionFacts: View",
                                to: "private struct DisclosureToggle: View")
        for reading in ["EvidenceDecisions.foldedClaim(row.claim",
                        "EvidenceDecisions.gapPreview(row)",
                        "EvidenceDecisions.checks(row)",
                        "EvidenceDecisions.meta(row)"] {
            XCTAssertTrue(facts.contains(reading), "the card must read \(reading)")
        }
        XCTAssertTrue(try card().contains("if let row = standing.row {"),
                      "and it reads a row only while the read still publishes one")
    }

    // MARK: the console

    func testTheConsoleDeliversOnlyTheRowsTheCardFilterKeeps() throws {
        let console = try source(Self.consolePath)
        let refresh = try section(console, from: "func refreshEvidenceDecisions(force: Bool = false) async {",
                                  to: "/// Answer one revision of a task's evidence at the decision door")
        XCTAssertTrue(refresh.contains("guard !isDraft else { return }"),
                      "every conversation reads it, not only a coordinator: a task a session "
                          + "dispatched outside any project has its card in a session that coordinates nothing")
        XCTAssertTrue(refresh.contains("api.pendingEvidenceDecisions(decidingSessionID: sessionID)"),
                      "the read is what creates a card, so no card on screen can be what drives it")
        XCTAssertTrue(refresh.contains("for row in EvidenceDecisions.cardRows(queue: queue, projectId: projectID, sessionId: sessionID) {"),
                      "and only the rows the card filter keeps for THIS conversation become cards")
        let ruler = try section(console, from: "func refreshRulerQuestions(force: Bool = false) async {",
                                to: "guard !isDraft, let projectID, !loadingRuler else { return }")
        XCTAssertTrue(ruler.contains("await refreshEvidenceDecisions(force: force)"),
                      "every door that asks for the ruler's reads — reconnect, a card, a press — asks "
                          + "for this one first, in a conversation with no project as well")
        XCTAssertTrue(console.contains("if projectID == nil { Task { [weak self] in await self?.refreshEvidenceDecisions() } }"),
                      "a conversation that coordinates nothing reads it when its context loads")
        XCTAssertTrue(console.contains("Task { [weak self] in await self?.refreshEvidenceDecisions(force: true) }"),
                      "and again when its row's count moves")
        XCTAssertTrue(console.contains("EvidenceDecisions.isOpen(evidenceStanding(taskID, evidenceRevision))"),
                      "the bar stops counting a card that went stale, by OrbitKit's rule")
        XCTAssertTrue(console.contains("EvidenceDecisions.standing(queue: evidenceDecisions, projectId: projectID, sessionId: sessionID,"),
                      "and a card's standing is re-derived through the same filter, for this conversation")
    }

    /// A console opened cold learns what its cards are drawn from by two reads, and either can come
    /// back first: the queue, kicked when the composer adopts the list row, and the project, from
    /// `loadContext`. When the queue won, its rows were dropped and nothing read them again: 7 of 10
    /// launches on the iPhone simulator drew no card (T7's probe, run 41509823402).
    ///
    /// `ConsoleModel` does not compile here, so this walks that order through its source and
    /// OrbitKit's own filter, one step at a time, with no other event after the project lands. Steps
    /// 1 to 3 pin the order itself; step 4 is what the order needs from the console.
    func testAQueueReadThatBeatsTheProjectStillDrawsItsCard() throws {
        let console = try source(Self.consolePath)
        let project = "34JdnRJOxuG05yi0TpLq4"
        let here = "34JbyLO3TvHgOmBBHLgZu"
        let row = EvidenceDecisionRow(
            taskId: "34LMiluvx0jK63cj8arWl", title: "P4.3", projectId: project, ownerCard: nil,
            criterion: nil, evidenceRevision: "2", ageSeconds: 300, claim: "Done.", gaps: [], citations: [],
            decidability: EvidenceDecisionDecidability(decidable: true, refusal: nil),
            independence: EvidenceDecisionIndependence(independent: true, disqualification: nil))
        let queue = EvidenceDecisionQueue(decidingSessionId: here, count: 1, pending: [row])

        // 1. The list row's count kicks the read, before anything here knows the project.
        let adopt = try section(console, from: "func adoptServerSnapshot(_ session: Session?) {",
                                to: "private func runMoment(")
        XCTAssertTrue(adopt.contains("Task { [weak self] in await self?.refreshEvidenceDecisions(force: true) }"),
                      "a row whose count moved, in a console that knows no project yet, reads the queue")

        // 2. It comes back first: the queue is kept, and with no project its row draws nothing.
        let read = try section(console, from: "func refreshEvidenceDecisions(force: Bool = false) async {",
                               to: "/// Answer one revision of a task's evidence at the decision door")
        XCTAssertTrue(read.contains("evidenceDecisions = queue"), "the read keeps what it was told")
        XCTAssertTrue(read.contains("lastEvidenceRead = Date()"), "and starts the throttle")
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue, projectId: nil, sessionId: here).isEmpty,
                      "a row of a project this console does not know yet gets no card")

        // 3. The project lands. The read it kicks is not forced, so the throttle skips it: no request
        // can bring the row back, and a landing that forced one would spend a read on every open.
        let landing = try section(console, from: "projectID = s.projectId", to: "taskID = s.taskId")
        XCTAssertTrue(landing.contains("if projectID != nil { Task { [weak self] in await self?.refreshRulerQuestions() } }"),
                      "the read the project's landing kicks")
        XCTAssertFalse(landing.contains("force: true"), "and it stays subject to the throttle")

        // 4. So the landing draws the queue the read left, and now the row is this console's card.
        XCTAssertTrue(landing.contains("adoptEvidenceQueue(evidenceDecisions)"),
                      "with the project known, the queue a read already brought back has to be drawn: "
                          + "nothing else re-reads it until a reconnect or the row's count moves")
        XCTAssertTrue(read.contains("private func adoptEvidenceQueue(_ queue: EvidenceDecisionQueue) {"),
                      "one adoption, for a read and for the landing alike")
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: queue, projectId: project, sessionId: here), [row],
                       "the same queue, once the project is known, is this conversation's card")
    }

    /// A forced read means something just moved, and the read on its way may have been answered before
    /// it did. Dropped, the card waited for the next event, which may not come. `ConsoleModel` does not
    /// compile here, so this walks the order through its source: the moved row's force finds a read on
    /// its way, is owed, and is read when that read is back.
    func testAForcedEvidenceReadIsOwedWhileAnotherIsOnItsWay() throws {
        let console = try source(Self.consolePath)
        let read = try section(console, from: "func refreshEvidenceDecisions(force: Bool = false) async {",
                               to: "/// Draw what a read of the queue lists for this conversation.")
        let inFlight = try XCTUnwrap(read.range(of: "if loadingEvidence {"), "a read on its way is what is asked about")
        let owed = try XCTUnwrap(read.range(of: "if force { evidenceReadOwed = true }"), "and a force is remembered")
        XCTAssertLessThan(inFlight.lowerBound, owed.lowerBound)
        let throttle = try XCTUnwrap(read.range(of: "if !force, Date().timeIntervalSince(lastEvidenceRead)"))
        XCTAssertLessThan(owed.lowerBound, throttle.lowerBound,
                          "and that comes before the throttle, which a forced read does not answer to")
        let loop = try section(read, from: "repeat {", to: "} while evidenceReadOwed && !Task.isCancelled")
        XCTAssertTrue(loop.contains("evidenceReadOwed = false"), "each read pays what was owed before it asks")
        XCTAssertTrue(loop.contains("api.pendingEvidenceDecisions(decidingSessionID: sessionID)"),
                      "and the read that is owed is the same read")
        XCTAssertTrue(loop.contains("adoptEvidenceQueue(queue)"), "drawn the same way")
    }

    /// The row names the project and the task, and `loadContext` reads it once. A first read that did not
    /// come back left both nil, so no project card and no owner confirmation, until the console was
    /// restarted: a reconnect re-read everything but the row.
    func testARowThatWasNotReadIsReadAgainOnAReconnectAndOnTheMinute() throws {
        let console = try source(Self.consolePath)
        let load = try section(console, from: "private func loadContext() async {", to: "adoptServerSnapshot(s)")
        let read = try XCTUnwrap(load.range(of: "guard let s = try? await api.session(sessionID) else { return }"))
        let marked = try XCTUnwrap(load.range(of: "contextLoaded = true"), "only a read that came back counts")
        XCTAssertLessThan(read.lowerBound, marked.lowerBound)
        XCTAssertTrue(load.contains("guard !loadingContext else { return }"), "and one read at a time")
        let again = try section(console, from: "private func loadContextIfUnread() async {",
                                to: "/// List seeds and the later detail read")
        XCTAssertTrue(again.contains("if !contextLoaded { await loadContext() }"), "read again until it is known")
        let run = try section(console, from: "func run() async {", to: "isReconnect = true")
        XCTAssertTrue(run.contains("await self?.loadContextIfUnread()"), "on a reconnect")
        let minute = try section(console, from: "runnerPollTask = Task { [weak self] in", to: "evidencePollTask = Task")
        XCTAssertTrue(minute.contains("await self.loadContextIfUnread()"), "and on the minute: the stream may never drop")
    }

    /// The arming half of the handoff, on the console's side: the press hands the ROW over and
    /// everything the bar says is built from it — OrbitKit's prefix and OrbitKit's question — so
    /// the words a reader sees while typing are the browser's too
    /// (`EvidenceDecisionCopyParityTests`). What the send then does with them is asserted next door
    /// (`ComposerHandoffWiringTests`).
    func testTheArmingPressNamesTheVersionItIsAbout() throws {
        let console = try source(Self.consolePath)
        let arm = try section(console, from: "func startEvidenceSendBackReply(",
                              to: "/// Talk about a plan before the project is started on it")

        XCTAssertTrue(arm.contains("target: .evidenceDecision(row)"),
                      "the armed reply carries the row: the send that follows needs its address, "
                          + "and the reconcile needs to re-derive its standing")
        XCTAssertTrue(arm.contains("banner: EvidenceDecisions.sendingBackPrefix + row.title"),
                      "the bar names the task the evidence is about")
        XCTAssertTrue(arm.contains("placeholder: EvidenceDecisions.sendBackLabel"),
                      "and the composer asks for the reason the door requires")
    }

    func testThePressGoesToTheDoorAsTheRequestOrbitKitBuilds() throws {
        let console = try source(Self.consolePath)
        let press = try section(console, from: "func decideEvidence(",
                                to: "/// Confirm the standard set as it stands.")
        XCTAssertTrue(press.contains("guard let request = EvidenceDecisions.request(row: row, decision: decision, note: note,"),
                      "nothing is sent that OrbitKit would not build — and a send-back with no "
                          + "reason builds nothing")
        XCTAssertTrue(press.contains("decidingSessionID: sessionID) else { return }"),
                      "the answer is given FROM this session, which the door checks for independence")
        XCTAssertTrue(press.contains("api.decideEvidence(taskID: row.taskId, request)"))
    }

    // MARK: the receipt, which is a record rather than a question

    /// THE RECORD IS DRAWN FROM THE READ, NOT FROM THE WINDOW THAT PRESSED THE BUTTON.
    ///
    /// A receipt used to be an in-memory line written by the console that pressed
    /// (`appendDecisionLine(EvidenceDecisions.recordedLine(…))`) — so opening the console again, or
    /// relaunching the app, took the decision out of the conversation; the account owner reported
    /// exactly that (about the criteria receipt, on the web client, 2026-09-16). The answers are
    /// committed rows the pending read publishes for the deciding session, so the console derives
    /// the receipts from them on every refresh and lets go of each revision the read names.
    func testTheConsoleDerivesEvidenceReceiptsFromTheReadAndLetsTheAnsweredQuestionGo() throws {
        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("EvidenceDecisions.receipts(queue: queue)"),
                      "the receipts are derived from the read's own answers")
        XCTAssertTrue(console.contains("placement: .at(receipt.moment)"),
                      "each carrying the door's own clock — the transcript resolves the row at "
                      + "render time")
        XCTAssertTrue(console.contains("kind: .evidenceDecisionReceipt(decided: receipt.decided)"),
                      "and delivered as rows of their own, carrying the answer they record")
        let press = try section(console, from: "func decideEvidence", to: "func confirmStandardSet")
        XCTAssertFalse(press.contains("appendDecisionLine"),
                       "a decision recorded from a card no longer leaves an in-memory line behind it")
    }

    /// The receipt card says what it is and what happened, and offers nothing to press.
    func testTheEvidenceReceiptCardIsARecordWithNoActions() throws {
        let card = try section(try source(Self.cardPath),
                               from: "private struct EvidenceDecisionReceiptCard: View",
                               to: "private struct AcceptanceConfirmationCard: View")
        XCTAssertTrue(card.contains("decided.recordedByAgent ? EvidenceDecisions.agentRecordedHeading"),
                      "the heading says whether the owner pressed a card or a run of the session "
                          + "reached the door")
        XCTAssertTrue(card.contains("EvidenceDecisions.receiptLine(decided)"),
                      "and the line is OrbitKit's, from the answer the row carries")
        XCTAssertFalse(card.contains("ApprovalActions"), "a record has no answers left to offer")
        XCTAssertFalse(card.contains("confirmButton"),
                       "and no button that would send a second decision to the door")
    }

    func testAnAskUserQuestionIsTheOrdinaryFormAndTheCardIsADeliveredOne() throws {
        let file = try source(Self.cardPath)
        XCTAssertTrue(file.contains("case .question: QuestionCard(console: console, approval: approval)"),
                      "every AskUserQuestion renders as the form, including one whose options read "
                          + "Confirm completion / Send back")
        for gone in ["EvidenceDecisions.rows(", "QuestionApprovalCard", "loadPendingDecisions"] {
            XCTAssertFalse(file.contains(gone), "no question is taken for the evidence card: \(gone)")
        }
        let delivered = try section(file, from: "struct DeliveredDecisionCardView: View",
                                    to: "private struct CriteriaDecisionCard: View")
        XCTAssertTrue(delivered.contains("case .evidenceDecision(let taskID, let evidenceRevision):"))
        XCTAssertTrue(delivered.contains("EvidenceDecisionCard(console: console, taskID: taskID,"),
                      "the card is drawn from its delivered address")
    }
}
