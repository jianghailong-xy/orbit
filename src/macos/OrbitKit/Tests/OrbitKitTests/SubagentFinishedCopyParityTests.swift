import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read a SubAgent's end the same way and say the same words about it.
///
/// `SubagentFinished.swift` is a hand-copy of the browser's reading (`lib/subagentFinished.ts`) and of
/// the line it draws (`SubagentFinishedCard.tsx`, landed first, board docs/mocks/subagent-finished-line).
/// Neither end compiles the other, so a pattern or a word changed at one end would simply never reach
/// the other — and a wording only one end reads turns the turn back into the reader's own bubble under
/// "Orbit attached: context". A missing counterpart is a FAILURE, never an `XCTSkip`.
final class SubagentFinishedCopyParityTests: XCTestCase {

    private static let webReader = "src/web/src/lib/subagentFinished.ts"
    private static let webCard = "src/web/src/components/SubagentFinishedCard.tsx"
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

    func testTheLineSaysTheWebsWords() throws {
        let card = try source(Self.webCard)
        for word in [SubagentFinishedCard.noResult, SubagentFinishedCard.showFullResult,
                     SubagentFinishedCard.showLess, SubagentFinishedCard.details,
                     SubagentFinishedCard.cardLink, SubagentFinishedCard.changes,
                     SubagentFinishedCard.queuedBy, SubagentFinishedCard.rawSummary,
                     "SubAgent finished", "SubAgent did not finish", "done", "✦", "✓", "✕"] {
            assertWritten(card, word, Self.webCard)
        }
        // `Run <span className="sawake-run-id">…`, and the separators around the card link.
        XCTAssertTrue(card.contains("\(SubagentFinishedCard.run) <span className=\"sawake-run-id\">"))
        XCTAssertTrue(card.contains("<span className=\"sawake-meta-name\">{run.description} · </span>"))
        // The templates, filled the way this end fills them.
        XCTAssertTrue(card.contains("`${wake.runs.length} SubAgents finished`"))
        XCTAssertTrue(card.contains("`${failed} of ${wake.runs.length} failed`"))
        XCTAssertTrue(card.contains("return wake.runs[0].status.toLowerCase();"))
        XCTAssertTrue(card.contains("{run.status.toLowerCase()}"))
        // One of several says its first line, else why it ended, else No result.
        XCTAssertTrue(card.contains("const line = first || run.reason || 'No result';"))
        // A lone run that finished with nothing to hand back has no box under its line.
        XCTAssertTrue(card.contains("if (ok && run.result === '') return null;"))
        // The undelivered sentence and the steer's state are the background wake's own.
        XCTAssertTrue(card.contains("<div className=\"bgwake-undelivered\">\(BackgroundWakeCard.undelivered)</div>"))
        let transcript = try source(Self.webTranscript)
        XCTAssertTrue(transcript.contains(
            "const steer = node.steer && !undelivered ? steerDeliveryState(node.delivery).label : undefined;"))
        XCTAssertEqual(SteerDelivery.state("acknowledged").label, "Read in this turn")
    }

    func testTheResultShowsThreeLinesAsTheWebsDoes() throws {
        let css = try source(Self.webCss)
        guard let start = css.range(of: ".sawake-result-md.is-clamped > .md {"),
              let end = css.range(of: "}", range: start.upperBound..<css.endIndex) else {
            return XCTFail("\(Self.webCss) no longer clamps the result")
        }
        XCTAssertTrue(css[start.upperBound..<end.lowerBound]
            .contains("-webkit-line-clamp: \(SubagentFinishedCard.previewLines);"))
    }

    func testTheFoldNamesTheTurnAsTheWebsDoes() throws {
        let transcript = try source(Self.webTranscript)
        guard let start = transcript.range(of: "const subagent = parseSubagentFinished(node.note);"),
              let end = transcript.range(of: "const background = parseBackgroundWake(node.note);",
                                         range: start.upperBound..<transcript.endIndex) else {
            return XCTFail("\(Self.webTranscript) no longer folds a SubAgent's end")
        }
        let fold = transcript[start.lowerBound..<end.lowerBound]
        XCTAssertTrue(fold.contains("if (subagent.runs.some((run) => !subagentFinishedOk(run))) return null;"))
        XCTAssertTrue(fold.contains("what: name ? `${title}: ${name}` : title, category: 'job'"))
    }
}
