import Foundation
import XCTest
@testable import OrbitKit

/// The three wires between this logic and the SwiftUI card that renders it on macOS and iOS.
///
/// OrbitKit is UI-free and that is what lets it be tested on Linux — but it also means the rules
/// proved next door (`EvidenceDecisionTests`) prove nothing about the card unless the card is
/// actually attached to them. No compiler checks that on this platform: SwiftUI does not exist
/// here, and `ApprovalCards.swift` is compiled only by the macOS and iOS jobs. So the attachment
/// is asserted the one way it can be from Linux — over the source — and each assertion is written
/// so that DETACHING the wire is what turns it red:
///
///  - the send control is disabled by `canSend` and by nothing else, so a send-back with no reason
///    cannot be pressed (deleting the modifier is the negative control, and it goes red);
///  - `确认完成` calls the answer directly, so one press submits and there is no pick-then-Submit
///    step left in between;
///  - the body reads the ROW. `row.claim` / `row.gaps` reach the card through `EvidenceDecisions`,
///    and the question's own string appears in exactly one place: the fold at the bottom.
///
/// This is a weaker instrument than the web card's DOM test and it is used because it is the
/// strongest one available where these tests run. What it cannot see is layout.
final class EvidenceDecisionWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case noCard
        var description: String {
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift was not found above this "
                + "test. If the card moved, move this check with it rather than deleting it: it is "
                + "the only gate on Linux that sees whether the card is still wired to OrbitKit."
        }
    }

    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"

    private func cardSource() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.cardPath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.noCard
    }

    /// The section of the file the assertions below are about, so a match somewhere else in a
    /// 900-line file cannot answer for the card. (A bare `contains` over the whole file is how a
    /// scan like this goes falsely green.)
    private func decisionSection(_ source: String) throws -> String {
        guard let start = source.range(of: "struct EvidenceDecisionCard: View"),
              let end = source.range(of: "struct PlanCard: View") else {
            throw WiringError.noCard
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    func testSendBackIsGatedByCanSendAndNothingElse() throws {
        let card = try decisionSection(try cardSource())
        XCTAssertTrue(card.contains(".disabled(!sendBack.canSend)"),
                      "the send control must be disabled by the state's own rule — without this "
                          + "modifier a SEND_BACK with no note is pressable and the door writes "
                          + "nothing at all")
        XCTAssertTrue(card.contains("if let action = sendBack.action { onAnswer(action) }"),
                      "and what it sends is the action that state vouches for, not a note read "
                          + "straight out of the field")
    }

    func testConfirmSubmitsOnTheFirstPress() throws {
        let card = try decisionSection(try cardSource())
        XCTAssertTrue(card.contains("Button { onAnswer(.confirm) }"),
                      "确认完成 answers on the press: no selection state in between")
        XCTAssertFalse(card.contains("allAnswered"),
                       "the generic form's pick-then-Submit gate has no place on this card")
        XCTAssertFalse(card.contains("OptionRow("),
                       "and neither do its option rows — that path is the OTHER card")
    }

    func testTheBodyIsReadFromTheRow() throws {
        let card = try decisionSection(try cardSource())
        for reading in ["EvidenceDecisions.foldedClaim(row.claim",
                        "EvidenceDecisions.gapPreview(row)",
                        "EvidenceDecisions.checks(row)",
                        "EvidenceDecisions.meta(row)"] {
            XCTAssertTrue(card.contains(reading), "the card must read \(reading)")
        }
        // The question's own string reaches the screen in exactly one place — the verbatim fold at
        // the bottom — and it is never taken apart to produce a line above it. Both halves matter:
        // rendering it twice would put the wall of text back, and splitting it would be the card
        // parsing the string again under a different name.
        XCTAssertEqual(card.components(separatedBy: "Text(questionText)").count - 1, 1,
                       "the flattened string is rendered once, in the fold at the bottom")
        for parse in [".components(separatedBy", ".split(separator", "questionText.range(",
                      "questionText.contains(", "questionText.prefix("] {
            XCTAssertFalse(card.contains(parse),
                           "nothing above the fold may be parsed out of the question string (\(parse))")
        }
    }

    /// The fork itself: a question is this card only when `EvidenceDecisions.rows` says so, and the
    /// generic form is what renders otherwise.
    func testTheGenericFormIsStillTheDefault() throws {
        let source = try cardSource()
        XCTAssertTrue(source.contains("EvidenceDecisions.rows(for: approval, queue: console.pendingDecisions)"))
        XCTAssertTrue(source.contains("QuestionCard(console: console, approval: approval)"),
                      "every question that is not one of those rows still renders as the form")
    }
}
