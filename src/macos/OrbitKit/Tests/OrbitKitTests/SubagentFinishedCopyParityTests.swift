import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read the same SubAgent wake block, including its status, result, and remaining note.
///
/// The browser uses that block on the run's existing card. Its copy, preview, and fold rules are
/// pinned here independently of the native finish line. A missing source is a failure.
final class SubagentFinishedCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/subagentFinished.ts"
    private static let webCard = "src/web/src/components/SubagentCardEnd.tsx"
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

    func testTheWebShowsTheWakeOnTheRunsCard() throws {
        let card = try source(Self.webCard)
        for word in [SubagentFinishedCard.rawSummary, "Show files", "Stopped by the agent.",
                     "It did not finish its work.",
                     "The runner hosting it stopped (a restart, an update or a crash) before it finished."] {
            assertWritten(card, word, Self.webCard)
        }
        XCTAssertTrue(card.contains("\(SubagentFinishedCard.run) {runId}"))
        XCTAssertTrue(card.contains("const word = run.status.toLowerCase();"))
        XCTAssertTrue(card.contains("aria-label=\"done\""))
        XCTAssertTrue(card.contains("if (!run.resultSummary) return null;"))
        XCTAssertTrue(card.contains("<pre>{wake.text}</pre>"))

        let transcript = try source(Self.webTranscript)
        XCTAssertTrue(transcript.contains(
            "for (const run of wake.runs) out.set(run.runId, { text: wake.text, readAt: read ? node.ts : undefined });"))
    }

    func testTheWebFoldedCardPreviewsTwoLinesOfResult() throws {
        let css = try source(Self.webCss)
        guard let start = css.range(of: ".chat-subagent-ending-md > .md {"),
              let end = css.range(of: "}", range: start.upperBound..<css.endIndex) else {
            return XCTFail("\(Self.webCss) no longer styles the folded card's result")
        }
        XCTAssertTrue(css[start.upperBound..<end.lowerBound].contains("-webkit-line-clamp: 2;"))
    }

    func testTheWebOnlyFoldsJobNewsFromASubagentWake() throws {
        let transcript = try source(Self.webTranscript)
        guard let turn = transcript.range(of: "function orbitTurnOf("),
              let end = transcript.range(of: "\n}", range: turn.upperBound..<transcript.endIndex),
              let start = transcript.range(of: "const subagent = parseSubagentFinished(node.note);",
                                           range: turn.upperBound..<end.lowerBound) else {
            return XCTFail("\(Self.webTranscript) no longer handles SubAgent wakes in the fold classifier")
        }
        XCTAssertEqual(String(transcript[start.lowerBound..<end.lowerBound]), """
        const subagent = parseSubagentFinished(node.note);
          const background = parseBackgroundWake(subagent ? subagent.rest : node.note);
          if (background) {
            if (background.jobs.some((job) => job.status === 'failed' || job.status === 'killed')) return null;
            const title = backgroundWakeTitle(background);
            const name = backgroundWakeName(background);
            return { ts, what: name ? `${title}: ${name}` : title, category: 'job', target: null };
          }
          return null;
        """)
    }
}
