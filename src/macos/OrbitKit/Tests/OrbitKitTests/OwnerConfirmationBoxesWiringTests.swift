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
}
