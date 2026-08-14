import XCTest
@testable import OrbitKit

// What a folded run of tool calls says about itself. The row is all the reader gets without a tap,
// so these lock down the wording — and, above all, that the one call it names is the one worth
// naming: whatever is still running, else whatever failed first.
final class ToolGroupSummaryTests: XCTestCase {
    private func card(_ id: String, _ name: String = "Bash", status: ToolStatus = .ok,
                      input: JSONValue = .null) -> ToolCard {
        ToolCard(id: id, name: name, input: input, result: "ok", status: status)
    }

    private func bash(_ id: String, _ description: String, status: ToolStatus = .ok) -> ToolCard {
        card(id, "Bash", status: status,
             input: .object(["command": .string("go build ./..."), "description": .string(description)]))
    }

    func testOneKindOfCallNamesItselfAndSkipsTheBreakdown() {
        let s = ToolGroupSummary.make([card("a"), card("b"), card("c")])

        XCTAssertEqual(s.title, "Bash × 3")
        XCTAssertEqual(s.counts, "3 succeeded")
        XCTAssertNil(s.breakdown)
        XCTAssertNil(s.lead)
        XCTAssertEqual(s.status, .ok)
        XCTAssertEqual(s.tone, .exec)
    }

    func testMixedRunCountsEachKind() {
        let s = ToolGroupSummary.make([
            card("a"), card("b"),
            card("c", "Read"), card("d", "Read"),
            card("e", "Edit"), card("f", "Edit"),
        ])

        XCTAssertEqual(s.title, "Tools × 6")
        XCTAssertEqual(s.breakdown, "Bash × 2 · Read × 2 · Edit × 2")
        XCTAssertEqual(s.tone, .plain)
    }

    // Ties keep first-appearance order: the row must not reshuffle its own breakdown as calls land.
    func testTiedKindsKeepTheOrderTheyFirstAppearedIn() {
        let s = ToolGroupSummary.make([card("a", "Read"), card("b", "Edit"), card("c", "Grep")])

        XCTAssertEqual(s.breakdown, "Read × 1 · Edit × 1 · Grep × 1")
    }

    func testTheOldestCallStillInFlightIsTheOneNamed() {
        let s = ToolGroupSummary.make([
            bash("a", "List capabilities"),
            bash("b", "Build runner", status: .running),
            bash("c", "Run tests", status: .running),
        ])

        XCTAssertEqual(s.counts, "2 running · 1 succeeded")
        XCTAssertEqual(s.lead?.kind, .running)
        XCTAssertEqual(s.lead?.text, "Build runner")
        XCTAssertEqual(s.status, .running)
    }

    // Once nothing is in flight the row turns to the failure — and to the *first* one, which is
    // usually the cause of the ones after it.
    func testOnceSettledTheFirstFailureIsTheOneNamed() {
        let s = ToolGroupSummary.make([
            bash("a", "Generate the client", status: .error),
            bash("b", "Build runner", status: .error),
            bash("c", "Read runner logs"),
        ])

        XCTAssertEqual(s.counts, "2 failed · 1 succeeded")
        XCTAssertEqual(s.lead?.kind, .failed)
        XCTAssertEqual(s.lead?.text, "Generate the client")
        XCTAssertEqual(s.status, .error)
    }

    // A run that is still going says so, even with a failure already in it: what is live is the
    // reader's question, and the count already carries the bad news.
    func testRunningOutranksFailedWhileTheRunIsStillGoing() {
        let s = ToolGroupSummary.make([
            bash("a", "Generate the client", status: .error),
            bash("b", "Build runner", status: .running),
        ])

        XCTAssertEqual(s.lead?.kind, .running)
        XCTAssertEqual(s.lead?.text, "Build runner")
        XCTAssertEqual(s.status, .running)
    }

    // A file tool has no prose to offer, so the row borrows the leaf filename — never the whole path.
    func testAFileCallIsNamedByItsFilename() {
        let s = ToolGroupSummary.make([
            card("a"),
            card("b", "Edit", status: .error, input: .object(["file_path": .string("/root/orbit/src/runner-go/mcp.go")])),
        ])

        XCTAssertEqual(s.lead?.text, "mcp.go")
        XCTAssertEqual(s.lead?.mono, true)
    }
}
