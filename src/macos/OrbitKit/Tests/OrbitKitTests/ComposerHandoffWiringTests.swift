import Foundation
import XCTest
@testable import OrbitKit

/// The wires that make the composer the one place a reply is typed.
///
/// Three cards used to answer a question by growing a text box of their own, or by not offering one
/// at all. They now hand the sentence to the composer at the bottom of the screen: a question's
/// `Chat about this`, a decline of one of Orbit's own asks, and a confirmation's — three controls
/// saying the same words because they do the same thing (`Approvals.chatAction`). The
/// rules those replies are under live in OrbitKit and are proved next door
/// (`OwnerConfirmationDoorTests`, `ApprovalsTests`) — but none of that says the cards are attached
/// to them, and no compiler on this platform can: SwiftUI does not exist here, and
/// `ApprovalCards.swift` / `ConsoleModel.swift` are compiled only by the macOS and iOS jobs.
///
/// So the attachment is asserted the one way it can be from Linux — over the source — and each
/// assertion is written so that UNDOING the handoff is what turns it red:
///
///  - the confirmation card arms the composer and keeps no reason of its own;
///  - the composer's send routes each armed reply to that reply's own door, and a send-back to the
///    owner-confirmation door rather than to `POST /turns`;
///  - declining one of Orbit's own asks arms the composer, while a plain tool `Deny` stays one
///    press and done;
///  - an armed reply is dropped when its question is answered elsewhere, but NOT when a read
///    merely failed;
///  - the settlement card arms the composer with the plan it is about, and the send that consumes
///    that one starts an ordinary turn rather than reaching a door.
///
/// The same instrument, and the same limits, as `EvidenceDecisionWiringTests`: it cannot see layout.
final class ComposerHandoffWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the cards still hand their replies to the composer."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let composerPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift"

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

    // MARK: 1 — the confirmation card keeps no reason of its own

    /// `Chat about this` arms the composer with the waiting request, and the card holds no text.
    func testTheConfirmationCardArmsTheComposerInsteadOfOpeningABox() throws {
        let card = try source(Self.cardPath)
        let owner = try section(card, from: "private struct OwnerConfirmationCardView: View",
                                to: "private struct OwnerConfirmationBoxes: View")
        let button = try section(owner, from: "private func sendBackButton",
                                 to: "/// The press re-checks")

        XCTAssertTrue(button.contains("console.startOwnerSendBackReply(waiting"),
                      "the send-back press must hand the reply to the composer, with the request "
                          + "it was drawn for; without `waiting` there is nothing to answer")
        XCTAssertTrue(button.contains(".disabled(deciding || !standing.answerable)"),
                      "a card that cannot be answered cannot arm the composer either")

        // The old box, gone from the card entirely: not a TextField, not a second submit, and no
        // local reason state. A card that kept one would be a second place to type the same
        // sentence, which is the thing this change removes.
        XCTAssertFalse(owner.contains("TextField"),
                       "the confirmation card must not take text: the composer does")
        XCTAssertFalse(owner.contains("OwnerSendBackState"),
                       "the card holds no reason state — the composer's draft is the reason")
        XCTAssertFalse(owner.contains("OwnerConfirmations.sendAction"),
                       "the in-card submit is gone; the composer's own Send is the submit")
    }

    // MARK: 2 — the send goes to the armed reply's own door

    /// One send, three doors. The owner branch must reach `decideOwnerConfirmation` with
    /// `.sendBack` — routing it to `POST /turns` would post the reason as an ordinary message and
    /// leave the task waiting on a confirmation nobody answered.
    func testTheComposerSendRoutesEachArmedReplyToItsOwnDoor() throws {
        let console = try source(Self.consolePath)
        let reroute = try section(console, from: "// An armed reply answers a question",
                                  to: "// Resume eligibility depends on")

        XCTAssertTrue(reroute.contains("case .approval(let id):"),
                      "a question's reply still resolves its approval")
        XCTAssertTrue(reroute.contains("await replyToQuestion(approvalID: id, text: text)"),
                      "the approval branch answers as deny+message")
        XCTAssertTrue(reroute.contains("case .ownerConfirmation(let waiting):"),
                      "a send-back must be a branch of the send, not a card's own request")
        XCTAssertTrue(
            reroute.contains("await decideOwnerConfirmation(waiting, .sendBack, note: text)"),
            "the typed text must reach the owner-confirmation door as the SEND_BACK's reason")
        XCTAssertTrue(reroute.contains("replyContext = nil"),
                      "the bar is disarmed by the send that consumed it")
    }

    /// The bar and the placeholder are what the arming press decided, so each of the three reads as
    /// what it will do rather than as one generic "replying".
    func testTheComposerShowsWhatTheArmedReplyWillAnswer() throws {
        let composer = try source(Self.composerPath)

        XCTAssertTrue(composer.contains("Text(reply.banner)"),
                      "the reply bar prints the banner its card built")
        XCTAssertTrue(composer.contains("console.replyContext?.placeholder ?? \"Message…\""),
                      "an armed composer asks for what that reply needs; an idle one says Message…")
    }

    // MARK: 3 — declining a proposal is a conversation; denying a tool call is not

    func testDecliningOrbitsOwnAskArmsTheComposerAndAPlainDenyDoesNot() throws {
        let card = try source(Self.cardPath)
        let deny = try section(card, from: "private var denyButton: some View",
                               to: "private var declineSubject: String")

        XCTAssertTrue(deny.contains("guard Approvals.isOrbitAsk(toolName: tool) else {"),
                      "only Orbit's own proposals ask for a sentence")
        XCTAssertTrue(deny.contains("decide(console, approval, .deny)"),
                      "a plain tool-permission Deny stays one press and done")
        XCTAssertTrue(deny.contains("console.startDeclineReply(approvalID: approval.id"),
                      "declining a proposal hands the reason to the composer")
    }

    /// What the bar names is the proposal's own subject — a title, a count, a list — and never the
    /// tool's name, which says nothing about what is not being created.
    func testTheDeclineBarNamesWhatIsNotBeingDone() throws {
        let card = try source(Self.cardPath)
        let subject = try section(card, from: "private var declineSubject: String",
                                  to: "private struct OrbitAskBody")

        XCTAssertTrue(subject.contains("create.title"), "a create is named by its title")
        XCTAssertTrue(subject.contains("batch.taskCount"), "a batch is named by how many")
        XCTAssertTrue(subject.contains("dag.listTitle"), "a restructure is named by its list")

        // And the prefix says which of the two things is not happening.
        XCTAssertEqual(Approvals.decliningPrefix(toolName: "orbit_task_create"), "Not creating: ")
        XCTAssertEqual(Approvals.decliningPrefix(toolName: "orbit_task_batch"), "Not creating: ")
        XCTAssertEqual(Approvals.decliningPrefix(toolName: "orbit_project_create"), "Not creating: ")
        XCTAssertEqual(Approvals.decliningPrefix(toolName: "orbit_dag_change"),
                       "Leaving the graph alone: ",
                       "a restructure creates nothing, so it cannot be declined as a creation")
    }

    // MARK: 4 — an armed reply outlives a failed read, and not an answered question

    /// The distinction the reconcile is under: `isOpen` and not `answerable`. A read that has not
    /// come back leaves the standing `unread`, which is "this device cannot say" — disarming on it
    /// would throw away a reason somebody is in the middle of typing because one poll failed.
    func testAFailedReadDoesNotDisarmTheComposer() throws {
        let console = try source(Self.consolePath)
        let reconcile = try section(console, from: "private func reconcileReplyContext()",
                                    to: "// MARK: - scroll-up history paging")

        XCTAssertTrue(reconcile.contains("OwnerConfirmations.isOpen(standing)"),
                      "the confirmation branch must clear on `isOpen`, which keeps `unread` armed")
        XCTAssertFalse(reconcile.contains("standing.answerable"),
                       "clearing on `answerable` would disarm the composer on a failed read")
        XCTAssertTrue(reconcile.contains("state.pendingApprovals.contains(where: { $0.id == id })"),
                      "the approval branch still drops a reply whose approval resolved elsewhere")

        // The rule itself, so the assertion above is anchored to a fact and not only to a spelling.
        let unread = OwnerConfirmations.standing(nil, sessionID: "s", requestID: "r")
        XCTAssertTrue(OwnerConfirmations.isOpen(unread), "an unread standing is still a question")
        XCTAssertFalse(unread.answerable, "and still not answerable — which is why they differ here")
    }

    // MARK: 5 — the fourth control, which hands its reply to the composer through no door

    /// The settlement card's `Chat about this`: it arms the composer with the plan as it stands and
    /// keeps no sentence of its own, like the three above it — and then differs in the one way that
    /// matters, which is that the send it arms answers nothing. The agent has finished writing the
    /// criteria and is idle, so the send is an ordinary turn with the plan carried in front of the
    /// message; a branch that grew a door here would be this card answering a call nobody made.
    ///
    /// Written so that UNDOING the handoff is what turns it red: a card that opened a box of its
    /// own, or a send routed through `decideOwnerConfirmation`, fails here.
    func testTheSettlementCardArmsTheComposerAndItsSendReachesNoDoor() throws {
        let file = try source(Self.cardPath)
        // This card and no other: the file goes on after it (the two cards a project's OWNER
        // answers, §7.6 V13), and a slice that ran to the end of the file would hold every later
        // card to a rule that is this one's — the settlement card hands its sentence to the
        // composer, while a question with no options is answered in a box on its own card.
        let card = try section(file, from: "private struct AcceptanceConfirmationCard: View",
                               to: "\n// MARK: -")

        // The press's own body, read as STATEMENTS: a commented-out call still contains its own
        // words, so a `contains` over the file would stay green on exactly the day the handoff was
        // undone — which is the one day this check exists for.
        let press = try section(card, from: "private func chatButton(", to: "\n    }")
        let statements = press.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
        XCTAssertTrue(statements.contains("console.startPlanChangeReply(standing)"),
                      "the press must hand the reply to the composer, with the standing it was "
                          + "drawn for; without it there is no version to talk about")
        XCTAssertTrue(statements.contains(".disabled(standing == nil)"),
                      "and a card whose standing could not be read names no plan to talk about")

        // No box, and no draft of its own: the composer's is the sentence.
        XCTAssertFalse(card.contains("TextField"),
                       "the settlement card must not take text: the composer does")
        let states = card.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("@State") }
        XCTAssertEqual(states, ["@State private var confirming = false",
                                "@State private var criteriaOpen = false"],
                       "the card keeps whether a press is in flight and whether the criteria are "
                           + "unfolded, and nothing else — a draft of its own would be a second "
                           + "place to type the sentence the composer already takes")

        let console = try source(Self.consolePath)
        XCTAssertTrue(console.contains("AcceptanceConfirmations.planChangeContext("),
                      "the plan the send carries is built in OrbitKit, where its words are the "
                          + "browser's too (`AcceptanceConfirmationCopyParityTests`)")

        let reroute = try section(console, from: "// An armed reply answers a question",
                                  to: "// Resume eligibility depends on")
        XCTAssertTrue(reroute.contains("case .planChange(let context):"),
                      "nothing in the send handles an armed plan change")
        guard let branchAt = reroute.range(of: "case .planChange(let context):") else {
            throw WiringError.missing("the send's plan-change branch")
        }
        let branch = String(reroute[branchAt.upperBound...])
        // Joined rather than matched line by line: where the call wraps is a formatting decision,
        // while what it sends is the contract. Comment lines are still dropped first, so a sentence
        // about the call cannot stand in for the call.
        let sent = branch.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
        XCTAssertTrue(
            sent.contains(
                "await send(authoritative: authoritative, overrideText: \"\\(context)\\n\\n\\(text)\""),
            "the typed message must go out as an ordinary turn with the plan in front of it")
        // And with none of the composer's staged chips: an attachment cannot say what should change
        // about a plan, and the chips belong to the message they were picked for. Said outright
        // here because `send` otherwise carries the composer's own.
        XCTAssertTrue(sent.contains("overrideAttachments: []"),
                      "a plan change must say it carries no attachments, or it takes the chips "
                          + "staged for the next message out with it")
        for door in ["decideOwnerConfirmation", "replyToQuestion", "confirmStandardSet", "api."] {
            XCTAssertFalse(branch.contains(door),
                           "a plan change was routed through \(door): it answers no call, so it "
                               + "starts an ordinary turn and nothing else")
        }
    }
}
