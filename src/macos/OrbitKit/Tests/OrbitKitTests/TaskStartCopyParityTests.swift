import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `taskStart` payload the same way and say the same words about it, and
/// this is the tripwire that keeps them doing it.
///
/// `TaskStart.swift` is a hand-copy of the browser's reading of the payload and of the card's words
/// (`lib/taskStartCard.ts`), and of the few words the card component writes inline
/// (`TaskStartCard.tsx`). The Swift client and the browser bundle share no compiler, so a sentence
/// reworded at one end would simply never appear at the other. The judgment chips themselves are
/// `TaskJudgmentCopy`'s, which `TaskJudgmentCopyParityTests` already holds to the task panel — and the
/// web suite holds its card's copy of them to the same panel.
///
/// Shaped after `OpenItemDeliveryCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`.
final class TaskStartCopyParityTests: XCTestCase {

    private static let webLib = "src/web/src/lib/taskStartCard.ts"
    private static let webCard = "src/web/src/components/TaskStartCard.tsx"
    private static let shared = "src/shared/src/task-start.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(TaskStartCopyParityTests.webLib) was not found above this test file. "
                    + "OrbitKit's task-start card is one half of a pair; if the web half moved, move "
                    + "this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it here "
                    + "too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's reader is under foot.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webLib).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together — where TypeScript wraps a sentence
    /// is a formatting decision, the words are the contract.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`])", with: "= $1", options: .regularExpression)
    }

    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// A named constant, anchored on its declaration — not on the sentence, which a comment alone
    /// could satisfy.
    private func assertDeclares(_ source: String, _ name: String, _ value: String, line: UInt = #line) {
        let quoted = "'\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(source.contains("\(name) = \(quoted)"),
                      "\(name) drifted: \(Self.webLib) no longer declares it as \(quoted)",
                      file: #filePath, line: line)
    }

    /// A sentence the web writes as bare JSX text, which has no quotes to anchor on: anchored on the
    /// markup around it instead, which a comment cannot imitate.
    private func assertWritesInline(_ source: String, _ pattern: String, _ what: String, line: UInt = #line) {
        XCTAssertNotNil(source.range(of: pattern, options: .regularExpression),
                        "\(what) drifted: \(Self.webCard) no longer writes it", file: #filePath, line: line)
    }

    // MARK: the payload

    func testEveryFieldOfTheCardIsCalledWhatSharedCallsIt() throws {
        let shared = try flat(Self.shared)
        let body = try section(shared, from: "export interface TaskStartCard {", to: "\n}", Self.shared)
        let theirs = try captures(body, "(?m)^  (\\w+):")
        let mine = Mirror(reflecting: TaskStart(taskId: "t", title: "x")).children.compactMap(\.label)

        XCTAssertFalse(theirs.isEmpty, "no field of the interface was captured — the check is asleep")
        XCTAssertEqual(mine, theirs, "TaskStartCard's fields drifted — first is this client's (in "
                           + "declaration order), second is the interface in \(Self.shared).")
    }

    func testTheCriteriaAreSpelledTheSameOnBothEnds() throws {
        let shared = try flat(Self.shared)
        let declared = try captures(shared, "export type TaskStartCriterion = (.+?);").first
        let theirs = try XCTUnwrap(declared, "TaskStartCriterion is not declared in \(Self.shared)")
            .split(separator: "|")
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "'")) }
        XCTAssertEqual(TaskStartCriterion.allCases.map(\.rawValue), theirs)
    }

    func testTheReaderRequiresTheSameTwoKeys() throws {
        let web = try flat(Self.webLib)
        XCTAssertTrue(web.contains("typeof card.taskId !== 'string' || card.taskId === ''"))
        XCTAssertTrue(web.contains("typeof card.title !== 'string' || card.title === ''"))
        XCTAssertTrue(web.contains("auto: card.auto === true"), "auto defaults to false at both ends")
        XCTAssertNil(TaskStart.parse(.object(["taskStart": .object(["title": .string("x")])])))
        XCTAssertNil(TaskStart.parse(.object(["taskStart": .object(["taskId": .string("t")])])))
    }

    // MARK: the words

    func testTheCardsWordsAreTheWebsWords() throws {
        let web = try flat(Self.webLib)
        assertDeclares(web, "TASK_START_LABEL", TaskStartCard.header)
        assertDeclares(web, "TASK_START_AUTO_LABEL", TaskStartCard.autoLabel)
        assertDeclares(web, "TASK_START_SHOW_DETAILS", TaskStartCard.showDetails)
        assertDeclares(web, "TASK_START_HIDE_DETAILS", TaskStartCard.hideDetails)
        assertDeclares(web, "TASK_START_CRITERIA_HEADING", TaskStartCard.criteriaHeading)
        assertDeclares(web, "TASK_START_INSTRUCTIONS_HEADING", TaskStartCard.instructionsHeading)
        assertDeclares(web, "TASK_START_SHOW_COMMAND", TaskStartCard.showCommand)
        assertDeclares(web, "TASK_START_HIDE_COMMAND", TaskStartCard.hideCommand)
        assertDeclares(web, "TASK_START_OPEN_TASK", TaskStartCard.openTask)
        assertDeclares(web, "TASK_START_RAW_SUMMARY", TaskStartCard.rawSummary)
        XCTAssertTrue(web.contains("const DESCRIPTION_FOLD_CHARS = \(TaskStartCard.descriptionFoldChars);"),
                      "the fold drifted: \(Self.webLib) folds a description at a different length")
    }

    /// What each judgment means for the run. Three are whole literals; the EXECUTABLE one is built
    /// around the exit code, so this end renders it with a sentinel the sentence does not otherwise
    /// contain and swaps the web's interpolation in for it — the whole sentence must match.
    func testTheJudgmentLinesAreTheWebsWords() throws {
        let web = try flat(Self.webLib)
        for criterion in [TaskStartCriterion.ownerConfirmed, .evidenceJudgment, .verification] {
            let line = try XCTUnwrap(TaskStartCard.judgedHow(TaskStart(taskId: "t", title: "x",
                                                                       completionCriterion: criterion)))
            XCTAssertTrue(web.contains("'\(line)'"), "\(criterion.rawValue)'s line drifted: \(line)")
        }
        let executable = try XCTUnwrap(TaskStartCard.judgedHow(TaskStart(
            taskId: "t", title: "x", completionCriterion: .executable, acceptanceExpectedExitCode: 23)))
        let template = executable.replacingOccurrences(of: "23", with: "${card.acceptanceExpectedExitCode ?? 0}")
        XCTAssertTrue(web.contains("`\(template)`"), "EXECUTABLE's line drifted: \(executable)")
    }

    /// The few words the web card writes as JSX text rather than as a named constant.
    func testTheCardComponentWritesTheSameInlineWords() throws {
        let card = try flat(Self.webCard)
        assertWritesInline(card, ">\\s*\(TaskStartCard.projectLabel)\\{' '\\}", "the project row's label")
        assertWritesInline(card, ">\\s*Task \\{taskPublic", "the footnote's \"Task\"")
        assertWritesInline(card, ">\(NSRegularExpression.escapedPattern(for: TaskStartCard.undelivered))<",
                           "the undelivered line")
        XCTAssertTrue(TaskStartCard.meta(TaskStart(taskId: "01a0cca7-8609-70ed-a0e2-d4b55b832b60", title: "x"))
            .hasPrefix("Task "))
    }
}
