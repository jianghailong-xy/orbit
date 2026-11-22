import Foundation
import XCTest
@testable import OrbitKit

/// Wake bubble behavior stays aligned with the web transcript.
final class BackgroundJobsCopyParityTests: XCTestCase {
    private static let webTranscript = "src/web/src/components/Transcript.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(BackgroundJobsCopyParityTests.webTranscript) was not found above this test file. "
                    + "The wake bubble check needs the web transcript; if it moved, "
                    + "move this check with it rather than deleting it."
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
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webTranscript).path) {
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

    /// A wake draws a bubble only for words somebody typed.
    func testAWakeTurnDrawsNoBubbleForABlockNobodyTyped() throws {
        let web = try flat(Self.webTranscript)
        let branch = try section(web, from: "      const jobNews = parseBackgroundWake(node.note);",
                                 to: "return <UserBubble node={node} queued={queued} />;", Self.webTranscript)

        assertBuilt(branch, "{node.text.trim() !== '' && <UserBubble",
                    "the bubble drawn only for words somebody typed", Self.webTranscript)
        // A job's news alone draws no line, and a bubble only for words somebody typed (board C1).
        assertBuilt(branch, "const background = wakeupsOnly(jobNews);",
                    "the line drawn for a wakeup only", Self.webTranscript)
        assertBuilt(branch, "if (!background) return node.text.trim() !== '' ? <UserBubble",
                    "a job's news drawing nothing but typed words", Self.webTranscript)
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: ""))
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: "\n  \n"))
        XCTAssertTrue(BackgroundWakeCard.drawsBubble(text: "把它做完"))
    }
}
