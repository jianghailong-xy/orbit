import XCTest
@testable import OrbitKit

/// The plain tool-call card reads the call, not its JSON (docs/mocks/tool-call-card); web's
/// `ToolCallBody.test.tsx` pins the same rules.
final class ToolCallPreviewTests: XCTestCase {
    private func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }
    private func make(_ tool: String, _ input: String, translated: String? = nil) -> ToolCallPreview {
        ToolCallPreview.make(toolName: tool, input: json(input),
                             translation: translated.map { ApprovalTranslation(lang: .default, description: $0) })
    }

    func testTheHeadingAsksWhatTheCallDoes() {
        let cases: [(String, String)] = [
            ("Bash", "Run a command?"), ("Edit", "Edit a file?"), ("MultiEdit", "Edit a file?"),
            ("Write", "Write a file?"), ("Read", "Read a file?"), ("NotebookEdit", "Edit a notebook?"),
            ("WebFetch", "Fetch a web page?"), ("WebSearch", "Search the web?"),
            ("Grep", "Search files?"), ("Glob", "Search files?"), ("mcp__x__y", "Approve tool call?"),
        ]
        for (tool, heading) in cases {
            XCTAssertEqual(ToolCallPreview.heading(toolName: tool, input: json("{}")), heading, tool)
        }
        XCTAssertEqual(ToolCallPreview.heading(toolName: "exec_command", input: json(#"{"command":"ls"}"#)),
                       "Run a command?", "any tool with a command runs one")
        XCTAssertEqual(ToolCallPreview.heading(toolName: nil, input: nil), "Approve tool call?")
    }

    func testACommandIsTheCommandWithTheDescriptionOnce() {
        let p = make("Bash", #"{"command":"SELECT 1\nFROM t;","description":"Delivery state"}"#)
        XCTAssertEqual(p.body, .command("SELECT 1\nFROM t;"))
        XCTAssertEqual(p.description, "Delivery state")
        XCTAssertNil(p.originalDescription)
        XCTAssertEqual(p.chips, [])
    }

    func testTheOwnersLanguageLeadsAndTheAgentsWordsFollowInGrey() {
        let p = make("Bash", #"{"command":"npm test","description":"Run the web tests"}"#, translated: "Run them")
        XCTAssertEqual(p.description, "Run them")
        XCTAssertEqual(p.originalDescription, "Run the web tests")

        let same = make("Bash", #"{"command":"npm test","description":"Run the web tests"}"#, translated: "Run the web tests")
        XCTAssertNil(same.originalDescription, "never the description twice")

        let failed = ToolCallPreview.make(toolName: "Bash", input: json(#"{"command":"x","description":"Mine"}"#),
                                          translation: ApprovalTranslation(lang: .default, failed: true, description: "Other"))
        XCTAssertEqual(failed.description, "Mine")
        XCTAssertNil(failed.originalDescription)
    }

    func testTheSettingsThatChangeTheRiskAreChips() {
        let p = make("Bash", #"{"command":"make","timeout":600000,"run_in_background":true,"dangerouslyDisableSandbox":true}"#)
        XCTAssertEqual(p.chips, [.init("timeout 10 min"), .init("runs in background"), .init("sandbox off", warn: true)])
    }

    func testDurations() {
        XCTAssertEqual(ToolCallPreview.duration(ms: 600_000), "10 min")
        XCTAssertEqual(ToolCallPreview.duration(ms: 90_000), "1.5 min")
        XCTAssertEqual(ToolCallPreview.duration(ms: 119_999), "2 min")
        XCTAssertEqual(ToolCallPreview.duration(ms: 30_000), "30 s")
        XCTAssertEqual(ToolCallPreview.duration(ms: 1_500), "2 s")
    }

    func testACommandFoldsAtTwelveLines() {
        let command = (0..<31).map { "echo \($0)" }.joined(separator: "\n")
        let layout = MonospaceOutputLayout(text: command, foldLines: ToolCallPreview.foldLines)
        XCTAssertTrue(layout.transcriptText(expanded: false).contains("echo 11"))
        XCTAssertFalse(layout.transcriptText(expanded: false).contains("echo 12"))
        XCTAssertEqual(layout.hiddenLineCount, 19)
        XCTAssertEqual(MonospaceOutputLayout(text: command).hiddenLineCount, 15, "the transcript keeps its 16")
    }

    func testAnEditIsItsPathAndDiff() {
        let p = make("Edit", #"{"file_path":"/repo/src/a.ts","old_string":"const a = 1;","new_string":"const a = 2;","replace_all":true}"#)
        guard case .edit(let path, let hunks) = p.body else { return XCTFail("\(p.body)") }
        XCTAssertEqual(path, "/repo/src/a.ts")
        XCTAssertEqual(hunks, [[DiffLine(kind: .del, text: "const a = 1;"), DiffLine(kind: .add, text: "const a = 2;")]])
        XCTAssertEqual(p.chips, [.init("Every occurrence")])

        let bare = make("Edit", #"{"file_path":"/repo/a.ts"}"#)
        XCTAssertEqual(bare.body, .edit(path: "/repo/a.ts", hunks: []), "no sides, no empty diff")
        XCTAssertEqual(bare.chips, [])
    }

    func testAMultiEditIsOneDiffPerEdit() {
        let p = make("MultiEdit", #"{"file_path":"/r/a","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}"#)
        guard case .edit(_, let hunks) = p.body else { return XCTFail("\(p.body)") }
        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(p.chips, [.init("2 edits")])
    }

    func testAWriteIsItsPathContentAndLineCount() {
        let p = make("Write", #"{"file_path":"/r/a.txt","content":"one\ntwo\nthree"}"#)
        XCTAssertEqual(p.body, .write(path: "/r/a.txt", content: "one\ntwo\nthree"))
        XCTAssertEqual(p.chips, [.init("3 lines")])
        XCTAssertEqual(make("Write", #"{"file_path":"/r/a","content":"x"}"#).chips, [.init("1 line")])
    }

    func testAReadNamesItsLines() {
        XCTAssertEqual(make("Read", #"{"file_path":"/r/a","offset":240,"limit":160}"#).chips, [.init("lines 240–399")])
        XCTAssertEqual(make("Read", #"{"file_path":"/r/a","limit":50}"#).chips, [.init("lines 1–50")])
        XCTAssertEqual(make("Read", #"{"file_path":"/r/a","offset":40}"#).chips, [.init("from line 40")])
        let plain = make("Read", #"{"file_path":"/r/a"}"#)
        XCTAssertEqual(plain.body, .path("/r/a"))
        XCTAssertEqual(plain.chips, [])
        XCTAssertEqual(make("NotebookEdit", #"{"notebook_path":"/r/n.ipynb"}"#).body, .path("/r/n.ipynb"))
    }

    func testAFetchIsItsURLWithThePromptAsItsLine() {
        let p = make("WebFetch", #"{"url":"https://example.com/notes","prompt":"Summarize the notes"}"#)
        XCTAssertEqual(p.body, .line("https://example.com/notes"))
        XCTAssertEqual(p.description, "Summarize the notes")
        let described = make("WebFetch", #"{"url":"https://e.com","prompt":"P","description":"D"}"#)
        XCTAssertEqual(described.description, "D", "the description wins; the prompt is not a second line")
    }

    func testASearchIsItsQueryOrPattern() {
        XCTAssertEqual(make("WebSearch", #"{"query":"swift 6"}"#).body, .line("swift 6"))
        let grep = make("Grep", #"{"pattern":"TODO","path":"/root/.orbit/worktrees/abc/src","glob":"*.ts"}"#)
        XCTAssertEqual(grep.body, .line("TODO"))
        XCTAssertEqual(grep.chips, [.init("in src"), .init("*.ts")])
    }

    func testAnUnknownToolIsItsFieldsWithTheRawInput() {
        let p = make("mcp__linear__create_issue", #"{"title":"Escaped JSON","priority":2,"labels":["a"],"description":"Why"}"#)
        guard case .fields(let fields, let raw) = p.body else { return XCTFail("\(p.body)") }
        XCTAssertEqual(fields.map(\.key), ["labels", "priority", "title"], "the description is the line above, not a row")
        XCTAssertEqual(fields.first { $0.key == "title" }?.value, "Escaped JSON")
        XCTAssertEqual(fields.first { $0.key == "priority" }?.value, "2")
        XCTAssertEqual(fields.first { $0.key == "labels" }?.block, true)
        XCTAssertTrue(raw.contains("\"title\" : \"Escaped JSON\""))
        XCTAssertEqual(p.description, "Why")
        XCTAssertEqual(ToolCallPreview.showRawInput, "Show raw input")
        XCTAssertEqual(ToolCallPreview.hideRawInput, "Hide raw input")
    }

    /// The SwiftUI card cannot build on Linux, so its wiring is read from the source.
    func testThePlainCardIsDrawnFromThePreview() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var card: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                card = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir = dir.deletingLastPathComponent()
        }
        let source = try XCTUnwrap(card)
        for wire in ["ToolCallPreview.make(toolName: approval.toolName, input: approval.input,",
                     "title: toolCall.heading", "foldLines: ToolCallPreview.foldLines",
                     "ToolCallPreview.showRawInput", "ToolCallPreview.hideRawInput"] {
            XCTAssertTrue(source.contains(wire), "ApprovalCards.swift no longer has \(wire.debugDescription)")
        }
        XCTAssertFalse(source.contains("title: \"Approve tool call\""))
    }
}
