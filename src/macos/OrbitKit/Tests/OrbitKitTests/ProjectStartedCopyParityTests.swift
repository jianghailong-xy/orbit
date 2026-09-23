import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about a project start, and this is the tripwire that keeps
/// them doing it.
///
/// `ProjectStarted.swift` is a hand-copy of the browser's card (`ProjectStartedCard.tsx`), and the two
/// share no compiler: a sentence reworded at one end turns nothing else red. So every declaration the
/// card draws from is read out of the web source here, with its string literals put back together
/// first, and compared with the native one. A sentence with a number in it is rendered here with a
/// sentinel count (23, which no sentence contains) and looked for with the web's interpolation in
/// its place, so the WHOLE sentence has to match, not the words either side of the number.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`: a check that quietly opts out reports
/// green on exactly the day the thing it watches goes missing.
final class ProjectStartedCopyParityTests: XCTestCase {

    private static let webCard = "src/web/src/components/ProjectStartedCard.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case notFound(String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(ProjectStartedCopyParityTests.webCard) was not found above this test file. "
                    + "The native card is one half of a pair; if the web half moved, move this check "
                    + "with it rather than deleting it."
            case .notFound(let what):
                return "\(what) was not found in \(ProjectStartedCopyParityTests.webCard). Either it "
                    + "was reworded at one end — then say it the same way at both, which is what this "
                    + "check is for — or it was renamed, and this check moves with it."
            }
        }
    }

    private func webSource() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(Self.webCard)
            if FileManager.default.fileExists(atPath: url.path) {
                // String literals put back together, and a value lifted onto the line of its `=`:
                // where TypeScript wraps a sentence is formatting, and the words are the contract.
                return try String(contentsOf: url, encoding: .utf8)
                    .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "",
                                          options: .regularExpression)
                    .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`])", with: "= $1",
                                          options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    private func expect(_ source: String, _ fragment: String) throws {
        guard source.contains(fragment) else { throw ParityError.notFound(fragment) }
    }

    func testTheConstantsAreDeclaredAsTheWebDeclaresThem() throws {
        let web = try webSource()
        try expect(web, "PROJECT_STARTED_LABEL = '\(ProjectStartedCard.startedLabel)'")
        try expect(web, "PROJECT_SWITCHED_ON_LABEL = '\(ProjectStartedCard.switchedOnLabel)'")
        try expect(web, "PROJECT_STARTED_KIND_CONFIRMATION = '\(ProjectStartedCard.kindConfirmation)'")
        try expect(web, "PROJECT_STARTED_KIND_SWITCH = '\(ProjectStartedCard.kindSwitch)'")
        try expect(web, "PROJECT_STARTED_NONE_HELD = '\(ProjectStartedCard.noneHeld)'")
        try expect(web, "PROJECT_STARTED_NOTIFICATION = '\(ProjectStartedCard.notification)'")
        try expect(web, "PROJECT_STARTED_TOLD = '\(ProjectStartedCard.told)'")
        try expect(web, "PROJECT_STARTED_SHOW_FEWER = '\(ProjectStartedCard.showFewer)'")
        try expect(web, "PROJECT_STARTED_TASKS_SHOWN = \(ProjectStartedCard.tasksShown);")
        // A JSX text node has no quotes, so it is looked for between its tags.
        try expect(web, ">\(ProjectStartedCard.undelivered)<")
    }

    func testTheSentencesWithANumberInThemMatchWhole() throws {
        let web = try webSource()
        let sentinel = 23
        func template(_ rendered: String, _ interpolation: String) -> String {
            "`" + rendered.replacingOccurrences(of: "\(sentinel)", with: interpolation) + "`"
        }
        try expect(web, "`\(ProjectStartedCard.heldLead(1))`")
        try expect(web, template(ProjectStartedCard.heldLead(sentinel), "${count}"))
        try expect(web, template(ProjectStartedCard.showMore(sentinel), "${count}"))
        try expect(web, template(ProjectStartedCard.moreInProject(sentinel), "${count}"))

        let start = { (by: ProjectStartedBy, criteria: Int?) in
            ProjectStartedCard.startedBy(ProjectStarted(by: by, projectId: "p", projectTitle: "t",
                                                        criteriaCount: criteria))
        }
        try expect(web, "`\(start(.switch, nil))`")
        try expect(web, "`\(start(.confirmation, nil))`")
        try expect(web, "`\(start(.confirmation, 1))`")
        try expect(web, template(start(.confirmation, sentinel), "${card.criteriaCount}"))
    }
}
