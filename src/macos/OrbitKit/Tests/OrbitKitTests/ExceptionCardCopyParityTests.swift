import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words on the exception-todo cards, and this is the tripwire that
/// keeps them saying them.
///
/// The cards were the one part of §7.5 the native clients did not draw at all, so a person counted
/// by the "needs you" banner could open the conversation they were sent to and find nothing to
/// press (the account owner's report, 2026-09-21). What is drawn here is a port of
/// `ProjectProgressStatus.tsx`'s three cards, and with no compiler between a SwiftUI view and a
/// browser bundle the only thing that can compare them is a test that reads the browser's source.
///
/// Compared by DECLARATION wherever the web half declares one (`FROM_ORBIT`, `ACTION_LABEL`, the
/// modal copy, `HAND_CLOSABLE_KINDS`), and by the template's own shape where it builds the line
/// (the two headings, `waitingLabel`, `ownerLine`) — never by a bare phrase, which a comment could
/// satisfy. The four titles the cards wear for the four kinds (`Merge conflict — needs a fix on the
/// task branch`, `Checks failed on the combined tree`, …) are deliberately NOT compared: they are
/// the SERVER's sentences, arriving in `row.title`, and this end composes none of them —
/// `ExceptionCardsTests` pins that they arrive unchanged instead.
final class ExceptionCardCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/ProjectProgressStatus.tsx"

    /// The repo root, found by walking up from this file until the web card is under foot — not a
    /// fixed number of `..` hops, because the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.webCard).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`: a check that quietly opts out reports green
        // on exactly the day the thing it watches went missing.
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case noFile(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(ExceptionCardCopyParityTests.webCard) was not found above this test file. "
                    + "OrbitKit's exception cards are one half of a pair; if the web half moved, move "
                    + "this check with it rather than deleting it."
            case .noFile(let path):
                return "\(path) was not found in the repository. The exception cards' words reach "
                    + "both clients from it; if it moved, move this check with it."
            }
        }
    }

    /// One web source with its string literals put back together — TypeScript wraps a long sentence
    /// as `'…' + '…'` across lines, and where that wrap falls is formatting while the words are the
    /// contract.
    private func flat(_ relativePath: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relativePath)
        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw ParityError.noFile(relativePath)
        }
        return source
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*['`]", with: "= '", options: .regularExpression)
    }

    private func web() throws -> String { try flat(Self.webCard) }

    private func assertContains(_ source: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(needle),
                      "\(what) drifted: the web end no longer contains \(needle.debugDescription)",
                      file: file, line: line)
    }

    /// The text between two markers of the web source, for the checks that have to be about ONE
    /// block rather than about the file (`HAND_CLOSABLE_KINDS` names four kinds, and three of those
    /// names appear elsewhere in the file for other reasons).
    private func block(_ source: String, from: String, to: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        guard let start = source.range(of: from) else {
            throw ParityError.noFile("\(from) in \(Self.webCard)")
        }
        guard let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.noFile("\(to) after \(from) in \(Self.webCard)")
        }
        return String(source[start.upperBound..<end.lowerBound])
    }

    private func row(_ over: (inout Fixture) -> Void = { _ in }) -> ProjectOpenItemRow {
        var f = Fixture()
        over(&f)
        return ProjectOpenItemRow(
            itemId: f.itemId, kind: f.kind, title: f.title, detailLine: f.detailLine,
            assignee: f.assignee, assigneeReason: f.assigneeReason, waitingSince: f.waitingSince,
            escalateAt: f.escalateAt, escalatedAt: f.escalatedAt, taskId: f.taskId,
            sessionId: f.sessionId, promotionId: f.promotionId, fuseEpisodeId: f.fuseEpisodeId,
            delivery: f.delivery, actions: f.actions, question: f.question)
    }

    private struct Fixture {
        var itemId = "3mZLAZL3OvQix77hxsBQYH"
        var kind = ProjectOpenItemKind.taskFailed
        var title = "Task failed"
        var detailLine = ""
        var assignee = ProjectOpenItemAssignee.coordinator
        var assigneeReason = ProjectOpenItemAssigneeReason.default
        var waitingSince = "2026-09-13T10:02:00.000Z"
        var escalateAt: String?
        var escalatedAt: String?
        var taskId: String?
        var sessionId: String?
        var promotionId: String?
        var fuseEpisodeId: String?
        var delivery = ProjectOpenItemDelivery()
        var actions: [ProjectOpenItemAction] = []
        var question: CoordinatorQuestion?
    }

    // MARK: the mark, and the one press that is not on the server's list

    func testTheProvenanceMarkIsTheSameOnBothEnds() throws {
        let web = try web()

        assertContains(web, "export const FROM_ORBIT = '\(ExceptionCards.fromOrbit)';",
                       "the mark Orbit-filed cards wear")
        assertContains(web, "export const FROM_ORBIT_TITLE = '\(ExceptionCards.fromOrbitTitle)';",
                       "what the mark explains on a hover")
    }

    func testMarkAsHandledAndItsDialogMatchTheWebCard() throws {
        let web = try web()

        assertContains(web, "export const MARK_HANDLED = '\(ExceptionCards.markHandled)';",
                       "the press the owner ends an exception with")
        assertContains(web,
                       "export const MARK_HANDLED_MODAL_TITLE = '\(ExceptionCards.markHandledModalTitle)';",
                       "what that press asks first")
        assertContains(web,
                       "export const MARK_HANDLED_MODAL_BODY = '\(ExceptionCards.markHandledModalBody)';",
                       "what the dialog says the ending does and does not touch")
        // The prompt over the reason box. The web half writes it inline rather than as an export,
        // which is why this one is matched on the element's own text.
        assertContains(web, ">\n          \(ExceptionCards.markHandledReasonPrompt)\n        </label>",
                       "the question over the reason box")
    }

    func testCancelTasksDialogMatchesTheWebCard() throws {
        let web = try web()

        assertContains(web,
                       "export const CANCEL_TASK_MODAL_TITLE = '\(ExceptionCards.cancelTaskModalTitle)';",
                       "what the cancel press asks first")
        assertContains(web, "export const CANCEL_TASK_MODAL_OK = '\(ExceptionCards.cancelTaskModalOk)';",
                       "the word the dialog's confirm wears")
        assertContains(web,
                       "export const CANCEL_TASK_MODAL_BODY = '\(ExceptionCards.cancelTaskModalBody)';",
                       "what the confirm says it stops, and what it leaves alone")
    }

    // MARK: the headings

    func testEveryEscalationHeadingIsTheWebsOwnSentence() throws {
        let web = try web()

        // The five ways an item becomes the owner's, each a declaration-level assertion: the
        // template with its interpolation, not the words around a number.
        assertContains(web,
                       "return `Now yours — no one acted on this for ${waitedBeforeEscalation(row)}`;",
                       "the clock's own escalation")
        assertContains(web, "return 'Now yours — the coordinator conversation ended';",
                       "the conversation that ended")
        assertContains(web, "return 'Now yours — the 3rd failure in this chain';",
                       "the chain that ran out")
        assertContains(web, "return 'Now yours — the coordinator handed it over';",
                       "the hand-over")
        assertContains(web,
                       "return `Now yours — this project has no coordinator (waiting ${formatSpan(waitedMs(row, now))})`;",
                       "the project with nobody coordinating it")

        // And this end renders each of them from the same row. The instants are the web test's own,
        // so the sentence that comes out is the sentence it asserts.
        let now = RelativeTime.parse("2026-09-13T12:00:00.000Z")!
        let mine = { (reason: ProjectOpenItemAssigneeReason) -> ProjectOpenItemRow in
            self.row {
                $0.assignee = .owner; $0.assigneeReason = reason
                $0.waitingSince = "2026-09-13T10:00:00.000Z"
                $0.escalatedAt = "2026-09-13T10:00:00.000Z"
            }
        }
        XCTAssertEqual(ExceptionCards.escalationHeading(mine(.coordinatorEnded), now: now),
                       "Now yours — the coordinator conversation ended")
        XCTAssertEqual(ExceptionCards.escalationHeading(mine(.chainLimit), now: now),
                       "Now yours — the 3rd failure in this chain")
        XCTAssertEqual(ExceptionCards.escalationHeading(mine(.handedOver), now: now),
                       "Now yours — the coordinator handed it over")
        XCTAssertEqual(ExceptionCards.escalationHeading(mine(.noCoordinator), now: now),
                       "Now yours — this project has no coordinator (waiting 2h)")
    }

    // MARK: the two time lines

    func testTheWaitingLineIsBuiltTheWayTheWebBuildsIt() throws {
        let web = try web()

        assertContains(web, "if (row.escalateAt == null) return `waiting ${waited}`;",
                       "an item with no window on it")
        assertContains(web,
                       "return left > 0 ? `${waited} · goes to you in ${formatSpan(left)}` : `${waited} · due to come to you`;",
                       "the window, and what it says once it has run out")
        assertContains(web, "if (row.escalatedAt != null) return `escalated ${ago(row.escalatedAt, now)}`;",
                       "an escalated item, dated by when it arrived")

        // The same two instants the web's own test uses (waiting 18m, goes to you in 1h 42m), so the
        // rendered sentence is compared and not only the template around it.
        let theirs = self.row {
            $0.waitingSince = "2026-09-13T11:42:00.000Z"
            $0.escalateAt = "2026-09-13T13:42:00.000Z"
        }
        let now = RelativeTime.parse("2026-09-13T12:00:00.000Z")!
        XCTAssertEqual(ExceptionCards.waitingLabel(theirs, now: now), "18m · goes to you in 1h 42m")
    }

    func testTheFooterIsTheWebsOwnSentence() throws {
        let web = try web()

        assertContains(web, "if (row.assignee === 'OWNER') return `Owner: you · ${waited}`;",
                       "the footer of an item the owner has")
        assertContains(web, "? `Owner: coordinator · ${waited} · goes to the owner in ${formatSpan(left)}`",
                       "the footer of one the coordinator has, with its window")
        assertContains(web, ": `Owner: coordinator · ${waited}`;",
                       "and the same one without a window")

        let now = RelativeTime.parse("2026-09-13T12:00:00Z")!
        let theirs = self.row {
            $0.waitingSince = "2026-09-13T11:42:00.000Z"
            $0.escalateAt = "2026-09-13T13:42:00.000Z"
        }
        XCTAssertEqual(ExceptionCards.ownerLine(theirs, now: now),
                       "Owner: coordinator · waiting 18m · goes to the owner in 1h 42m")
        let mine = self.row {
            $0.assignee = .owner; $0.waitingSince = "2026-09-13T09:54:00.000Z"
        }
        XCTAssertEqual(ExceptionCards.ownerLine(mine, now: now), "Owner: you · waiting 2h 6m")
    }

    // MARK: what each press is called

    func testEveryActionLabelIsTheWebsOwn() throws {
        let web = try web()

        // Compared action by action, both directions: a label this end has that the web renamed is
        // as much a drift as one it lost. The raw values ARE the web's action names.
        for action in ProjectOpenItemAction.allCases where action != .unknown {
            guard let label = ExceptionCards.actionLabel[action] else {
                XCTFail("\(action.rawValue) has no label — a press the server lists would not be drawn")
                continue
            }
            assertContains(web, "  \(action.rawValue): '\(label)',",
                           "the label of \(action.rawValue)")
        }
        // The map is closed: no press is drawn under a name that is not one of the eight.
        XCTAssertEqual(ExceptionCards.actionLabel.count, 8)
    }

    func testTheKindsAnOwnerMayCloseByHandAreTheWebsOwn() throws {
        let web = try web()
        let declared = try block(web, from: "const HAND_CLOSABLE_KINDS: ReadonlySet<OpenItemKind> = new Set<OpenItemKind>([",
                                 to: "]);")

        for kind in [ProjectOpenItemKind.integrationConflict, .integrationCheckFailed,
                     .integrationError, .taskFailed] {
            assertContains(declared, "'\(kind.rawValue)'",
                           "\(kind.rawValue) among the kinds a hand may close")
            XCTAssertTrue(ExceptionCards.handClosableKinds.contains(kind))
        }
        // And the ones it deliberately leaves out, checked on the web's own block rather than on the
        // file — a question, a merge and a pause each have a press of their own.
        for kind in [ProjectOpenItemKind.coordinatorQuestion, .promotionApproval, .fusePaused] {
            XCTAssertFalse(declared.contains("'\(kind.rawValue)'"),
                           "\(kind.rawValue) must not be hand-closable on either end")
            XCTAssertFalse(ExceptionCards.handClosableKinds.contains(kind))
        }
        XCTAssertEqual(ExceptionCards.handClosableKinds.count, 4)
    }

    // MARK: the ids the two ends are pointed at by

    func testTheCardsKeepTheWebsOwnElementIds() throws {
        let web = try web()

        assertContains(web, "id={id ?? `open-item-${row.itemId}`}",
                       "the exception card's own element id")
        assertContains(web, "id={`fuse-${row.itemId}`}", "the pause card's own element id")

        // The same spelling, from this end's side of the pair: a push or a banner press that names
        // an item has to land on the row the other client would find it under.
        XCTAssertEqual(DeliveredDecisionCard(kind: .exceptionItem(itemID: "i1")).id, "open-item-i1")
        XCTAssertEqual(DeliveredDecisionCard(kind: .fusePause(itemID: "i1")).id, "fuse-i1")
    }

    func testTheKindsAreDrawnByTheWebsOwnRule() throws {
        let web = try web()

        // Which card a row is, in the web's own order of decisions: the pause first (it writes), the
        // two kinds that have a card of their own are not drawn here, and everything else is the
        // plain card or the escalated one by whether a heading says how it got here.
        assertContains(web, "if (row.kind === 'FUSE_PAUSED') {",
                       "the pause getting the card with a write behind it")
        assertContains(web,
                       "if (row.kind === 'COORDINATOR_QUESTION' || row.kind === 'PROMOTION_APPROVAL') return null;",
                       "the two kinds that are left to their own cards")
        assertContains(web,
                       "return escalationHeading(row, now) != null ? (",
                       "the escalated card, decided by the heading rather than by the assignee")
    }
}
