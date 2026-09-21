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
///  - the press goes through the console's doors, which are the two POSTs the browser uses.
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

    // MARK: the press goes through the doors

    /// The two presses are the two POSTs the browser makes — the hand-back (§4.7) and the resume
    /// (§6.3 F-T4) — and the card reaches them through the console, which re-reads afterwards.
    func testThePressesAreTheBrowsersTwoDoors() throws {
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
