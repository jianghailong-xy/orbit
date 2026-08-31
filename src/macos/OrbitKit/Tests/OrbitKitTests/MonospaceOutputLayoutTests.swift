import XCTest
@testable import OrbitKit

final class MonospaceOutputLayoutTests: XCTestCase {
    private func lines(_ count: Int, padding: Int = 0) -> String {
        let suffix = String(repeating: "x", count: padding)
        return (1...count).map { "line \($0)\(suffix)" }.joined(separator: "\n")
    }

    func testSixteenLinesFitWithoutAControl() {
        let text = lines(16)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.lineCount, 16)
        XCTAssertEqual(layout.hiddenLineCount, 0)
        XCTAssertFalse(layout.isCollapsible)
        XCTAssertEqual(layout.transcriptText(expanded: false), text)
    }

    func testSeventeenShortLinesCanStillExpandInline() {
        let text = lines(17)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.hiddenLineCount, 1)
        XCTAssertTrue(layout.isCollapsible)
        XCTAssertFalse(layout.requiresDedicatedViewer)
        XCTAssertEqual(layout.transcriptText(expanded: false), lines(16))
        XCTAssertEqual(layout.transcriptText(expanded: true), text)
    }

    func testReportedBashOutputNeverBecomesOneGiantTranscriptCell() {
        // The production result behind the report is exactly 15,484 lines: the old button showed
        // 15,468 hidden lines, then put every one of them into a single UICollectionView cell.
        let text = lines(15_484, padding: 100)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertGreaterThan(text.count, 1_600_000)
        XCTAssertEqual(layout.lineCount, 15_484)
        XCTAssertEqual(layout.hiddenLineCount, 15_468)
        XCTAssertTrue(layout.requiresDedicatedViewer)
        XCTAssertEqual(layout.transcriptText(expanded: false), lines(16, padding: 100))
        XCTAssertEqual(layout.transcriptText(expanded: true), lines(16, padding: 100))
        XCTAssertEqual(layout.text, text, "the dedicated viewer must still receive the full result")
    }

    func testOneHugeUnbrokenLineIsAlsoKeptOutOfTheTranscript() {
        // The same affected session also contains 217k-character single-line results. They used to
        // bypass the line-only fold completely and render at full wrapped height before any tap.
        let text = String(repeating: "x", count: 217_092)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.lineCount, 1)
        XCTAssertEqual(layout.hiddenLineCount, 0)
        XCTAssertTrue(layout.previewByteClipped)
        XCTAssertTrue(layout.isCollapsible)
        XCTAssertTrue(layout.requiresDedicatedViewer)
        XCTAssertLessThan(layout.previewText.count, text.count)
        XCTAssertEqual(layout.transcriptText(expanded: true), layout.previewText)
    }

    func testLargeFinalResultOverridesAnEarlierInlineOpenState() {
        let expanded = true
        let preview = MonospaceOutputLayout(text: lines(17))
        XCTAssertEqual(preview.transcriptText(expanded: expanded), preview.text)

        let final = MonospaceOutputLayout(text: lines(15_484))
        XCTAssertEqual(final.transcriptText(expanded: expanded), final.previewText)
        XCTAssertNotEqual(final.transcriptText(expanded: expanded), final.text)
    }

    func testMultibyteSingleLineCannotBypassTheByteBudget() {
        let text = String(repeating: "😀", count: 3_000)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.lineCount, 1)
        XCTAssertEqual(layout.utf8Count, 12_000)
        XCTAssertTrue(layout.previewByteClipped)
        XCTAssertTrue(layout.isCollapsible)
        XCTAssertTrue(layout.requiresDedicatedViewer)
        XCTAssertLessThanOrEqual(layout.previewText.utf8.count,
                                 MonospaceOutputLayout.previewByteLimit + "…".utf8.count)
        XCTAssertEqual(layout.transcriptText(expanded: true), layout.previewText)
    }

    func testOneHugeCombiningGraphemeCannotBypassTheByteBudget() {
        let text = "a" + String(repeating: "\u{0301}", count: 10_000)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(text.count, 1, "the fixture must remain one Swift Character")
        XCTAssertTrue(layout.previewByteClipped)
        XCTAssertTrue(layout.requiresDedicatedViewer)
        XCTAssertLessThanOrEqual(layout.previewText.utf8.count,
                                 MonospaceOutputLayout.previewByteLimit + "…".utf8.count)
        XCTAssertEqual(layout.transcriptText(expanded: true), layout.previewText)
    }

    func testCarriageReturnOnlyProgressOutputUsesLogicalLines() {
        let text = (1...3_000).map { "progress \($0)" }.joined(separator: "\r")
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.lineCount, 3_000)
        XCTAssertEqual(layout.hiddenLineCount, 2_984)
        XCTAssertTrue(layout.requiresDedicatedViewer)
        XCTAssertEqual(layout.previewText, (1...16).map { "progress \($0)" }.joined(separator: "\r"))
        XCTAssertEqual(layout.transcriptText(expanded: true), layout.previewText)
    }

    func testCRLFCountsAsOneLogicalSeparator() {
        let text = (1...17).map { "line \($0)" }.joined(separator: "\r\n")
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.lineCount, 17)
        XCTAssertEqual(layout.hiddenLineCount, 1)
        XCTAssertEqual(layout.previewText, (1...16).map { "line \($0)" }.joined(separator: "\r\n"))
    }

    func testEveryUnicodeNewlineScalarUsesTheLineBudget() {
        for separator in ["\u{000B}", "\u{000C}", "\u{0085}", "\u{2028}", "\u{2029}"] {
            let text = (1...201).map { "line \($0)" }.joined(separator: separator)
            let layout = MonospaceOutputLayout(text: text)

            XCTAssertEqual(layout.lineCount, 201, "separator U+\(separator.unicodeScalars.first!.value)")
            XCTAssertTrue(layout.requiresDedicatedViewer)
            XCTAssertEqual(layout.previewText,
                           (1...16).map { "line \($0)" }.joined(separator: separator))
        }
    }

    func testByteClippedInlineLineCanExpandWithoutZeroLineLabelState() {
        let text = String(repeating: "x", count: 5_000)
        let layout = MonospaceOutputLayout(text: text)

        XCTAssertEqual(layout.hiddenLineCount, 0)
        XCTAssertTrue(layout.previewByteClipped)
        XCTAssertFalse(layout.requiresDedicatedViewer)
        XCTAssertEqual(layout.transcriptText(expanded: false), layout.previewText)
        XCTAssertEqual(layout.transcriptText(expanded: true), text)
    }

    func testDedicatedViewerLineAndByteBoundaries() {
        XCTAssertFalse(MonospaceOutputLayout(text: lines(200)).requiresDedicatedViewer)
        XCTAssertTrue(MonospaceOutputLayout(text: lines(201)).requiresDedicatedViewer)
        XCTAssertFalse(MonospaceOutputLayout(text: String(repeating: "x", count: 8_192))
            .requiresDedicatedViewer)
        XCTAssertTrue(MonospaceOutputLayout(text: String(repeating: "x", count: 8_193))
            .requiresDedicatedViewer)
    }
}
