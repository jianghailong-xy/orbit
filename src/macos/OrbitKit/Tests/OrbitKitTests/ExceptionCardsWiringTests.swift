import Foundation
import XCTest
@testable import OrbitKit

/// The wires between `ExceptionCards` and the SwiftUI the two clients draw it with.
///
/// OrbitKit is UI-free and that is what lets it be tested on Linux — but it also means the rules
/// proved next door (`ExceptionCardsTests`) prove nothing about the card unless the card is
/// attached to them. No compiler checks that here: SwiftUI does not exist on this platform, and
/// `ApprovalCards.swift` and `ConsoleModel.swift` are compiled only by the macOS and iOS jobs. So
/// the attachment is asserted the one way it can be — over the source — and each assertion is
/// written so that DETACHING the wire is what turns it red:
///
///  - the console delivers a card for every item `ExceptionCards.cards` returns, from the same read
///    the question card comes from;
///  - the needs-you banner's press lands on that card, by the item's own address;
///  - the card re-derives its standing from the console's read on every render and keeps none;
///  - the button is drawn and enabled by the server's own action list, never by a constant;
///  - the fact block is the model's rows off the payload, and a payload this build cannot read still
///    draws the server's own sentence;
///  - the action row is the model's presses in the model's weights, and a door this client has no
///    press for draws nothing;
///  - the owner's own ending is offered last, off the kind and the assignee, and never sent without
///    a reason;
///  - the presses go through the console's doors, which are the POSTs the browser makes.
///
/// This is a weaker instrument than the web card's DOM test and it is used because it is the
/// strongest one available where these tests run. What it cannot see is layout.
final class ExceptionCardsWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the exception card is still wired to OrbitKit."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let rowsPath = "src/macos/OrbitKit/Sources/OrbitKit/Transcript/TranscriptRows.swift"

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
                    from: "private struct OwnerItemCardView: View",
                    to: "/// The one merge a person is asked to confirm")
    }

    /// The read that publishes the project's open items, in the console.
    private func openItemsRead() throws -> String {
        try section(try source(Self.consolePath),
                    from: "if let items = try? await api.projectOpenItems(projectID: projectID) {",
                    to: "// `do` rather than `try?`")
    }

    // MARK: the console draws the card

    /// Every item the owner's read publishes as theirs-and-not-otherwise-answered gets a card, and
    /// the two kinds are drawn as the two cards. This is the wire whose absence was the whole
    /// defect: the count and the banner named an item this conversation drew nothing for.
    func testTheConsoleDeliversACardForEveryOwnerItemTheReadCarries() throws {
        let read = try openItemsRead()
        XCTAssertTrue(read.contains("ExceptionCards.cards(items)"),
                      "the exceptions must come from the same read the question card does, through "
                          + "the filter that keeps the owner's group")
        XCTAssertTrue(read.contains(".escalatedItem(itemID: row.itemId)"),
                      "an item that became the owner's is drawn as the escalation card")
        XCTAssertTrue(read.contains(".fusePause(itemID: row.itemId)"),
                      "and a pause as the pause card, by the item's own id — the address the push "
                          + "payload and the banner carry")
    }

    /// …and each of them is placed by the ITEM'S OWN MOMENT rather than by where this device read
    /// it: a delivered card anchors where it arrived, and an exception's arrival is the control
    /// plane's read running after the fact, which on a console opened later is the tail. The card
    /// then read `waiting 34m` under the newest message in the conversation — one card telling two
    /// stories about when it happened (the account owner's screenshot, 2026-09-22;
    /// `ExceptionCardPlacementTests` is the rule this wire feeds).
    func testEveryOwnerItemIsPlacedByTheMomentItBecameTheOwners() throws {
        let read = try openItemsRead()
        XCTAssertTrue(read.contains("placement: DeliveryAnchor.exception(row, items: state.items)"),
                      "the two exception cards must be placed by the item's own clock; anchoring "
                          + "them where the read found them is the defect")
    }

    /// The card is drawn in the transcript, and its row id is the browser's own spelling — the
    /// needs-you banner's press names the item, and what it scrolls to has to be this row.
    func testTheTwoCardsHaveRowsAndTheBrowsersIds() throws {
        let view = try section(try source(Self.cardPath),
                               from: "case .escalatedItem(let itemID):",
                               to: "case .promotionApproval(let promotionID):")
        XCTAssertTrue(view.contains("OwnerItemCardView(console: console, itemID: itemID, isPause: false)"))
        XCTAssertTrue(view.contains("OwnerItemCardView(console: console, itemID: itemID, isPause: true)"))

        let rows = try source(Self.rowsPath)
        XCTAssertTrue(rows.contains(#"case .escalatedItem(let itemID):          return "open-item-\(itemID)""#),
                      "the escalation card's row id is `open-item-<itemId>` — what the web's "
                          + "`ProjectProgressStatus.tsx` gives it")
        XCTAssertTrue(rows.contains(#"case .fusePause(let itemID):              return "fuse-\(itemID)""#),
                      "and the pause's is `fuse-<itemId>`, in the web's spelling too")
    }

    // MARK: the banner's press lands on it

    /// A press on the needs-you banner names one of the four owner items; for these two it must
    /// open the conversation AND scroll to the card, which is the only thing that makes the banner
    /// more than a notification.
    func testTheBannersPressLandsOnTheCard() throws {
        let press = try section(try source(Self.consolePath),
                               from: "private func rowID(forOwnerItem item: SessionOwnerItem) -> String? {",
                               to: "/// Where one delivered question stands")
        XCTAssertTrue(press.contains("case .escalated:")
                      && press.contains(".escalatedItem(itemID: item.itemId)"),
                      "an escalated item's banner press must resolve to the escalation card's row")
        XCTAssertTrue(press.contains("case .fusePaused:")
                      && press.contains(".fusePause(itemID: item.itemId)"),
                      "and a pause's to the pause card's")
        XCTAssertFalse(press.contains("case .escalated, .fusePaused, .unknown:"),
                       "the arm that returned nil — the press that opened a conversation with "
                          + "nothing in it — is gone")
    }

    /// The needs-you bar asks where a card sits only of the cards still WAITING, against one read of
    /// the rows' clocks. The console's body reads the bar on every update, and placing a card by its
    /// moment reads every row's clock: asked of every card, a coordinator's nineteen records were
    /// 19,000 parses a render, and its console froze on open (the owner's iOS report, 2026-09-23).
    func testTheBarPlacesOnlyTheCardsStillWaiting() throws {
        let console = try source(Self.consolePath)
        let filter = try section(console, from: "var openBelowRows: [BelowRow] {",
                                 to: "var clocks: ReceiptAnchor.Clocks?")
        XCTAssertFalse(filter.contains("flowIndex("),
                       "a card is placed before the bar knows it is waiting — every record in the "
                           + "conversation is placed again on every update")
        let placing = try section(console, from: "var clocks: ReceiptAnchor.Clocks?",
                                  to: "var waitingBelow: WaitingBelow? {")
        XCTAssertTrue(placing.contains("flowIndex(of: entry.card, clocks: &clocks)"),
                      "the waiting cards share one read of the rows' clocks")
    }

    // MARK: the card is honest

    /// The standing is re-derived from the console's read on every render and never kept: a card
    /// whose item the coordinator closed in the meantime goes dead in place rather than staying
    /// pressable.
    func testTheStandingIsDerivedAndTheCardKeepsNone() throws {
        let card = try card()
        XCTAssertTrue(card.contains("private var standing: OwnerItemStanding { console.ownerItemStanding(itemID) }"),
                      "the standing must come from the console's read on every body pass")
        XCTAssertTrue(card.contains("case .open(let row) = standing"),
                      "the settled or unread states must be drawn as themselves, never as the item")
        XCTAssertFalse(card.contains("var standing: OwnerItemStanding ="),
                       "a standing kept in state would outlive the read that produced it")
    }

    /// The button is drawn and enabled by the server's own action list — the listing is computed
    /// from facts this client cannot see, and a button the door would refuse is worse than none.
    func testTheButtonFollowsTheServersOwnList() throws {
        let card = try card()
        XCTAssertTrue(card.contains("isPause ? ExceptionCards.resumable(row) : ExceptionCards.askable(row)"),
                      "which press this card offers is the server's answer, not this client's guess")
        XCTAssertTrue(card.contains("guard !sending, pressable(row) else { return }"),
                      "and the press re-checks it against the row it was rendered from")
        XCTAssertFalse(card.contains(".disabled(false)"),
                       "no control may be pinned open")
    }

    /// The second control hands the item to the composer — one word for one thing
    /// (`Approvals.chatAction`), and the sentence the owner types is an ordinary turn to the
    /// coordinator (`ComposerHandoffWiringTests` proves the send's own half of that wire).
    ///
    /// The card draws no press that only OPENS something: this client has no task page in the
    /// console's own stack, and the rule the merge card states for the same situation is that a
    /// line saying what things are beats a button that goes somewhere else.
    func testTheSecondControlHandsTheItemToTheComposer() throws {
        let card = try card()
        let handoff = try section(card, from: "// And the other way out, which is a sentence",
                                  to: "if !isPause && ExceptionCards.markable(row) {")
        XCTAssertTrue(handoff.contains("console.startOwnerItemReply(row, isPause: isPause)"),
                      "the press must hand the reply to the composer with the row it was drawn for; "
                          + "without the row there is no item to talk about")
        XCTAssertTrue(handoff.contains("Text(Approvals.chatAction).approvalActionLabel()"),
                      "and it wears the word every other composer handoff wears")
        XCTAssertTrue(handoff.contains(".buttonStyle(.bordered)"),
                      "the handoff is the secondary control, beside the one write")
        // The card takes text in exactly one place — the reason the owner's own ending requires —
        // and never for the handoff: what the coordinator is told is typed in the composer.
        XCTAssertFalse(handoff.contains("TextField"),
                       "the handoff must not take text: the composer does")
        XCTAssertEqual(card.components(separatedBy: "TextField").count - 1, 1,
                       "one field on this card, and it is the ending's reason (§4.7)")
        XCTAssertFalse(card.contains("confirmationDialog") || card.contains("orbitConfirmation"),
                       "and nothing to confirm: the ending asks for a reason, not for a yes")
    }

    // MARK: the payload is what is drawn

    /// The fact block is `ExceptionCards.facts`, which reads the row's payload — and the card draws
    /// its rows rather than composing a sentence of its own. A view that re-derived any of it would
    /// be the second rendering of one fact the browser's own head comment warns about.
    func testTheCardDrawsTheFactBlockFromTheRowsAndNotFromTheSentence() throws {
        let card = try card()
        XCTAssertTrue(card.contains("switch ExceptionCards.facts(row)"),
                      "the block is the model's rows, chosen by the payload")
        XCTAssertTrue(card.contains("case .rows(let block):") && card.contains("ForEach(block.rows"),
                      "a payload this build reads draws its rows")
        XCTAssertTrue(card.contains("case .detailLine(let line):"),
                      "and one it does not still draws the server's own sentence — the negative "
                          + "control, which is what every card drew before the rows existed")
        XCTAssertFalse(card.contains("row.detailLine"),
                      "the sentence comes back through the model, in the arm that decides it — never "
                          + "straight off the row, which would print it beside the rows")
        XCTAssertTrue(card.contains("fact.logTail") && card.contains("tail.shown"),
                      "a failed check's log is folded from its end, in the model's own lines — and "
                          + "it is drawn under the row it hangs off, inside the same ForEach, which "
                          + "is where the browser draws it")
        XCTAssertFalse(card.contains("outputTail"),
                      "and the block is what reads the payload: the view draws strings")
        // The row's two faces, too: a check's command in the mono face and its verdict in red are
        // the model's runs of the value (`Face`), not a decision the view makes about a string.
        XCTAssertTrue(card.contains("switch run.face") && card.contains("case .mono:")
                      && card.contains("case .bad:"),
                      "every run of a row's value is drawn in the face the model gave it")
    }

    /// The card's first line is the server's sentence about what has to happen next (§7.5, T9),
    /// and every door is drawn with the one line the model wrote about it — the view composes
    /// neither, so the browser's own words cannot be paraphrased on the way to the screen.
    func testTheCardSaysWhatHasToHappenNextAndEveryDoorSaysWhatItDoes() throws {
        let card = try card()
        XCTAssertTrue(card.contains("Text(ExceptionCards.requiredAction(row))"),
                      "the decision block opens on the model's own sentence")
        XCTAssertTrue(card.contains("if let fixing = ExceptionCards.handledByLine(row)"),
                      "and names the tasks already filed as this item's fixes, when there are any")
        XCTAssertTrue(card.contains("nextBlock(row)") && card.contains("factBlock(row)"),
                      "the decision comes before the facts — the browser's own reading order")
        XCTAssertTrue(card.contains("Text(cardPress.label)"),
                      "a door wears the label the model gave it — never a constant in the view")
        XCTAssertTrue(card.contains("doorRow(cardPress.consequence)"),
                      "and its one line of consequence, from the same model")
    }

    /// The two presses this card reaches the rerun doors through (§4.7 H1, T5), and the one thing
    /// that decides whether `Review` exists at all.
    func testTheRerunAndReviewPressesGoThroughTheConsole() throws {
        let card = try card()
        XCTAssertTrue(card.contains("return { retry(row) }"),
                      "a RETRY press runs the work again through the console, which owns the route")
        XCTAssertTrue(card.contains("console.revealPromotionCard(promotionID)"),
                      "a REVIEW press scrolls to the merge card rather than opening anything: the "
                          + "review IS that card, and it is on screen")
        XCTAssertTrue(card.contains("console.mergeCardPromotionID == promotionID"),
                      "and it is drawn only where the console says that card is here — the "
                          + "browser's `currentPromotionId`")

        let doors = try section(try source(Self.consolePath),
                                from: "func retryIntegration(",
                                to: "/// The merge candidate whose card this conversation has delivered")
        XCTAssertTrue(doors.contains("api.retryPromotionCheck("),
                      "a row naming a candidate re-runs THAT candidate's check: "
                          + "`POST /projects/:id/promotions/:promotionId/integration/retry`")
        XCTAssertTrue(doors.contains("api.retryTaskIntegration("),
                      "and one naming a task retries its landing: "
                          + "`POST /projects/:id/tasks/:taskId/integration/retry`")
        XCTAssertTrue(doors.contains("if row.kind == .taskFailed {")
                      && doors.contains("try await api.executeTask(taskID, triggerId: PublicID.newToken())"),
                      "and a FAILED task runs again through the owner's own route "
                          + "(`POST /tasks/:id/execute`) — the integration retry would refuse it "
                          + "(J-T1b), so it is never the press a failed task's Retry makes")
        XCTAssertTrue(doors.contains("let reason = ExceptionCards.retryReason(row)"),
                      "the reason the door requires is the item's own sentence, from the model")
        XCTAssertTrue(doors.contains("await refreshRulerQuestions(force: true)"),
                      "and the press re-reads the item list, where the rerun shows itself")
        XCTAssertTrue(doors.contains("statusMessage = \"\\(headline) — "),
                      "a refusal says so, in the browser's own headline for whichever door failed")
        XCTAssertTrue(doors.contains("ExceptionCards.notRunAgain"),
                      "the run-again refusal wears its own headline, which is the third door")
    }

    /// The action row is the model's presses in the model's order, and the tier picks the style —
    /// nothing here decides WHICH presses exist or which of them leads.
    func testThePressesComeFromTheModelInItsOwnWeights() throws {
        let card = try card()
        XCTAssertTrue(card.contains("ExceptionCards.presses(row, mergeCard: console.mergeCardPromotionID)"),
                      "the doors and their order are `ExceptionCards.presses` — the browser's own "
                          + "rule, told the one thing only this console knows, so the two cards "
                          + "cannot disagree about what leads")
        XCTAssertTrue(card.contains("weighted(cardPress.tier, tint:"),
                      "and the weight is the model's, applied to the style and to nothing else")
        XCTAssertTrue(card.contains("cardPress.action == .abandon ? .red : nil"),
                      "the one colour a card adds is the board's solid-red Abandon lead")
        XCTAssertTrue(card.contains("if tier == .primary {") && card.contains(".borderedProminent"),
                      "a primary press is the one prominent control on the card")
        // A door this client has no press for draws nothing — and its consequence line goes with
        // it, since the line is inside the same branch the press is (`cardPressDoor`'s guard).
        XCTAssertFalse(card.contains("ExceptionCards.cancelTask"),
                       "`Cancel task` is still a door this console has no press for: a control that "
                          + "goes nowhere is worse than no control")
        let door = try section(card, from: "private func cardPressDoor(",
                               to: "/// What one door's press does")
        XCTAssertTrue(door.contains("if let make = makePress(cardPress, row: row) {"),
                      "the consequence line is drawn only where the press is")
    }

    // MARK: the owner's own ending

    /// The ending is drawn from the KIND and the assignee — never from the server's action list,
    /// which does not carry it — and it is the last and lightest thing in the row (方案 B).
    func testTheEndingIsTheOwnersAndIsDrawnLast() throws {
        let card = try card()
        XCTAssertTrue(card.contains("if !isPause && ExceptionCards.markable(row) {"),
                      "offered where the item is the owner's and its kind is one the door closes by "
                          + "hand — the pause, the question and the merge have doors of their own")
        let row = try section(card, from: "// The owner's own ending, drawn last and quietest",
                              to: "            }\n        }\n        .padding(.horizontal, 10)")
        XCTAssertTrue(row.contains("markHandledButton()"),
                      "and it comes after the handoff, at the end of the action row")
        XCTAssertTrue(row.contains("doorRow(ExceptionCards.markHandledConsequence)"),
                      "drawn as a DOOR like every other one here: the browser gives it the same one "
                          + "line of consequence, and a quiet link with no line is the one control on "
                          + "the card that would say nothing about what it ends")

        let button = try section(card, from: "private func markHandledButton() -> some View {",
                                 to: "/// The reason the ending requires,")
        XCTAssertTrue(button.contains("Text(ExceptionCards.markHandled)"),
                      "it wears the browser's own word")
        XCTAssertTrue(button.contains(".buttonStyle(.plain)"),
                      "drawn in the quiet weight, not as a third button (方案 B)")
        XCTAssertTrue(button.contains("askingToHandle = true"),
                      "and it asks before it writes: the reason is required")
        XCTAssertFalse(button.contains("reason = \"\""),
                       "opening the field never costs the reader the words already in it — a "
                           + "refused press, or a panel they closed to look again, keeps the draft")
    }

    /// The ending's dialog, in the four rules the browser's own dialog follows: nothing is sent
    /// without a reason, the field stops at the door's ceiling, and the draft is cleared where it
    /// is spent — on the door taking it — not when the field opens.
    func testTheEndingsDialogHoldsTheDoorsOwnLine() throws {
        let card = try card()
        let panel = try section(card, from: "private func markHandledPanel() -> some View {",
                                to: "private func pressable(_ row: ProjectOpenItemRow) -> Bool {")
        XCTAssertTrue(panel.contains("Text(ExceptionCards.markHandledTitle)")
                      && panel.contains("Text(ExceptionCards.markHandledBody)"),
                      "the dialog's two sentences are the browser's, through the model")
        XCTAssertTrue(panel.contains("TextField(ExceptionCards.markHandledReason"),
                      "and it asks for what the browser's dialog asks for")
        XCTAssertTrue(panel.contains(".disabled(sending || ExceptionCards.markHandledRequest(reason) == nil)"),
                      "empty is not a press: the confirm waits for a reason, which is the door's own rule")
        XCTAssertTrue(panel.contains("ExceptionCards.markHandledMaxLength"),
                      "and the field stops at the door's ceiling (`maxLength` on the browser's)")
        let submit = try section(card, from: "private func markHandled() {",
                                 to: "/// Run the work the item is about again")
        let took = try XCTUnwrap(submit.range(of: "if await console.markItemHandled(row, note: reason) != nil {"),
                                 "the press goes through the console, which owns the door")
        let cleared = try XCTUnwrap(submit.range(of: "reason = \"\""))
        let kept = try XCTUnwrap(submit.range(of: "askingToHandle = false"))
        XCTAssertLessThan(took.lowerBound, cleared.lowerBound,
                          "the draft is cleared only where the door TOOK it")
        XCTAssertLessThan(cleared.lowerBound, kept.lowerBound,
                          "and the panel closes with it — a refusal leaves both where they were, "
                              + "so the reader can read what the server said and answer it")
    }

    /// The reason is what the press carries, and an empty one is not a press: the field's submit
    /// guards it, the console's door guards it again, and what travels is the trimmed sentence.
    func testTheReasonIsRequiredBeforeAnythingIsSent() throws {
        let card = try card()
        let submit = try section(card, from: "private func markHandled() {",
                                 to: "/// The press re-reads what the button was rendered from")
        XCTAssertTrue(submit.contains("ExceptionCards.markHandledRequest(reason) != nil else { return }"),
                      "the field holds the door's own line: a reason the server would refuse is not "
                          + "a press, so nothing is sent and the words stay on screen")
        XCTAssertTrue(submit.contains("console.markItemHandled(row, note: reason)"),
                      "and the press goes through the console, which owns the credential")
        XCTAssertTrue(submit.contains("case .open(let row) = standing"),
                      "re-read against the standing it was drawn from, like every other press here")
        XCTAssertTrue(card.contains("TextField(ExceptionCards.markHandledReason"),
                      "the field asks for what the browser's dialog asks for")

        let doors = try section(try source(Self.consolePath),
                                from: "func markItemHandled(",
                                to: "/// Lift the pause")
        XCTAssertTrue(doors.contains("ExceptionCards.markHandledRequest(note)"),
                      "the console holds the same line as the field — a disabled button is not a "
                          + "rule about what is sent")
        XCTAssertTrue(doors.contains("api.resolveOpenItem(projectID: projectID, itemID: row.itemId,"),
                      "the ending is `POST /projects/:id/open-items/:itemId/resolve`")
        XCTAssertTrue(doors.contains("await refreshRulerQuestions(force: true)"),
                      "and it re-reads the item list the card is derived from")
        XCTAssertTrue(doors.contains("statusMessage = \"\\(ExceptionCards.notMarkedHandled)"),
                      "a refused ending says so, in the browser's own headline")
    }

    // MARK: a session row's press lands on the card it names

    /// A session ROW says which owner item is waiting on it ("Escalated to you · …") and its press
    /// lands on that item's card, exactly as the banner's does — otherwise the reader presses a line
    /// that named a decision and arrives at a conversation with nothing pointing at it (the account
    /// owner's report, 2026-09-22).
    func testTheSessionRowsPressLandsOnTheCardItNames() throws {
        let app = try source("src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift")
        let press = try section(app, from: "func openSessionRow(_ s: Session) {",
                                to: "/// Point the console a row is about to open")
        XCTAssertTrue(press.contains("focusConsoleOnOwnerItem(s.id)"),
                      "the compact row's press points the console at the item before opening it")
        XCTAssertTrue(press.contains("push(.console(sessionID: s.id, origin: .list))"),
                      "through the one push mechanism, as the row always did")

        let focus = try section(app, from: "private func focusConsoleOnOwnerItem(_ sessionID: String) {",
                                to: "    }\n")
        XCTAssertTrue(focus.contains("NeedsYouLogic.oldestOwnerItem([session])"),
                      "the item is the row's own — the oldest, which is what the row's line named")
        XCTAssertTrue(focus.contains(".focus(ownerItem: item)"),
                      "and it is the same focus the needs-you banner hands the console")

        // The three-column shells never go through that entry: their `List(selection:)` writes the
        // projection, whose setter carries the same act.
        let selection = try section(app, from: "var selectedAgentSessionID: String? {",
                                    to: "var composingAgentSession: Bool {")
        XCTAssertTrue(selection.contains("focusConsoleOnOwnerItem(id)"),
                      "selecting a row lands on its card too, in the other shell")
        XCTAssertTrue(selection
            .contains("nav.selectConsole(.console(sessionID: id, origin: .list))"),
                      "and writes the stack exactly as it did")
    }

    // MARK: the press goes through the doors

    /// The presses are the POSTs the browser makes — the hand-back (§4.7), the resume (§6.3 F-T4)
    /// and the ending, which the console test above reads — and the card reaches them through the
    /// console, which re-reads afterwards.
    func testThePressesAreTheBrowsersOwnDoors() throws {
        let card = try card()
        XCTAssertTrue(card.contains("await console.resumeFuse(row)")
                      && card.contains("await console.returnEscalatedItem(row)"),
                      "the card presses the console, which owns the credential and the re-read")

        let doors = try section(try source(Self.consolePath),
                                from: "func returnEscalatedItem(",
                                to: "/// M-T4: merge it.")

        XCTAssertTrue(doors.contains("api.returnOpenItemToCoordinator(projectID: projectID,"),
                      "the hand-back is `POST /projects/:id/open-items/:itemId/return-to-coordinator`")
        XCTAssertTrue(doors.contains("api.resumeProjectFuse(projectID: projectID, episodeID: episodeID)"),
                      "the resume is `POST /projects/:id/fuse/:episodeId/resume`, and it carries the "
                          + "episode the card was drawn from")
        XCTAssertTrue(doors.contains("await refreshRulerQuestions(force: true)"),
                      "both re-read the item list the card is derived from, so the card cannot keep "
                          + "offering a press it has already made")
        // A refusal is drawn where the press was made, in the notice the rest of the app uses.
        XCTAssertTrue(doors.contains("statusMessage = \"\\(ExceptionCards.notReturned)"),
                      "a refused hand-back says so, in the browser's own headline")
        XCTAssertTrue(doors.contains("statusMessage = \"\\(ExceptionCards.notResumed)"),
                      "and so does a refused resume")
    }
}
