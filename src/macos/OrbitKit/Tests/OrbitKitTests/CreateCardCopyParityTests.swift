import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words on the card that asks to create one task, and this is the
/// tripwire that keeps them saying them.
///
/// The card was rebuilt around the batch card's skeleton — its header became a count, its two long
/// fields became folds, and its acceptance criteria began sharing the fold the owner-confirmation
/// card already puts over a run's report. Every one of those is a phrase a person reads on a phone
/// and on the web in the same minute, and with no compiler between a SwiftUI view and a browser
/// bundle the only thing that can compare them is a test that reads the browser's source.
///
/// Compared by declaration wherever the web half declares one (`CREATE_DONE_WHEN`), and by the
/// template's own shape where it builds the line (`createFoldLabel`) — never by a bare phrase, which
/// a comment could satisfy. Two things are deliberately NOT compared, and both for the same reason:
/// the fold's noun. `the description (… characters)` and `the goal (…)` are the web card's own
/// choice of noun per kind, and the Swift end takes the noun as an argument (`Approvals.createFold`)
/// — so what is pinned is the sentence around it, on both ends, and the nouns are pinned by
/// `OrbitAskPreviewTests` on this end and by `ApprovalPanel.test.tsx` on the other.
final class CreateCardCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/ApprovalPanel.tsx"

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
                return "\(CreateCardCopyParityTests.webCard) was not found above this test file. "
                    + "OrbitKit's create card is one half of a pair; if the web half moved, move this "
                    + "check with it rather than deleting it."
            case .noFile(let path):
                return "\(path) was not found in the repository. The create card's words reach both "
                    + "clients from it; if it moved, move this check with it."
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

    private func assertContains(_ web: String, _ needle: String, _ what: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(needle),
                      "\(what) drifted: the web end no longer contains \(needle.debugDescription)",
                      file: file, line: line)
    }

    /// This end's rendered line with its values put back as the web template's interpolations, so
    /// the whole sentence is compared and not only the words around a number.
    private func template(_ rendered: String, _ values: [(String, String)]) -> String {
        values.reduce(rendered) { line, pair in
            line.replacingOccurrences(of: pair.0, with: pair.1)
        }
    }

    // MARK: the words on the card

    func testTheHeaderIsTheSameCountSentenceWebDraws() throws {
        let web = try flat(Self.webCard)

        // The web half composes it into its own `Confirm: create 1 task?` line, so the casing
        // differs by where in the sentence the words sit. What must not differ is the sentence.
        assertContains(web.lowercased(), Approvals.createHeading.lowercased(),
                       "the single create card's header")
    }

    func testTheFoldOverTheLongFieldMatchesTheWebCard() throws {
        let web = try flat(Self.webCard)

        // Rendered by this end and read back as the browser's template, the way the owner card's
        // parity test compares `REPORT_CLAMP`: a label built from a number on both ends is a label
        // that can come to disagree about the number.
        assertContains(web,
                       "`\(template(Approvals.createFold("${noun}", 0), [("0", "${chars}")]))`",
                       "the fold over the description")
        assertContains(web, "`\(template(Approvals.createFoldHide("${noun}"), []))`",
                       "what that fold says once it is open")
        // The noun is what the two ends agree to call the field, and it is the same disagreement
        // whether it is written in a template or in a Swift switch.
        assertContains(web, "? 'goal' : 'description'", "the noun the fold names")
    }

    func testTheCaptionOverTheCriteriaMatchesTheWebCard() throws {
        let web = try flat(Self.webCard)

        assertContains(web, "export const CREATE_DONE_WHEN = '\(Approvals.createDoneWhen)';",
                       "the caption over the acceptance criteria")
    }

    func testBothEndsFoldTheCriteriaAtTheOwnerCardsCeiling() throws {
        let web = try flat(Self.webCard)

        // One number, in the file that already owns it: the create card reuses the ceiling the
        // owner-confirmation card folds a run's report at rather than declaring a second one, and
        // this is what stops a second one appearing under a different name.
        assertContains(web, "REPORT_CLAMP", "the ceiling the criteria is folded at")
        assertContains(try flat("src/web/src/components/OwnerConfirmationCard.tsx"),
                       "const REPORT_CLAMP = \(OwnerConfirmations.reportClamp);",
                       "the ceiling itself")
    }
}
