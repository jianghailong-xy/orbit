import XCTest
@testable import OrbitKit

// What a steps line says. The line is all the reader gets without a tap, so these lock down the
// wording, which is web's `stepsSummary` word for word, and what is drawn under it while a call runs.
final class StepsSummaryTests: XCTestCase {
    private func call(_ id: String, _ name: String = "Bash", status: ToolStatus = .ok,
                      _ input: [String: JSONValue] = [:]) -> TranscriptItem {
        .toolCall(ToolCard(id: id, name: name, input: .object(input), result: status == .running ? nil : "ok",
                           status: status))
    }

    private func bash(_ id: String, _ command: String, _ description: String? = nil,
                      status: ToolStatus = .ok) -> TranscriptItem {
        var input: [String: JSONValue] = ["command": .string(command)]
        if let description { input["description"] = .string(description) }
        return call(id, "Bash", status: status, input)
    }

    private func thinking(_ id: String, ms: Int?) -> TranscriptItem {
        .thinking(ThinkingBlock(id: id, text: "why", streamingText: "", seq: 1, thinkingMs: ms))
    }

    func testThinkingFirstThenEachKindInTheOrderItCame() {
        let s = StepsSummary.make([
            thinking("k1", ms: 15_000),
            bash("a", "ls /root/orbit/deploy"),
            bash("b", "docker compose ps"),
            bash("c", "git status"),
        ])

        XCTAssertEqual(s.line, "Thought for 15s, listed 1 directory, ran 2 shell commands")
        XCTAssertEqual(s.failed, 0)
        XCTAssertEqual(s.live, [])
    }

    func testThinkingAcrossBlocksIsSummedAndUntimedThinkingStillSaysSo() {
        XCTAssertEqual(StepsSummary.sentence([thinking("k1", ms: 20_000), bash("a", "pwd"), thinking("k2", ms: 50_000)]),
                       "Thought for 1m 10s, ran 1 shell command")
        XCTAssertEqual(StepsSummary.sentence([thinking("k1", ms: nil)]), "Thought")
    }

    func testAWrappedShellIsReadThroughToItsCommand() {
        XCTAssertEqual(StepsSummary.sentence([bash("a", "/bin/bash -lc \"find . -name x\"")]), "Listed 1 directory")
    }

    func testFilesAreCountedNotCallsForReadsAndEdits() {
        let s = StepsSummary.sentence([
            call("r", "Read", ["file_path": .string("/w/a.ts")]),
            call("e1", "Edit", ["file_path": .string("/w/a.ts")]),
            call("e2", "Edit", ["file_path": .string("/w/a.ts")]),
            call("e3", "MultiEdit", ["file_path": .string("/w/b.ts")]),
            call("g", "Grep", ["pattern": .string("x")]),
        ])

        XCTAssertEqual(s, "Read 1 file, edited 2 files, searched 1 time")
    }

    func testEveryOtherKindHasItsOwnWords() {
        let s = StepsSummary.sentence([
            call("w", "Write", ["file_path": .string("/w/new.ts")]),
            call("f", "WebFetch", ["url": .string("https://example.com")]),
            call("s", "WebSearch", ["query": .string("x")]),
            call("t", "TodoWrite"),
            call("m1", "mcp__orbit__task_get"),
            call("m2", "ToolSearch"),
        ])

        XCTAssertEqual(s, "Wrote 1 file, fetched 1 page, searched the web 1 time, updated the plan, used 2 tools")
    }

    func testAFailureIsCountedNotNamed() {
        let s = StepsSummary.make([bash("a", "go build ./...", status: .error), bash("b", "git status")])

        XCTAssertEqual(s.line, "Ran 2 shell commands")
        XCTAssertEqual(s.failed, 1)
    }

    // A call in flight is drawn under the line by what it is doing, with the command beneath when
    // the call said what it does; once it answers, it is one more word in the sentence.
    func testACallInFlightIsDrawnUnderTheLineUntilItAnswers() {
        let running = StepsSummary.make([
            thinking("k1", ms: 18_000),
            bash("a", "grep -rn url prisma/schema.prisma", "Show prisma datasource config", status: .running),
        ])
        XCTAssertEqual(running.line, "Thought for 18s")
        XCTAssertEqual(running.live, [StepsSummary.Live(id: "a", text: "Show prisma datasource config", mono: false,
                                                        command: "grep -rn url prisma/schema.prisma")])

        let settled = StepsSummary.make([
            thinking("k1", ms: 18_000),
            bash("a", "grep -rn url prisma/schema.prisma", "Show prisma datasource config"),
        ])
        XCTAssertEqual(settled.line, "Thought for 18s, ran 1 shell command")
        XCTAssertEqual(settled.live, [])
    }

    func testACallInFlightWithNoDescriptionIsItsCommandAlone() {
        let s = StepsSummary.make([bash("a", "go build ./...", status: .running)])

        XCTAssertEqual(s.line, "")
        XCTAssertEqual(s.live, [StepsSummary.Live(id: "a", text: "go build ./...", mono: true, command: nil)])
    }

    func testAFileCallInFlightIsNamedByItsFile() {
        let s = StepsSummary.make([call("r", "Read", status: .running, ["file_path": .string("/w/src/app.ts")])])

        XCTAssertEqual(s.live.map(\.text), ["app.ts"])
    }
}
