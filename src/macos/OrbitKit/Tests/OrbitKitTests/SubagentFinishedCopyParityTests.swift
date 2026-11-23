import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read a SubAgent's end the same way and say the same words about it.
///
/// `SubagentFinished.swift` is a hand-copy of the browser's reading (`lib/subagentFinished.ts`), and
/// `SubagentCardEnd.swift` of how the card ends (`SubagentCardEnd.tsx`, landed first, board
/// docs/mocks/subagent-card-and-end-line). Neither end compiles the other, so a pattern or a word changed
/// at one end would simply never reach the other — and a wording only one end reads turns the end turn
/// into a From Orbit line. A missing counterpart is a FAILURE, never an `XCTSkip`.
final class SubagentFinishedCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/subagentFinished.ts"
    private static let webCard = "src/web/src/components/SubagentCardEnd.tsx"
    private static let webRuns = "src/web/src/lib/subagentRuns.ts"
    private static let webQueue = "src/web/src/lib/queuedTurnRestore.ts"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let webCss = "src/web/src/index.css"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) {
                // Long sentences wrapped as `'…' + '…'` read as the one string they are.
                return try String(contentsOf: url, encoding: .utf8)
                    .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "SubagentFinishedCopyParityTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) was not found above this test file"])
    }

    /// The body of `const <name> = /…/flags;` in the web reader.
    private func regexLiteral(_ name: String, in source: String) throws -> String {
        let re = try NSRegularExpression(pattern: "const \(name) = /(.*)/[a-z]*;")
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              let range = Range(match.range(at: 1), in: source) else {
            throw NSError(domain: "SubagentFinishedCopyParityTests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "\(name) is no longer declared in \(Self.webReader)"])
        }
        return String(source[range])
    }

    /// The other end writes exactly these words: as a string in any of its three quotes, or as JSX text
    /// standing alone between tags.
    private func assertWritten(_ source: String, _ value: String, _ file: String, line: UInt = #line) {
        let quoted = ["'", "\"", "`"].contains { source.contains("\($0)\(value)\($0)") }
        let escaped = NSRegularExpression.escapedPattern(for: value)
        let jsx = source.range(of: ">\\s*\(escaped)\\s*(<|\\{)", options: .regularExpression) != nil
        XCTAssertTrue(quoted || jsx, "\(file) no longer writes \(value.debugDescription)", line: line)
    }

    func testBothEndsReadTheBlockWithTheSamePatterns() throws {
        let web = try source(Self.webReader)
        XCTAssertEqual(SubagentFinishedText.blockPattern, try regexLiteral("BLOCK", in: web))
        XCTAssertEqual(SubagentFinishedText.headPattern, try regexLiteral("HEAD", in: web))
        XCTAssertEqual(SubagentFinishedText.sentencePattern, try regexLiteral("SENTENCE", in: web))
        // The lines a run's head is followed by, and where a result's lines sit.
        for line in ["line === '  Result:'", "line === '  (no result)'", "line.startsWith('    ')",
                     "run.status !== 'DONE'", "rest: (rest + note.slice(end)).replace(/\\n{3,}/g, '\\n\\n').trim()",
                     "text: blocks.join('\\n\\n')"] {
            XCTAssertTrue(web.contains(line), "\(Self.webReader) no longer reads \(line)")
        }
    }

    func testTheCardEndsInTheWebsWords() throws {
        let card = try source(Self.webCard)
        // The reason, one fixed sentence per end, said once.
        for status in ["INTERRUPTED", "FAILED", "STOPPED"] {
            let reason = try XCTUnwrap(SubagentCardEnd.because(status))
            XCTAssertTrue(card.contains("\(status): '\(reason)',"), "\(Self.webCard) no longer says \(reason)")
        }
        XCTAssertNil(SubagentCardEnd.because("DONE"))
        for word in [SubagentCardEnd.showFiles, SubagentCardEnd.rawSummary] {
            assertWritten(card, word, Self.webCard)
        }
        XCTAssertTrue(card.contains("\(SubagentCardEnd.waiting) ·{' '}"))
        XCTAssertTrue(card.contains(SubagentCardEnd.dontSend.replacingOccurrences(of: "'", with: "&apos;")))
        // The templates, filled the way this end fills them.
        XCTAssertTrue(card.contains("`${n} ${n === 1 ? 'file' : 'files'} left uncommitted`"))
        XCTAssertEqual(SubagentCardEnd.fileCount(1), "1 file left uncommitted")
        XCTAssertEqual(SubagentCardEnd.fileCount(9), "9 files left uncommitted")
        XCTAssertTrue(card.contains("const first = files.slice(0, 2).map(basename);"))
        XCTAssertTrue(card.contains("`+${files.length - first.length}`"))
        XCTAssertTrue(card.contains(".join(' · ')"))
        XCTAssertEqual(SubagentCardEnd.fileNames(["a/model-routing.ts", "b/task-route-decision.ts", "c", "d"]),
                       "model-routing.ts · task-route-decision.ts · +2")
        XCTAssertEqual(SubagentCardEnd.fileNames(["only.ts"]), "only.ts")
        XCTAssertTrue(card.contains("{fileCount(files.length)} in the working tree:"))
        XCTAssertEqual(SubagentCardEnd.filesHead(9), "9 files left uncommitted in the working tree:")
        XCTAssertTrue(card.contains("… {files.length - shown.length} more"))
        XCTAssertEqual(SubagentCardEnd.moreFiles(6), "… 6 more")
        XCTAssertTrue(card.contains("const FILES_SHOWN = \(SubagentCardEnd.filesShown);"))
        XCTAssertTrue(card.contains("`Stopped${when} by the agent.`"))
        XCTAssertTrue(card.contains(
            "`${run.status === 'FAILED' ? 'Failed' : 'Interrupted'}${when}: ${lowerFirst(BECAUSE[run.status as keyof typeof BECAUSE])}`"))
        XCTAssertEqual(SubagentCardEnd.endHead("INTERRUPTED", when: "10m ago"),
                       "Interrupted 10m ago: the runner hosting it stopped (a restart, an update or a crash) before it finished.")
        XCTAssertEqual(SubagentCardEnd.endHead("FAILED", when: nil), "Failed: it did not finish its work.")
        XCTAssertEqual(SubagentCardEnd.endHead("STOPPED", when: "2m ago"), "Stopped 2m ago by the agent.")
        XCTAssertNil(SubagentCardEnd.endHead("DONE", when: "2m ago"))
        XCTAssertTrue(card.contains("Run {runId}"))
        XCTAssertTrue(card.contains("{readAt && ` · read by the agent at ${readAt}`}"))
        XCTAssertEqual(SubagentCardEnd.runLine("R1", readAt: "14:02"), "Run R1 · read by the agent at 14:02")
        XCTAssertEqual(SubagentCardEnd.runLine("R1", readAt: nil), "Run R1")
        XCTAssertTrue(card.contains("toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })"))
        // The chip is the status in lower case, every end but DONE; grey for a stop, red otherwise.
        XCTAssertTrue(card.contains("const word = run.status.toLowerCase();"))
        XCTAssertTrue(card.contains("status === 'DONE' ? 'ok' : status === 'STOPPED' ? 'stopped' : 'failed'"))
        XCTAssertEqual(SubagentCardEnd.chip("INTERRUPTED"), "interrupted")
        XCTAssertNil(SubagentCardEnd.chip("DONE"))
        XCTAssertEqual(SubagentCardEnd.tone("STOPPED"), .stopped)
        XCTAssertEqual(SubagentCardEnd.tone("FAILED"), .failed)
        XCTAssertEqual(SubagentCardEnd.tone("INTERRUPTED"), .failed)
        // Only a background run that has ended draws its end on the card.
        XCTAssertTrue(card.contains("run && run.background && run.status !== 'RUNNING'"))
    }

    func testTheResultShowsTwoLinesAsTheWebsDoes() throws {
        let css = try source(Self.webCss)
        guard let start = css.range(of: ".chat-subagent-ending-md > .md {"),
              let end = css.range(of: "}", range: start.upperBound..<css.endIndex) else {
            return XCTFail("\(Self.webCss) no longer clamps the ending")
        }
        XCTAssertTrue(css[start.upperBound..<end.lowerBound]
            .contains("-webkit-line-clamp: \(SubagentCardEnd.resultLines);"))
    }

    /// The end turn draws nothing on the web either, folds as nothing, and leaves the queued tail when it
    /// carries no job's news; a stop is no failure.
    func testTheEndTurnDrawsNothingAsTheWebsDoes() throws {
        let transcript = try source(Self.webTranscript)
        XCTAssertFalse(transcript.contains("SubagentFinishedCard"), "the web draws the end turn again")
        XCTAssertTrue(transcript.contains("const background = wakeupsOnly(parseBackgroundWake(subagent ? subagent.rest : node.note));"))
        let queue = try source(Self.webQueue)
        XCTAssertTrue(queue.contains("alone: wakeupsOnly(parseBackgroundWake(wake.rest)) === null"))
        XCTAssertTrue(queue.contains("if (turn.sessionMessage) return null;"))
        let runs = try source(Self.webRuns)
        XCTAssertTrue(runs.contains("run.status === 'FAILED' || run.status === 'INTERRUPTED';"))
        XCTAssertFalse(runs.contains("run.status === 'INTERRUPTED' || run.status === 'STOPPED'"))
    }
}
