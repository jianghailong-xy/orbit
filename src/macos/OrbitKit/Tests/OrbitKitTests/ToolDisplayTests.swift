import XCTest
@testable import OrbitKit

/// The native console must render each tool the same way as the web transcript: per-tool icon +
/// colour, abbreviated path, line-range badge, and a real diff for edits. These pin the pure
/// name→display mapping so it can't silently drift from web's `describeTool`.
final class ToolDisplayTests: XCTestCase {

    private func obj(_ d: [String: JSONValue]) -> JSONValue { .object(d) }

    // MARK: path / meta

    func testSplitPathAbbreviatesParent() {
        let p = ToolDisplay.splitPath("/root/.orbit/worktrees/abc/src/web/src/index.css")
        XCTAssertEqual(p.base, "index.css")
        XCTAssertEqual(p.dir, "…/src/")            // only the immediate parent, dimmed
    }

    func testSplitPathBareFilename() {
        XCTAssertEqual(ToolDisplay.splitPath("README.md"), PathParts(base: "README.md", dir: ""))
        XCTAssertEqual(ToolDisplay.splitPath("/etc"), PathParts(base: "etc", dir: "/"))
    }

    func testLineMeta() {
        XCTAssertNil(ToolDisplay.lineMeta(offset: nil, limit: nil))
        XCTAssertEqual(ToolDisplay.lineMeta(offset: 240, limit: 160), "L240–400")
        XCTAssertEqual(ToolDisplay.lineMeta(offset: 240, limit: nil), "L240+")
    }

    // MARK: per-tool mapping

    func testReadShowsPathToneAndLineBadge() {
        let d = ToolDisplay.describe(name: "Read",
                                     input: obj(["file_path": .string("/a/b/components/AgentView.tsx"),
                                                 "offset": .int(2170), "limit": .int(90)]),
                                     status: .ok, id: "t1")
        XCTAssertEqual(d.tone, .read)
        XCTAssertEqual(d.symbol, "doc.text")
        XCTAssertEqual(d.path?.base, "AgentView.tsx")
        XCTAssertEqual(d.path?.dir, "…/components/")
        XCTAssertEqual(d.meta, "L2170–2260")
        XCTAssertFalse(d.hasBody)
    }

    func testBashCommandBodyAndProseSummary() {
        let d = ToolDisplay.describe(name: "Bash",
                                     input: obj(["command": .string("grep -rn x src/"),
                                                 "description": .string("Find x")]),
                                     status: .ok, id: "t1")
        XCTAssertEqual(d.tone, .exec)
        XCTAssertEqual(d.summary, "Find x")
        XCTAssertFalse(d.summaryMono)
        XCTAssertEqual(d.body, .command("grep -rn x src/"))
    }

    func testEditProducesDiffWithAddAndDel() {
        let d = ToolDisplay.describe(name: "Edit",
                                     input: obj(["file_path": .string("/a/x.ts"),
                                                 "old_string": .string("let a = 1\nlet b = 2"),
                                                 "new_string": .string("let a = 1\nlet b = 3")]),
                                     status: .ok, id: "t1")
        XCTAssertEqual(d.tone, .write)
        guard case .diff(let hunks) = d.body, let rows = hunks.first else {
            return XCTFail("expected a diff body")
        }
        XCTAssertTrue(rows.contains { $0.kind == .del && $0.text == "let b = 2" })
        XCTAssertTrue(rows.contains { $0.kind == .add && $0.text == "let b = 3" })
        XCTAssertTrue(rows.contains { $0.kind == .ctx && $0.text == "let a = 1" })
    }

    func testGrepJoinsMonoSummary() {
        let d = ToolDisplay.describe(name: "Grep",
                                     input: obj(["pattern": .string("agent-view"), "path": .string("src/web")]),
                                     status: .ok, id: "t1")
        XCTAssertEqual(d.summary, "agent-view  ·  src/web")
        XCTAssertTrue(d.summaryMono)
        XCTAssertNil(d.path)
    }

    // Codex sends no description and wraps the command in `/bin/bash -lc "…"`; without a fallback
    // its rows read as a bare "Bash" while Claude's read as prose.
    func testBashWithoutDescriptionFallsBackToTheUnwrappedCommand() {
        let d = ToolDisplay.describe(name: "Bash",
                                     input: obj(["command": .string("/bin/bash -lc \"orbit task get 'x' --json\"")]),
                                     status: .ok, id: "exec-1")
        XCTAssertEqual(d.summary, "orbit task get 'x' --json")
        XCTAssertTrue(d.summaryMono)
        XCTAssertEqual(d.body, .command("/bin/bash -lc \"orbit task get 'x' --json\""))
    }

    func testBashFallbackKeepsAnUnwrappedCommandOnOneLine() {
        XCTAssertEqual(ToolDisplay.shellCommandSummary("grep -rn x src/\nwc -l"), "grep -rn x src/ wc -l")
        XCTAssertEqual(ToolDisplay.shellCommandSummary("sh -c 'echo hi'"), "echo hi")
        XCTAssertEqual(ToolDisplay.shellCommandSummary("bash script.sh -lc"), "bash script.sh -lc")
    }

    func testShellIdIsTaggedAndAutoOpens() {
        let d = ToolDisplay.describe(name: "Bash",
                                     input: obj(["command": .string("ls -la")]),
                                     status: .ok, id: "shell-abc")
        XCTAssertEqual(d.label, "Shell")
        XCTAssertEqual(d.tone, .exec)
        XCTAssertTrue(d.autoOpen)
        XCTAssertEqual(d.summary, "ls -la")
        XCTAssertEqual(d.body, .command("ls -la"))
    }

    func testBackgroundShellKeepsItsExistingResultOnlyBody() {
        let d = ToolDisplay.describe(name: "Bash",
                                     input: obj(["command": .string("npm test"),
                                                 "run_in_background": .bool(true)]),
                                     status: .running, id: "shell-background")
        XCTAssertEqual(d.summary, "npm test")
        XCTAssertEqual(d.body, .none)
        XCTAssertTrue(d.autoOpen)
    }

    func testTaskRendersPromptAsMarkdown() {
        let d = ToolDisplay.describe(name: "Task",
                                     input: obj(["subagent_type": .string("Explore"),
                                                 "description": .string("map files"),
                                                 "prompt": .string("# Find the thing")]),
                                     status: .running, id: "t1")
        XCTAssertEqual(d.label, "Task · Explore")
        XCTAssertEqual(d.tone, .agent)
        XCTAssertEqual(d.body, .markdown("# Find the thing"))
    }

    func testMcpLabelIsHumanized() {
        // The generic fallback, for every Orbit tool that has not earned a row of its own: the
        // server's own tool name, `mcp__` clipped and `__` read as the separator it is.
        let d = ToolDisplay.describe(name: "mcp__orbit__task_get", input: .null, status: .ok, id: "t1")
        XCTAssertEqual(d.label, "orbit · task_get")
        XCTAssertEqual(d.tone, .plain)
    }

    // A single create is the app's most common write, and it used to fall through to that fallback:
    // an `orbit · task_create` row whose summary was a dump of the call's own JSON. It gets the
    // batch row's treatment one size down — named, and carrying what it was written with.
    func testASingleCreateGetsItsOwnRow() {
        let d = ToolDisplay.describe(name: "mcp__orbit__task_create",
                                     input: obj(["title": .string("Fix login redirect"),
                                                 "description": .string("why")]),
                                     status: .running, id: "t1")
        XCTAssertEqual(d.label, "Create task")
        XCTAssertEqual(d.tone, .agent)
        XCTAssertEqual(d.summary, "Fix login redirect")
        XCTAssertEqual(d.body, .markdown("why"))
        // Folded, unlike the batch: what a reader would otherwise lose — which task this was — is
        // already on the row, and a description is written for the agent that will execute it.
        XCTAssertFalse(d.autoOpen)

        let project = ToolDisplay.describe(name: "mcp__orbit__project_create",
                                           input: obj(["title": .string("Checkout"),
                                                       "goal": .string("one page")]),
                                           status: .running, id: "t2")
        XCTAssertEqual(project.label, "Create project")
        XCTAssertEqual(project.summary, "Checkout")
        XCTAssertEqual(project.body, .markdown("one page"))
    }

    // A failure is the loudest thing a call can do and the least proportionate to unfold: what has
    // the lines is the input, not the reason. It stays folded like any other settled call, with the
    // red glyph on the row carrying the news.
    func testErrorStatusStaysFolded() {
        let d = ToolDisplay.describe(name: "Read",
                                     input: obj(["file_path": .string("/a/x")]),
                                     status: .error, id: "t1")
        XCTAssertFalse(d.autoOpen)
    }

    // ...but a plan, a question and a `!`-shell command still open themselves: each is the point of
    // the turn rather than a step inside it.
    func testPlansAndQuestionsStillAutoOpen() {
        let plan = ToolDisplay.describe(name: "ExitPlanMode",
                                        input: obj(["plan": .string("# Do the thing")]),
                                        status: .error, id: "t1")
        let question = ToolDisplay.describe(name: "AskUserQuestion",
                                            input: obj(["questions": .array([])]),
                                            status: .error, id: "t2")
        XCTAssertTrue(plan.autoOpen)
        XCTAssertTrue(question.autoOpen)
    }

    func testNumberedAssignsGutterLineNumbers() {
        // ctx 'a' → (1,1); del 'b' → (2,nil); add 'B' → (nil,2); ctx 'c' → (3,3)
        let hunk = [
            DiffLine(kind: .ctx, text: "a"),
            DiffLine(kind: .del, text: "b"),
            DiffLine(kind: .add, text: "B"),
            DiffLine(kind: .ctx, text: "c"),
        ]
        let n = ToolDisplay.numbered(hunk)
        XCTAssertEqual(n.map(\.oldNumber), [1, 2, nil, 3])
        XCTAssertEqual(n.map(\.newNumber), [1, nil, 2, 3])
    }

    func testNumberedGapAdvancesBothCounters() {
        let hunk = [
            DiffLine(kind: .ctx, text: "a"),
            DiffLine(kind: .gap, text: "", gapCount: 5),
            DiffLine(kind: .add, text: "z"),
        ]
        let n = ToolDisplay.numbered(hunk)
        XCTAssertNil(n[1].oldNumber)                 // gap shows no number
        XCTAssertEqual(n[2].newNumber, 7)            // 1 ctx + 5 skipped + this add
        XCTAssertEqual(n[2].oldNumber, nil)
    }

    func testCollapseContextInsertsGap() {
        let old = (1...20).map { "line \($0)" }.joined(separator: "\n")
        let new = old + "\nline 21"                 // single change at the end
        let rows = ToolDisplay.collapseCtx(ToolDisplay.lineDiff(old, new), ctx: 3)
        XCTAssertTrue(rows.contains { $0.kind == .gap && $0.gapCount > 0 })
        XCTAssertTrue(rows.contains { $0.kind == .add && $0.text == "line 21" })
    }
}
