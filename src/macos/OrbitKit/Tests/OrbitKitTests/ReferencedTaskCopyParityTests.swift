import Foundation
import XCTest
@testable import OrbitKit

/// Shared task lifecycle labels stay aligned with the web pill.
final class ReferencedTaskCopyParityTests: XCTestCase {
    private static let webPill = "src/web/src/components/TaskStatusPill.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(ReferencedTaskCopyParityTests.webPill) was not found above this test "
                    + "file. The shared task status mapping needs the web pill; if it "
                    + "moved, move this check with it rather than deleting it."
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

    /// The repo root, found by walking up from this file until the web's reader is under foot. Not a
    /// fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webPill).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // A missing web counterpart must fail rather than silently skip the parity check.
        throw ParityError.noRepo
    }

    private func read(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// A web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` across lines and lets a value — a string or a
    /// regular expression — sit on the line under its `=`; where those wraps fall is a formatting
    /// decision while the words are the contract.
    private func flat(_ relative: String) throws -> String {
        try read(relative)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`/])", with: "= $1", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing.
    private func capture(_ source: String, _ pattern: String, _ what: String,
                         _ file: String) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: source) else {
            throw ParityError.notDeclared(what: what, file: file)
        }
        return String(source[range])
    }

    /// From one marker to the next occurrence of another, so a match elsewhere in the file cannot
    /// answer for the stretch being asserted about.
    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// A sentence the other end builds around a value of its own, so there is no whole literal to
    /// compare — the words either side of the interpolation are.
    private func assertBuilt(_ source: String, _ value: String, _ what: String, _ file: String,
                             line: UInt = #line) {
        XCTAssertTrue(source.contains(value),
                      "\(what) drifted: \(file) no longer builds \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    /// The pill a card opens on. Both ends draw the task lifecycle with the same five words, and a
    /// status neither knows under its own name — a card that renamed a status would be describing a
    /// different task.
    func testTheStatusIsPilledInTheSameWords() throws {
        let web = try flat(Self.webPill)
        let declared = try section(web, from: "const STATUS_PILL", to: "\n}", Self.webPill)

        for status in ["DONE", "IN_PROGRESS", "OPEN", "FAILED", "CANCELLED"] {
            let theirs = try capture(declared, "\(status): \\{ cls: '[^']+', label: '([^']+)' \\}",
                                     status, Self.webPill)
            XCTAssertEqual(ReferencedTaskNote.pill(status: status).label, theirs,
                           "the pill for \(status) drifted — first is this client's, second is "
                               + "STATUS_PILL in \(Self.webPill).")
        }
        // A status neither end knows keeps its own name rather than borrowing a wrong one.
        XCTAssertEqual(ReferencedTaskNote.pill(status: "ARCHIVED").label, "ARCHIVED")
        assertBuilt(web, "?? { cls: 'todo', label: status }", "a status neither end knows",
                    Self.webPill)
    }
}
