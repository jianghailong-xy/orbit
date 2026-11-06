import XCTest
@testable import OrbitKit

/// `SessionLine.plainPreview`, the reply flattened into the list row's one line. The same inputs as
/// the web `src/web/src/lib/plainPreview.test.ts`, so both lists read a reply alike.
final class SessionLinePlainPreviewTests: XCTestCase {
    private func preview(_ md: String) -> String { SessionLine.plainPreview(md) }

    func testOrbitReferenceKeepsItsNameAndDropsItsTarget() {
        let line = preview("Filed [runner + web：配额按账户归属](orbit-task:34TcwQ8x2kLmNpRsTuVwX) for the quota split.")
        XCTAssertEqual(line, "Filed runner + web：配额按账户归属 for the quota split.")
        XCTAssertFalse(line.contains("]("))
    }

    func testOrdinaryLinkKeepsItsTextAndDropsItsURL() {
        let line = preview("See [the migration guide](https://example.com/docs/migrate?from=6#steps) before upgrading.")
        XCTAssertEqual(line, "See the migration guide before upgrading.")
        XCTAssertFalse(line.contains("]("))
    }

    func testEveryLinkInAMultiLineReplyIsFlattenedListItemsIncluded() {
        let md = [
            "Done:",
            "- [Fix login redirect](orbit-task:34TqaiYd61qX2pspp4su0) landed",
            "- CI: [run 123](https://github.com/o/r/actions/runs/123)",
        ].joined(separator: "\n")
        XCTAssertEqual(preview(md), "Done: Fix login redirect landed CI: run 123")
    }

    func testInlineCodeInsideALinksTextIsUnwrapped() {
        XCTAssertEqual(preview("Moved it to [`plainPreview.ts`](src/web/src/lib/plainPreview.ts)."),
                       "Moved it to plainPreview.ts.")
    }

    func testImageReadsAsItsAltTextALinkedOneIncluded() {
        XCTAssertEqual(preview("![CI run](https://example.com/shot.png) is green"), "CI run is green")
        XCTAssertEqual(preview("[![badge](https://example.com/b.svg)](https://example.com/ci) passing"), "badge passing")
        XCTAssertEqual(preview("![](orbit-attachment:abc) done"), "done")
    }

    func testBracketsInsideCodeAreLeftAlone() {
        XCTAssertEqual(preview("Call `render[0](x)` and read `xs[i]`."), "Call render[0](x) and read xs[i].")
        XCTAssertEqual(preview("`[x](y)` is not a link, [z](https://example.com/z) is"),
                       "[x](y) is not a link, z is")
        XCTAssertEqual(preview("```ts\nconst a = [x](y);\n```\nThen [ship it](https://example.com)."), "Then ship it.")
    }

    func testTheRestFlattensAsBefore() {
        XCTAssertEqual(preview("## Heading\n> quoted\n- **bold** and _em_ item"), "Heading quoted bold and em item")
        XCTAssertEqual(preview("- [x] done, [y] (not a link)"), "[x] done, [y] (not a link)")
        XCTAssertEqual(preview("run `npm test`\n\n  twice"), "run npm test twice")
    }

    func testWhatIsNotAMarkStays() {
        // The message whose row read `teauserprofilebuildcnch` under a bubble that said this.
        for md in ["把其他的 tea_user_profile_build_*_cnch 也修复了",
                   "file_path and snake_case_name",
                   "看_重点_吧",
                   "~/.orbit/bin takes ~30 minutes",
                   "2 * 3 * 4",
                   "foo* and bar*",
                   "** BUILD SUCCEEDED **",
                   "*.ts files",
                   "*_cnch too",
                   "--force is needed",
                   "-1 is wrong",
                   "#123 is broken",
                   "_private and __dunder"] {
            XCTAssertEqual(preview(md), md)
        }
    }

    func testARealMarkGoes() {
        XCTAssertEqual(preview("**bold**, *italic* and ***both***"), "bold, italic and both")
        XCTAssertEqual(preview("_em_, __strong__ and ___both___"), "em, strong and both")
        XCTAssertEqual(preview("~~gone~~ stays"), "gone stays")
        XCTAssertEqual(preview("这是**重点**内容"), "这是重点内容")
        XCTAssertEqual(preview("**a *b* c** and *d **e** f*"), "a b c and d e f")
        XCTAssertEqual(preview("**a*b**"), "a*b")
        XCTAssertEqual(preview("_foo_bar_"), "foo_bar")
        // Two globs in one message: Markdown reads their marks as emphasis, and the bubble draws it so.
        XCTAssertEqual(preview("把 tea_*_cnch 和 foo_*_bar 都修了"), "把 tea_cnch 和 foo_bar 都修了")
        XCTAssertEqual(preview("**run `npm test` now**"), "run npm test now")
        XCTAssertEqual(preview("above\n\n---\n***\n___\n- - -\n\nbelow"), "above below")
        XCTAssertEqual(preview("> - ## nested\n* item"), "nested item")
    }

    func testEveryMarkInsideCodeStays() {
        XCTAssertEqual(preview("`a*b*c` and `_x_` and `~~y~~`"), "a*b*c and _x_ and ~~y~~")
        XCTAssertEqual(preview("(v1-beta.*), and no `android-v*` tags"), "(v1-beta.*), and no android-v* tags")
        XCTAssertEqual(preview("`- x` and `#1` start this"), "- x and #1 start this")
        XCTAssertEqual(preview("see `tea_*_cnch` and `foo_*_bar`"), "see tea_*_cnch and foo_*_bar")
        XCTAssertEqual(preview("``a_b_c`` and ``d`e`` and `f`"), "a_b_c and d`e and f")
        XCTAssertEqual(preview("one `` tick pair stays"), "one `` tick pair stays")
    }

    /// The row itself, not just the helper: a reply and a message of yours still waiting for one
    /// both come out as link text.
    func testTheListRowShowsLinkText() {
        func session(lastAssistantText: String? = nil, lastUserText: String? = nil) -> Session {
            Session(id: "s", title: "t", status: .awaitingInput, agentId: nil, assignedRunnerId: nil,
                    pendingApprovals: nil, branch: nil, updatedAt: nil,
                    lastAssistantText: lastAssistantText, lastToolUse: nil, lastUserText: lastUserText,
                    runningBgCount: nil, engineTurnActive: nil, endReason: nil)
        }
        let reply = session(lastAssistantText: "Filed [Fix login redirect](orbit-task:34TqaiYd61qX2pspp4su0).")
        XCTAssertEqual(SessionLine.make(for: reply, live: true), .init(text: "Filed Fix login redirect.", tone: .preview))

        let sent = session(lastUserText: "Look at [this run](https://github.com/o/r/actions/runs/123)")
        XCTAssertEqual(SessionLine.make(for: sent, live: true), .init(text: "You: Look at this run", tone: .preview))

        let words = session(lastUserText: "把其他的 tea_user_profile_build_*_cnch 也修复了")
        XCTAssertEqual(SessionLine.make(for: words, live: true),
                       .init(text: "You: 把其他的 tea_user_profile_build_*_cnch 也修复了", tone: .preview))
    }
}
