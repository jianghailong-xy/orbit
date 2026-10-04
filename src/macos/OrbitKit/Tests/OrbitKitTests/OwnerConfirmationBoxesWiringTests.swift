import Foundation
import XCTest
@testable import OrbitKit

/// What the owner-confirmation card's two boxes show, asserted over the source for the reason
/// `ComposerHandoffWiringTests` gives: SwiftUI does not exist on Linux, and `ApprovalCards.swift` is
/// compiled only by the macOS and iOS jobs. The words themselves are proved next door
/// (`OwnerConfirmationDoorTests`); this is what says the box is attached to them.
final class OwnerConfirmationBoxesWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found. If it moved, move this check with it rather than "
                    + "deleting it: it is the only gate on Linux that sees what the confirmation "
                    + "card's report box shows."
            }
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"

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
    /// somewhere else cannot answer for the part being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// `Show all` shows all of it. The box used to draw the folded text however the toggle stood:
    /// its label and chevron turned, the words did not, and a long report could not be finished on
    /// a phone.
    func testShowAllShowsTheWholeReport() throws {
        let boxes = try section(try source(Self.cardPath),
                                from: "private struct OwnerConfirmationBoxes: View",
                                to: "private struct OwnerDecisionReceiptView: View")
        XCTAssertTrue(boxes.contains("OwnerConfirmations.plainText(report?.text)"),
                      "the box must have the whole report to show")
        XCTAssertTrue(boxes.contains("reportOpen ? said : folded.text"),
                      "an open box shows the whole report, a closed one the fold")
    }

    /// One stretch's markers, in this order — each found after the one before it.
    private func assertOrder(_ text: String, _ markers: [String], _ what: String,
                             line: UInt = #line) {
        var from = text.startIndex
        for marker in markers {
            guard let found = text.range(of: marker, range: from..<text.endIndex) else {
                XCTFail("\(what): \(marker.debugDescription) is missing or out of order", line: line)
                return
            }
            from = found.upperBound
        }
    }

    /// If you confirm sits right above the buttons: under the two boxes, over the buttons, with only
    /// a stale card's explanation ever between them — and a stale card draws no block, because the
    /// read's consequences belong to the report that is waiting, not to this one.
    func testIfYouConfirmIsDrawnRightAboveTheButtons() throws {
        let card = try section(try source(Self.cardPath),
                               from: "private struct OwnerConfirmationCardView: View",
                               to: "private struct OwnerConfirmationBoxes: View")
        assertOrder(card, [
            "OwnerConfirmationBoxes(acceptanceCriteria: view.acceptanceCriteria,",
            "ifYouConfirm(view, standing)",
            "OwnerConfirmations.staleExplanation(standing)",
            "ApprovalActions {",
            "confirmButton(standing)",
        ], "the card's order")
        XCTAssertTrue(card.contains(
            "let rows = standing.waiting == nil ? [] : OwnerConfirmations.ifConfirmedRows(view.ifConfirmed)"),
            "the block's rows come from the read, and only while this card's report is waiting")
        XCTAssertTrue(card.contains("if !rows.isEmpty {\n            OwnerConfirmationIfYouConfirm(rows: rows)"),
                      "no rows, no block")
    }

    /// The block says what `ifConfirmedRows` made and nothing else, under its own heading, with no
    /// author on it.
    func testTheBlockDrawsTheRowsAndNoAuthor() throws {
        let block = try section(try source(Self.cardPath),
                                from: "private struct OwnerConfirmationIfYouConfirm: View",
                                to: "private struct OwnerDecisionReceiptView: View")
        for needle in ["Text(OwnerConfirmations.ifYouConfirm)", "Text(row.lead)", "Text(added)",
                       "Text(detail)", "case .start: return \"play.fill\""] {
            XCTAssertTrue(block.contains(needle), "the block no longer draws \(needle)")
        }
        // A row's first line wraps: without this the list cut "Goes onto the integration line;
        // merging into main asks you again" to one line on a phone.
        XCTAssertTrue(block.contains(".font(.orbitSubtext.weight(.semibold))\n"
                                         + "                            .fixedSize(horizontal: false, vertical: true)"),
                      "a row's first line may be cut to one line again")
        for author in ["whatTheRunReported", "provenanceLabel", "reportHeading"] {
            XCTAssertFalse(block.contains(author), "the block names an author: \(author)")
        }
    }

    /// What counts as done is folded to one row on the card and opens in place; the receipt keeps it
    /// open behind its own fold, so a reader who asked to see it is not asked again.
    func testTheCardFoldsWhatCountsAsDoneAndTheReceiptDoesNot() throws {
        let file = try source(Self.cardPath)
        let card = try section(file, from: "private struct OwnerConfirmationCardView: View",
                               to: "private struct OwnerConfirmationBoxes: View")
        let boxes = try section(file, from: "private struct OwnerConfirmationBoxes: View",
                                to: "private struct OwnerConfirmationIfYouConfirm: View")
        let receipt = try section(file, from: "private struct OwnerDecisionReceiptView: View",
                                  to: "struct PlanCard: View")
        XCTAssertTrue(card.contains("report: standing.waiting?.report, foldsCriteria: true)"),
                      "the card folds its criteria")
        XCTAssertTrue(receipt.contains("OwnerConfirmationBoxes(acceptanceCriteria: view.acceptanceCriteria,"),
                      "the receipt still opens to the boxes")
        XCTAssertFalse(receipt.contains("foldsCriteria"), "the receipt folds nothing a second time")
        XCTAssertTrue(boxes.contains(
            "if foldsCriteria, let items = OwnerConfirmations.criteriaItemsLabel(acceptanceCriteria) {"),
            "the row counts what the fixture counts, and nothing written is the box saying so")
        XCTAssertTrue(boxes.contains("if criteriaOpen {\n                quietOrText(criteria, "),
                      "the criteria open in place, inside the row's own box")
    }
}
