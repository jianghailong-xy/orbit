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

    func testGfmTableParsesIntoTableBlock() {
        // The screenshot's failure mode: a GFM pipe table must become a .table block, not a
        // paragraph of literal pipes. Cells carry inline source; multibyte (Chinese) is preserved.
        let md = """
        | app_id | status | 动作 |
        |---|---|---|
        | 55 | ready | 标记完成 |
        | 303039 | pending | 评论 |
        """
        XCTAssertEqual(parseMarkdownBlocks(md), [
            .table(MarkdownTable(
                headers: ["app_id", "status", "动作"],
                rows: [["55", "ready", "标记完成"], ["303039", "pending", "评论"]],
                alignments: [.none, .none, .none]
            )),
        ])
    }

    func testTableColumnAlignments() {
        let md = """
        | L | C | R |
        |:--|:--:|--:|
        | 1 | 2 | 3 |
        """
        XCTAssertEqual(parseMarkdownBlocks(md), [
            .table(MarkdownTable(
                headers: ["L", "C", "R"],
                rows: [["1", "2", "3"]],
                alignments: [.left, .center, .right]
            )),
        ])
    }

    func testTableCellKeepsInlineMarkdown() {
        let md = """
        | name | note |
        |---|---|
        | **bold** | a `code` b |
        """
        XCTAssertEqual(parseMarkdownBlocks(md), [
            .table(MarkdownTable(
                headers: ["name", "note"],
                rows: [["**bold**", "a `code` b"]],
                alignments: [.none, .none]
            )),
        ])
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

    func testStandaloneAttachmentImageBecomesImageBlock() {
        // The runner (and hand-authored agent messages) reference an uploaded attachment this way.
        XCTAssertEqual(
            parseMarkdownBlocks("![Orbit prototype](orbit-attachment:019f491a-fe9e-7e01)"),
            [.image(source: "orbit-attachment:019f491a-fe9e-7e01", alt: "Orbit prototype")])
        // A title after the id lives on `Image.title`, so `source` stays the bare scheme+id.
        XCTAssertEqual(
            parseMarkdownBlocks("![shot](orbit-attachment:abc123 \"shot.png\")"),
            [.image(source: "orbit-attachment:abc123", alt: "shot")])
    }

    func testTextThenImageSplitsIntoParagraphAndImage() {
        // Text and a trailing image with only a soft break between them are ONE CommonMark paragraph;
        // the image must still surface as its own block instead of being folded into the prose.
        XCTAssertEqual(
            parseMarkdownBlocks("Here it is:\n![p](orbit-attachment:xyz)"),
            [.paragraph(text: "Here it is:"), .image(source: "orbit-attachment:xyz", alt: "p")])
    }

    func testRemoteAndInlineImagesStillParse() {
        // A plain http(s) image is an image block too (the view decides how to load it).
        XCTAssertEqual(
            parseMarkdownBlocks("![](https://example.com/a.png)"),
            [.image(source: "https://example.com/a.png", alt: "")])
        // An image mid-sentence splits the prose around it.
        XCTAssertEqual(
            parseMarkdownBlocks("before ![m](orbit-attachment:i) after"),
            [.paragraph(text: "before"),
             .image(source: "orbit-attachment:i", alt: "m"),
             .paragraph(text: "after")])
    }
}
