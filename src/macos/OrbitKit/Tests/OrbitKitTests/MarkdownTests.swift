import XCTest
@testable import OrbitKit

final class MarkdownTests: XCTestCase {

    func testHeadingLevelsAndStripsHashes() {
        XCTAssertEqual(parseMarkdownBlocks("## Skill created: bytefinder"),
                       [.heading(level: 2, text: "Skill created: bytefinder")])
        // 1..6 only; 7 hashes is not a heading → paragraph
        XCTAssertEqual(parseMarkdownBlocks("####### too deep"),
                       [.paragraph(text: "####### too deep")])
        // `#` without a trailing space is not ATX → paragraph
        XCTAssertEqual(parseMarkdownBlocks("#nospace"),
                       [.paragraph(text: "#nospace")])
    }

    func testParagraphFoldsSoftNewlines() {
        XCTAssertEqual(parseMarkdownBlocks("line one\nline two"),
                       [.paragraph(text: "line one\nline two")])
        // a blank line breaks paragraphs
        XCTAssertEqual(parseMarkdownBlocks("a\n\nb"),
                       [.paragraph(text: "a"), .paragraph(text: "b")])
    }

    func testBulletAndOrderedLists() {
        XCTAssertEqual(parseMarkdownBlocks("- FROM cnch\n- tea_app_id"),
                       [.list(items: [
                            MarkdownListItem(indent: 0, ordered: false, number: nil, text: "FROM cnch"),
                            MarkdownListItem(indent: 0, ordered: false, number: nil, text: "tea_app_id"),
                       ])])
        XCTAssertEqual(parseMarkdownBlocks("1. bytefinder debug\n2. clickhouse translate"),
                       [.list(items: [
                            MarkdownListItem(indent: 0, ordered: true, number: 1, text: "bytefinder debug"),
                            MarkdownListItem(indent: 0, ordered: true, number: 2, text: "clickhouse translate"),
                       ])])
    }

    func testNestedListIndentDepth() {
        // 0 / 2 / 4 spaces → depth 0 / 1 / 2 regardless of the absolute indent unit.
        let blocks = parseMarkdownBlocks("- a\n  - b\n    - c\n- d")
        guard case .list(let items) = blocks[0] else { return XCTFail("expected a list") }
        XCTAssertEqual(items.map(\.indent), [0, 1, 2, 0])
        XCTAssertEqual(items.map(\.text), ["a", "b", "c", "d"])
    }

    func testBoldBulletIsNotConfusedWithRule() {
        // "**On-corp:** ..." starts with '*' but the next char isn't a space → paragraph, not a bullet.
        XCTAssertEqual(parseMarkdownBlocks("**On-corp:** direct, fast"),
                       [.paragraph(text: "**On-corp:** direct, fast")])
        // A real thematic break.
        XCTAssertEqual(parseMarkdownBlocks("---"), [.rule])
        XCTAssertEqual(parseMarkdownBlocks("***"), [.rule])
    }

    func testFencedCodeBlockWithLanguage() {
        let md = "```sh\nbash result_to_hive.sh zf95\n```"
        XCTAssertEqual(parseMarkdownBlocks(md),
                       [.code(language: "sh", code: "bash result_to_hive.sh zf95")])
    }

    func testFencedCodeKeepsMarkdownCharsVerbatim() {
        // Lines that look like headings/lists inside a fence are NOT parsed.
        let md = "```\n## not a heading\n- not a bullet\n```"
        XCTAssertEqual(parseMarkdownBlocks(md),
                       [.code(language: nil, code: "## not a heading\n- not a bullet")])
    }

    func testUnterminatedFenceClosesAtEOF() {
        XCTAssertEqual(parseMarkdownBlocks("```\nx = 1"),
                       [.code(language: nil, code: "x = 1")])
    }

    func testBlockquote() {
        XCTAssertEqual(parseMarkdownBlocks("> quoted line\n> second"),
                       [.quote(text: "quoted line\nsecond")])
    }

    func testMixedDocumentLikeTheScreenshot() {
        let md = """
        ## Skill created: bytefinder

        It chains the **two real** caps:
        1. bytefinder debug
        2. clickhouse translate

        Run it with:
        ```sh
        bash result_to_hive.sh zf95 sg
        ```
        """
        XCTAssertEqual(parseMarkdownBlocks(md), [
            .heading(level: 2, text: "Skill created: bytefinder"),
            .paragraph(text: "It chains the **two real** caps:"),
            .list(items: [
                MarkdownListItem(indent: 0, ordered: true, number: 1, text: "bytefinder debug"),
                MarkdownListItem(indent: 0, ordered: true, number: 2, text: "clickhouse translate"),
            ]),
            .paragraph(text: "Run it with:"),
            .code(language: "sh", code: "bash result_to_hive.sh zf95 sg"),
        ])
    }
}
