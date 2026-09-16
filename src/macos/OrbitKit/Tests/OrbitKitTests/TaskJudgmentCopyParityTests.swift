import Foundation
import XCTest
@testable import OrbitKit

/// How a task's detail says a row is judged: the chip under its title, the header button on a row
/// with no work of its own, and the card naming the check that settles it. All of it is a hand-copy
/// of the browser's `components/TaskDetailPanel.tsx` (`GATE_ACTION_LABEL`, `GATE_CHIP`,
/// `COMPLETION_CRITERION_CHIP`, `VERIFICATION_SUBJECT_HINT`, `VERIFIER_CARD_HEADING`,
/// `VERIFIER_CARD_ENTRY` and the card's `Open` / `PASS` / `FAIL`). The two clients share no
/// compiler, so a sentence reworded at one end simply never appears at the other — and this is the
/// one surface where both tell a reader what settles the row in front of them.
///
/// Shaped after `WatchStripCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
final class TaskJudgmentCopyParityTests: XCTestCase {

    private static let webPanel = "src/web/src/components/TaskDetailPanel.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(TaskJudgmentCopyParityTests.webPanel) was not found above this test file. "
                    + "OrbitKit's task detail is one half of a pair; if the web half moved, move this "
                    + "check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it "
                    + "here too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web panel is under foot. Not a
    /// fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webPanel).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// The web panel with its string literals put back together: TypeScript wraps a long sentence
    /// as `'…' + '…'` across lines and lets a value sit on the line under its `=`; where those wraps
    /// fall is a formatting decision while the words are the contract.
    private func flat() throws -> String {
        let url = try repoRoot().appendingPathComponent(Self.webPanel)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(Self.webPanel)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing. `group` is for patterns whose group 1 is not the value —
    /// e.g. a backreferenced opening quote.
    private func capture(_ source: String, _ pattern: String, _ what: String,
                         group: Int = 1) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > group, let range = Range(match.range(at: group), in: source) else {
            throw ParityError.notDeclared(what: what, file: Self.webPanel)
        }
        return String(source[range])
    }

    /// A `Record<…>` literal's entries, key by key. A declaration that is there but has no entries
    /// is a failure too: an empty record compares green against an empty local map while the
    /// sentences it used to carry are gone from both ends at once.
    private func entries(_ source: String, _ declaration: String) throws -> [String: String] {
        let block = try capture(source, "const \(declaration)[^=]*= \\{(.*?)\\n\\};", declaration)
        let re = try NSRegularExpression(pattern: "\\b([A-Z_]+):\\s*(['\"])(.*?)\\2,",
                                         options: [.dotMatchesLineSeparators])
        var found: [String: String] = [:]
        for match in re.matches(in: block, range: NSRange(block.startIndex..., in: block)) {
            guard match.numberOfRanges > 3,
                  let key = Range(match.range(at: 1), in: block),
                  let value = Range(match.range(at: 3), in: block) else { continue }
            found[String(block[key])] = String(block[value])
        }
        guard !found.isEmpty else {
            throw ParityError.notDeclared(what: "any entry of \(declaration)", file: Self.webPanel)
        }
        return found
    }

    /// The button label and the two card strings, one declaration each.
    func testTheGateLabelsAreTheBrowsersDeclarations() throws {
        let web = try flat()
        let pairs: [(what: String, declaration: String, mine: String)] = [
            ("the header button on a row with no work of its own", "GATE_ACTION_LABEL",
             TaskJudgmentCopy.gateActionLabel),
            ("the chip under such a row's title", "GATE_CHIP", TaskJudgmentCopy.gateChip),
            ("the check card's heading", "VERIFIER_CARD_HEADING", TaskJudgmentCopy.verifierCardHeading),
            ("the way into the check", "VERIFIER_CARD_ENTRY", TaskJudgmentCopy.verifierCardEntry),
        ]
        for pair in pairs {
            // A backreference to the opening quote, so either quote style works at the other end.
            let theirs = try capture(web, "const \(pair.declaration) = ([\"'])(.+?)\\1;",
                                     pair.declaration, group: 2)
            XCTAssertEqual(pair.mine, theirs,
                           "\(pair.what) drifted — first is this client's, second is "
                               + "\(pair.declaration) in \(Self.webPanel).")
        }
    }

    /// The judgment chips, criterion for criterion: naming a method nobody declared, or wording one
    /// differently, is the panel telling two sets of readers different things about the same row.
    func testTheJudgmentChipsAreTheBrowsersChips() throws {
        let web = try flat()
        let theirs = try entries(web, "COMPLETION_CRITERION_CHIP")
        XCTAssertEqual(TaskJudgmentCopy.completionCriterionChip, theirs,
                       "the completion-method chips drifted — first is this client's map, second is "
                           + "COMPLETION_CRITERION_CHIP in \(Self.webPanel). A criterion with no chip "
                           + "here is a row this client describes as settled by nobody.")
    }

    /// What the check is doing, state for state — the hint under the button, and the empty state the
    /// card shows a row whose check has not been filed yet.
    func testTheVerifierHintsAreTheBrowsersHints() throws {
        let web = try flat()
        let theirs = try entries(web, "VERIFICATION_SUBJECT_HINT")
        XCTAssertEqual(TaskJudgmentCopy.verificationSubjectHint, theirs,
                       "the verifier-state hints drifted — first is this client's map, second is "
                           + "VERIFICATION_SUBJECT_HINT in \(Self.webPanel).")
        // The card's empty state is the browser's own alias of the MISSING sentence, so the two
        // places a reader is sent from cannot disagree about there being no check.
        XCTAssertEqual(TaskJudgmentCopy.verifierCardEmpty, theirs["MISSING"],
                       "the check card's empty state is no longer the browser's MISSING sentence.")
    }

    /// The card's three words for what the check concluded. The browser writes them inline in
    /// `verifierOutcome`, so they are read out of its body rather than off a declaration.
    func testTheCardsOutcomesAreTheBrowsersWords() throws {
        let web = try flat()
        let body = try capture(web, "export function verifierOutcome\\((.*?)\\n\\}", "verifierOutcome")
        let theirs = Set(try NSRegularExpression(pattern: "label: '([^']+)',")
            .matches(in: body, range: NSRange(body.startIndex..., in: body))
            .compactMap { match -> String? in
                guard match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: body) else {
                    return nil
                }
                return String(body[range])
            })
        guard !theirs.isEmpty else {
            throw ParityError.notDeclared(what: "any outcome label", file: Self.webPanel)
        }
        XCTAssertEqual(Set(VerifierOutcome.allCases.map(\.label)), theirs,
                       "the check card's outcome words drifted — first is this client's, second is "
                           + "what verifierOutcome returns in \(Self.webPanel).")
    }
}
