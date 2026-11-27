import XCTest
@testable import OrbitKit

/// A `delegate` call's transcript block (docs/subagent-design.md §6.4, board 03): the folded row, its
/// grey second line, the Background mark, and the opened block's Why. Pinning the row model here keeps
/// iOS and macOS drawing the same words as each other and as web's block.
final class SubagentBlockTests: XCTestCase {
    private func obj(_ d: [String: JSONValue]) -> JSONValue { .object(d) }

    private func run(
        type: String = "explore", background: Bool = false, status: String = "DONE",
        level: String? = "S", model: String? = "deepseek-chat", modelLabel: String? = "DeepSeek Chat",
        effort: String? = nil, reasons: [String] = [], costUsd: Double = 0.21, resultSummary: String? = nil,
        createdAt: String = "2026-11-11T08:00:00.000Z", endedAt: String? = "2026-11-11T08:00:41.000Z",
        why: String? = nil, workspaceName: String? = nil, engine: String? = "dsh",
        readonly: Bool? = nil, changedFiles: [String]? = nil, description: String? = nil
    ) -> SubagentRunView {
        SubagentRunView(toolUseId: "toolu_sa", type: type, background: background, status: status,
                        level: level, model: model, modelLabel: modelLabel, effort: effort,
                        reasons: reasons, costUsd: costUsd, resultSummary: resultSummary,
                        createdAt: createdAt, endedAt: endedAt, why: why, workspaceName: workspaceName,
                        description: description, engine: engine, readonly: readonly, changedFiles: changedFiles)
    }

    private let call = JSONValue.object([
        "description": .string("Find every caller of pollQuota"),
        "type": .string("explore"),
        "prompt": .string("Find every caller."),
    ])

    // MARK: - the folded first line

    func testTheFoldedRowNamesTheSubAgentAndItsDescription() {
        let d = ToolDisplay.describe(name: SubagentBlock.toolName, input: call, status: .ok, id: "toolu_sa")
        XCTAssertEqual(d.label, "Agent", "the product calls it an Agent")
        XCTAssertEqual(d.summary, "Find every caller of pollQuota")
        XCTAssertEqual(d.tone, .agent)
        XCTAssertEqual(d.symbol, "sparkle")
        XCTAssertFalse(d.hasBody, "the block opens to the child's steps, not to the delegate prompt")
    }

    // MARK: - the second line: who did the work, and where

    func testTheChipNamesTheEngineAndModelAndTheMetaTheTierAndType() {
        let block = SubagentBlock.describe(input: call, run: run(), status: .ok, parentEngine: "dsh")
        XCTAssertEqual(block.engine, "dsh")
        XCTAssertEqual(block.engineName, "DeepSeek")
        XCTAssertEqual(block.model, "DeepSeek Chat")
        XCTAssertNil(block.fromEngine, "the same engine as the parent: no arrow")
        XCTAssertTrue(block.modelNamesEngine, "DeepSeek Chat already says DeepSeek")
        XCTAssertEqual(block.meta, "S · explore")
        XCTAssertEqual(block.type, "explore")
        XCTAssertFalse(block.background)
        XCTAssertFalse(block.running)
    }

    func testARunOnAnotherEngineThanTheParentsLeadsWithTheParentsAndAnArrow() {
        let block = SubagentBlock.describe(
            input: call, run: run(model: "gpt-6.1-sol", modelLabel: nil, engine: "codex"),
            status: .ok, parentEngine: "claude")
        XCTAssertEqual(block.fromEngine, "Claude")
        XCTAssertEqual(block.engineName, "Codex")
        XCTAssertEqual(block.model, "gpt-6.1-sol", "the id when the table names none")
        XCTAssertFalse(block.modelNamesEngine)
    }

    func testAnUnknownEngineHasNoChipNameAndNoArrow() {
        // A shadow row, or a server before it sent the engine.
        let block = SubagentBlock.describe(input: call, run: run(engine: nil), status: .ok, parentEngine: "claude")
        XCTAssertNil(block.engine)
        XCTAssertNil(block.engineName)
        XCTAssertNil(block.fromEngine)
        XCTAssertEqual(block.model, "DeepSeek Chat")
    }

    func testReadOnlyAndAnotherWorkspaceAreMarked() {
        let block = SubagentBlock.describe(
            input: call, run: run(workspaceName: "orbit-macos", readonly: true, changedFiles: ["x.ts"]), status: .ok)
        XCTAssertTrue(block.readonly)
        XCTAssertEqual(block.workspace, "on orbit-macos")
        XCTAssertEqual(block.changedFiles, [], "a read-only run changed nothing")
        XCTAssertFalse(SubagentBlock.describe(input: call, run: run(), status: .ok).readonly)
    }

    func testTheCallSaysWhatItKnowsBeforeARunIsRead() {
        // The row exists the moment the call does; the run row arrives a beat later.
        let block = SubagentBlock.describe(input: call, run: nil, status: .running, parentEngine: "claude")
        XCTAssertEqual(block.meta, "explore")
        XCTAssertNil(block.engineName)
        XCTAssertNil(block.outcome)
        XCTAssertNil(block.numbers)
        XCTAssertTrue(block.running)
        XCTAssertNil(block.why)
    }

    func testATypeTheCallOmittedDefaultsToGeneral() {
        let block = SubagentBlock.describe(input: .object(["description": .string("Write the spec")]),
                                           run: nil, status: .running)
        XCTAssertEqual(block.type, "general")
        XCTAssertEqual(block.meta, "general")
    }

    func testABackgroundBlockPutsBackgroundInTheTypesPlace() {
        let input = obj(["description": .string("Write the backoff spec"),
                         "type": .string("general"),
                         "background": .bool(true)])
        let block = SubagentBlock.describe(
            input: input,
            run: run(type: "general", background: true, status: "RUNNING", level: "M",
                     model: "gpt-5.6-sol", modelLabel: "GPT-5.6 Sol", endedAt: nil),
            status: .ok)
        XCTAssertTrue(block.background)
        XCTAssertTrue(block.running)
        XCTAssertEqual(block.meta, "M · Background")
        XCTAssertEqual(block.type, "general", "the type is still known; the board draws Background in its place")
    }

    func testTheRunsBackgroundFlagWinsOverTheCallsInput() {
        // A definition file may default is_background: the call's input says nothing, the run says why.
        let block = SubagentBlock.describe(input: call, run: run(background: true), status: .ok)
        XCTAssertTrue(block.background)
        XCTAssertEqual(block.meta, "S · Background")
    }

    // MARK: - the third line: what came of it

    func testAWriterThatEndedCountsTheFilesItChangedWithItsTimeButNoCost() {
        let block = SubagentBlock.describe(
            input: call, run: run(changedFiles: ["a.ts", "b.ts", "c.ts"]), status: .ok, result: "Added backoff.")
        XCTAssertEqual(block.outcome, "3 files changed")
        XCTAssertTrue(block.outcomeIsFiles)
        XCTAssertEqual(block.numbers, "41s", "the run's cost is not shown")
        XCTAssertEqual(block.changedFiles, ["a.ts", "b.ts", "c.ts"])
        let one = SubagentBlock.describe(input: call, run: run(changedFiles: ["a.ts"]), status: .ok)
        XCTAssertEqual(one.outcome, "1 file changed")
    }

    func testARunThatChangedNothingShowsTheFirstLineItHandedBack() {
        let block = SubagentBlock.describe(
            input: call, run: run(readonly: true), status: .ok,
            result: "\n## Three callers, all in quota/\n\n- poller.ts\n- budget.ts")
        XCTAssertEqual(block.outcome, "Three callers, all in quota/")
        XCTAssertFalse(block.outcomeIsFiles)
        XCTAssertFalse(block.outcomeIsFailure)
    }

    func testARunThatDidNotFinishSaysHowItEnded() {
        for (status, word) in [("FAILED", "Failed"), ("INTERRUPTED", "Interrupted"), ("STOPPED", "Stopped")] {
            let block = SubagentBlock.describe(input: call, run: run(status: status, changedFiles: ["a.ts"]),
                                               status: .ok, result: "partial")
            XCTAssertEqual(block.outcome, word)
            // A stop is no failure: grey, not red (board docs/mocks/subagent-card-and-end-line D1).
            XCTAssertEqual(block.outcomeIsFailure, status != "STOPPED")
        }
    }

    func testARunningRunHasNoOutcomeOrNumbersYet() {
        let block = SubagentBlock.describe(input: call, run: run(status: "RUNNING", endedAt: nil), status: .ok,
                                           result: "still going")
        XCTAssertNil(block.outcome)
        XCTAssertNil(block.numbers)
        XCTAssertTrue(block.running)
        XCTAssertNotNil(block.startedAt)
    }

    func testTheRunningLineCountsTimeAndSteps() {
        XCTAssertEqual(SubagentBlock.runningNumbers(elapsed: 72, steps: 9), "1m 12s · 9 steps")
        XCTAssertEqual(SubagentBlock.runningNumbers(elapsed: 5, steps: 1), "5s · 1 step")
        XCTAssertEqual(SubagentBlock.runningNumbers(elapsed: nil, steps: 0), nil)
        let items: [TranscriptItem] = [
            .toolCall(ToolCard(id: "a", name: "Read", input: .object([:]), result: nil, status: .ok, inputSeq: 1)),
            .assistant(AssistantBubble(id: "t", text: "hm", streamingText: "", seq: 2, turnId: nil, ts: nil)),
            .toolCall(ToolCard(id: "b", name: "Edit", input: .object([:]), result: nil, status: .running, inputSeq: 3)),
        ]
        XCTAssertEqual(SubagentBlock.steps(items), 2)
    }

    // MARK: - a group of Agents started together

    func testAGroupAddsUpItsMembers() {
        let runs = [
            run(costUsd: 0.004, engine: "codex"),
            run(costUsd: 0.02),
            run(status: "RUNNING", costUsd: 0, endedAt: nil, workspaceName: "orbit-macos", engine: "claude"),
        ]
        let blocks = runs.map { SubagentBlock.describe(input: call, run: $0, status: .ok, parentEngine: "claude") }
        let group = SubagentGroup.describe(blocks, runs: runs, parentEngine: "claude")
        XCTAssertEqual(group.title, "3 Agents")
        XCTAssertEqual(group.progress, "2 of 3 done")
        XCTAssertEqual(group.engines, "Claude → Codex, DeepSeek", "the parent's own engine is not a move")
        XCTAssertEqual(group.machines, "2 machines")
        XCTAssertEqual([group.done, group.failed, group.running], [2, 0, 1])
    }

    func testAGroupThatEndedSaysAllDoneOrHowManyFailed() {
        let ok = [run(status: "DONE"), run(status: "DONE")]
        let done = SubagentGroup.describe(ok.map { SubagentBlock.describe(input: call, run: $0, status: .ok) },
                                          runs: ok, parentEngine: "dsh")
        XCTAssertEqual(done.progress, "All done")
        XCTAssertNil(done.engines, "all ran on the parent's engine")
        XCTAssertNil(done.machines)
        let mixed = [run(status: "DONE"), run(status: "FAILED")]
        let failed = SubagentGroup.describe(mixed.map { SubagentBlock.describe(input: call, run: $0, status: .ok) },
                                            runs: mixed, parentEngine: "dsh")
        XCTAssertEqual(failed.progress, "1 failed")
    }

    func testAgentsStartedTogetherFoldIntoOneGroupRowAndOneAloneKeepsItsOwn() {
        func delegate(_ id: String) -> TranscriptItem {
            .toolCall(ToolCard(id: id, name: SubagentBlock.toolName, input: call, result: nil, status: .ok,
                               inputSeq: Int(id.dropFirst()) ?? 0))
        }
        var state = TranscriptState()
        state.items = [
            .assistant(AssistantBubble(id: "a1", text: "Splitting this three ways.", streamingText: "", seq: 1,
                                       turnId: nil, ts: nil)),
            delegate("d1"), delegate("d2"), delegate("d3"),
            .assistant(AssistantBubble(id: "a2", text: "Now one more.", streamingText: "", seq: 5,
                                       turnId: nil, ts: nil)),
            delegate("d4"),
        ]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        let kinds: [String] = rows.compactMap {
            switch $0 {
            case .agents(let cards): return "group:" + cards.map(\.id).joined(separator: ",")
            case .item(let item): return item.id
            default: return nil
            }
        }
        XCTAssertEqual(kinds, ["a1", "group:d1,d2,d3", "a2", "d4"])
        XCTAssertEqual(TranscriptRecordAnchor.rowID(containing: "d2", in: rows), "d1",
                       "a member is reached through its group's row")
    }

    // MARK: - the session's Agents

    func testTheSessionSummaryCountsWithoutCostAndListsRunningFirst() throws {
        let runs = [
            run(costUsd: 0.004, createdAt: "2026-11-11T08:00:00.000Z", engine: "codex", description: "Audit"),
            run(costUsd: 0.05, createdAt: "2026-11-11T08:01:00.000Z", description: "Backoff"),
            run(status: "RUNNING", costUsd: 0.02, createdAt: "2026-11-11T07:59:00.000Z", endedAt: nil,
                workspaceName: "orbit-macos", engine: "claude", description: "iOS tests"),
        ]
        let summary = try XCTUnwrap(SubagentSessionSummary.make(runs))
        XCTAssertEqual(summary.count, 3)
        XCTAssertEqual(summary.running, 1)
        XCTAssertEqual(summary.capsule, "3", "the capsule shows no cost")
        XCTAssertEqual(summary.rows.map(\SubagentRunView.description), ["iOS tests", "Backoff", "Audit"])
        XCTAssertNil(SubagentSessionSummary.make([]), "no Agent, no capsule")
        XCTAssertEqual(SubagentSessionSummary.make([run(costUsd: 0)])?.capsule, "1")
    }

    func testTheBandSaysWhatTheRunningAgentIsDoing() throws {
        let deploy = "Deploy dacad7403 to production"
        let done = run(status: "DONE", createdAt: "2026-11-11T08:00:00.000Z", description: deploy)
        let one = run(status: "RUNNING", createdAt: "2026-11-11T08:05:00.000Z", endedAt: nil, description: " \(deploy) ")
        let older = run(status: "RUNNING", createdAt: "2026-11-11T08:01:00.000Z", endedAt: nil, description: "Audit")
        XCTAssertEqual(SubagentSessionSummary.make([done, one])?.band, deploy)
        XCTAssertEqual(SubagentSessionSummary.make([done, older, one])?.band, "2 running · \(deploy)", "the newest running one")
        XCTAssertEqual(SubagentSessionSummary.make([done, run(status: "RUNNING", endedAt: nil)])?.band, "2 · 1 running",
                       "no description keeps the counts")
        let broke = run(status: "FAILED", createdAt: "2026-11-11T07:00:00.000Z", description: "Audit")
        let both = try XCTUnwrap(SubagentSessionSummary.make([broke, one]))
        XCTAssertEqual(both.spoken, "Agents: \(deploy)", "a failure is not counted: the owner can do nothing about it")
        XCTAssertEqual(SubagentSessionSummary.make([done, one])?.current?.description, " \(deploy) ")
    }

    func testTheIdleBandSaysTheCountAlone() throws {
        let older = run(status: "DONE", createdAt: "2026-11-11T07:00:00.000Z", endedAt: "2026-11-11T07:01:00.000Z",
                        description: "Audit")
        let newest = run(status: "DONE", createdAt: "2026-11-11T08:00:00.000Z", endedAt: "2026-11-11T08:00:50.000Z",
                         description: "Deploy dacad7403 to production")
        let idle = try XCTUnwrap(SubagentSessionSummary.make([older, newest]))
        XCTAssertEqual(idle.band, "2", "the newest run's title is on its row, not the band")
        XCTAssertNil(idle.current)

        let failed = run(status: "FAILED", createdAt: "2026-11-11T09:00:00.000Z", endedAt: "2026-11-11T09:04:12.000Z",
                         description: "Run the OrbitKit test suite")
        let red = try XCTUnwrap(SubagentSessionSummary.make([older, newest, failed]))
        XCTAssertEqual(red.band, "3")
        XCTAssertFalse(red.spoken.contains("failed"), "a failure is not counted on the band")
    }

    func testTheBandCountsModelsAndMachines() throws {
        func at(_ place: String?, _ model: String, _ label: String, _ minute: Int) -> SubagentRunView {
            run(model: model, modelLabel: label, createdAt: "2026-11-11T08:0\(minute):00.000Z",
                endedAt: "2026-11-11T08:0\(minute):30.000Z", workspaceName: place, engine: "claude")
        }
        let runs = [at("orbit-op", "deepseek", "DeepSeek V4.1 Flash", 1), at(nil, "opus", "Opus 5.5", 2),
                    at("orbit-prod", "opus", "Opus 5.5", 3), at("orbit-prod", "opus", "Opus 5.5", 4)]
        let s = try XCTUnwrap(SubagentSessionSummary.make(runs, parentEngine: "claude", parentModel: "opus"))
        XCTAssertEqual(s.models, [.init(label: "Opus 5.5", engine: "claude", count: 3),
                                  .init(label: "DeepSeek V4.1 Flash", engine: "claude", count: 1)])
        XCTAssertEqual(s.machines, [.init(name: "orbit-prod", count: 2), .init(name: "orbit-op", count: 1),
                                    .init(name: nil, count: 1)])
        XCTAssertTrue(s.elsewhere)
        XCTAssertTrue(s.spread)
        XCTAssertEqual(s.spoken, "Agents: 4, 3 machines, Opus 5.5 3 runs, DeepSeek V4.1 Flash 1 run")

        let own = try XCTUnwrap(SubagentSessionSummary.make([at(nil, "opus", "Opus 5.5", 1)],
                                                            parentEngine: "claude", parentModel: "opus"))
        XCTAssertFalse(own.spread, "the session's own model on its own machine: nothing to show")
        let haiku = try XCTUnwrap(SubagentSessionSummary.make([at(nil, "haiku", "Haiku 5.5", 1)],
                                                              parentEngine: "claude", parentModel: "opus"))
        XCTAssertTrue(haiku.spread)
        XCTAssertFalse(haiku.elsewhere)
    }

    func testAnOlderServerWithoutTheNewFieldsStillDecodes() throws {
        let json = """
        [{"toolUseId":"t","type":"explore","background":false,"status":"DONE","level":"S","model":"m",
          "modelLabel":null,"effort":null,"reasons":[],"why":null,"removed":[],"costUsd":0,"resultSummary":null,
          "workspaceName":null,"createdAt":"2026-11-11T08:00:00.000Z","endedAt":null}]
        """
        let rows = try JSONDecoder().decode([SubagentRunView].self, from: Data(json.utf8))
        XCTAssertNil(rows[0].engine)
        XCTAssertNil(rows[0].readonly)
        XCTAssertNil(rows[0].changedFiles)
        XCTAssertNil(rows[0].description)
        let new = json.replacingOccurrences(of: "\"endedAt\":null}", with:
            "\"endedAt\":null,\"engine\":\"codex\",\"readonly\":true,\"changedFiles\":[\"a\"],\"description\":\"Audit\"}")
        let current = try JSONDecoder().decode([SubagentRunView].self, from: Data(new.utf8))
        XCTAssertEqual(current[0].engine, "codex")
        XCTAssertEqual(current[0].readonly, true)
        XCTAssertEqual(current[0].changedFiles, ["a"])
        XCTAssertEqual(current[0].description, "Audit")
    }

    // MARK: - Why

    func testTheOpenedBlockWhyJoinsTheRoutersReasons() {
        let block = SubagentBlock.describe(
            input: call,
            run: run(reasons: ["Tier S, set by the built-in explore default",
                               "Optimize For: Cost", "Cheapest of 5 providers with quota"]),
            status: .ok)
        XCTAssertEqual(block.why,
                       "Tier S, set by the built-in explore default · Optimize For: Cost"
                       + " · Cheapest of 5 providers with quota")
    }

    func testAWhyWithNoReasonsIsAbsent() {
        XCTAssertNil(SubagentBlock.describe(input: call, run: run(), status: .ok).why)
    }

    // The server's one-line Why (`SubagentRunView.why`), decoded from GET /sessions/:id/subagents.
    private let reasons = ["Tier S, set by the caller", "Optimize For: Cost",
                           "Cheapest of 29 candidates: gpt-6.1-sol · low on codex, subscription with 84% quota left"]
    private let oneLine = "Tier S, set by the caller · Cost: gpt-6.1-sol · low on codex,"
        + " subscription with 84% quota left · 28 others removed"

    private func decode(_ json: String) throws -> [SubagentRunView] {
        try JSONDecoder().decode([SubagentRunView].self, from: Data(json.utf8))
    }

    func testTheServersWhyIsDecodedAndIsTheWhyLine() throws {
        let rows = try decode(#"""
        [{"toolUseId":"toolu_sa","type":"explore","background":false,"status":"DONE","level":"S",
          "model":"gpt-6.1-sol","modelLabel":null,"effort":"low",
          "reasons":["Tier S, set by the caller","Optimize For: Cost","Cheapest of 29 candidates: gpt-6.1-sol · low on codex, subscription with 84% quota left"],
          "why":"Tier S, set by the caller · Cost: gpt-6.1-sol · low on codex, subscription with 84% quota left · 28 others removed",
          "removed":[{"provider":"claude","engine":"claude","model":"claude-opus-5-5","effort":"high","reason":"Tier S excludes it"},
                     {"provider":"team-codex","engine":"codex","model":null,"effort":null,"reason":"No quota left"}],
          "costUsd":0.03,"resultSummary":null,"workspaceName":null,
          "createdAt":"2026-11-11T08:00:00.000Z","endedAt":"2026-11-11T08:00:41.000Z"}]
        """#)
        let run = try XCTUnwrap(rows.first)
        XCTAssertEqual(run.why, oneLine)
        XCTAssertEqual(run.removed?.count, 2)
        let block = SubagentBlock.describe(input: call, run: run, status: .ok)
        XCTAssertEqual(block.why, oneLine)
        XCTAssertEqual(block.details, reasons + [
            "Removed · claude, claude-opus-5-5 · high: Tier S excludes it",
            "Removed · team-codex (codex): No quota left",
        ])
    }

    func testAnOlderServerWithoutWhyStillDecodesAndFallsBackToTheReasons() throws {
        let rows = try decode(#"""
        [{"toolUseId":"toolu_sa","type":"explore","background":false,"status":"DONE","level":"S",
          "model":"deepseek-chat","modelLabel":"DeepSeek Chat","effort":null,
          "reasons":["Tier S, set by the built-in explore default","Optimize For: Cost"],
          "costUsd":0.03,"resultSummary":null,"createdAt":"2026-11-11T08:00:00.000Z","endedAt":null}]
        """#)
        let run = try XCTUnwrap(rows.first)
        XCTAssertNil(run.why)
        XCTAssertNil(run.removed)
        XCTAssertNil(run.workspaceName)
        let block = SubagentBlock.describe(input: call, run: run, status: .ok)
        XCTAssertEqual(block.why, "Tier S, set by the built-in explore default · Optimize For: Cost")
        XCTAssertEqual(block.details, [], "the reasons are already the Why line: Details has nothing more")
    }

    func testANullWhyFallsBackToTheReasons() {
        let block = SubagentBlock.describe(input: call, run: run(reasons: reasons), status: .ok)
        XCTAssertEqual(block.why, reasons.joined(separator: " · "))
        XCTAssertEqual(block.details, [])
    }

    func testARunOnAnotherWorkspaceLeadsWithHowItWasChosen() {
        let chosen = "Workspace orbit-macos, named by the caller"
        let block = SubagentBlock.describe(
            input: call, run: run(reasons: [chosen] + reasons, why: oneLine, workspaceName: "orbit-macos"), status: .ok)
        XCTAssertEqual(block.why, chosen + " · " + oneLine)
        XCTAssertEqual(block.details, [chosen] + reasons)
    }

    // MARK: - the result

    func testAForegroundResultCarriesTheSubAgentsText() {
        let result = #"{"runId":"sa_1","status":"DONE","result":"Three callers, all in quota/.","costUsd":0.21}"#
        XCTAssertEqual(SubagentResult.text(callResult: result, run: run()),
                       "Three callers, all in quota/.")
    }

    func testABackgroundReceiptIsHiddenUntilTheRunHasAResult() {
        let receipt = #"{"runId":"sa_2","status":"running"}"#
        XCTAssertNil(SubagentResult.text(callResult: receipt, run: run(background: true,
                                                                       status: "RUNNING", endedAt: nil)))
        XCTAssertEqual(SubagentResult.text(callResult: receipt,
                                           run: run(background: true, resultSummary: "The spec is written.")),
                       "The spec is written.")
    }

    /// The server clips a long result to a 2 KB preview: the runner's pretty JSON no longer parses,
    /// and its first line is a lone `{`. The block reads the run's own text instead.
    func testAClippedResultReadsTheRunNotTheBrace() {
        let clipped = "{\n  \"changedFiles\": [],\n  \"costUsd\": 0.21,\n  \"result\": \"Route 1 worked: the transcript is"
        let handedBack = "Route 1 worked: the transcript is at x.jsonl.\nMore."
        let text = SubagentResult.text(callResult: clipped, run: run(resultSummary: handedBack))
        XCTAssertEqual(text, handedBack)
        XCTAssertEqual(SubagentBlock.describe(input: call, run: run(resultSummary: handedBack, readonly: true),
                                              status: .ok, result: text).outcome,
                       "Route 1 worked: the transcript is at x.jsonl.")
        // Before the run is read there is nothing to say yet, which is better than `{`.
        XCTAssertNil(SubagentResult.text(callResult: clipped, run: nil))
    }

    func testAHandBackThatIsJSONSkipsItsBrackets() {
        let block = SubagentBlock.describe(
            input: call, run: run(readonly: true), status: .ok,
            result: "```json\n{\n  \"route\": \"transcript file\"\n}\n```")
        XCTAssertEqual(block.outcome, #""route": "transcript file""#)
    }

    func testPlainTextIsShownAsItCame() {
        XCTAssertEqual(SubagentResult.text(callResult: "not json", run: nil), "not json")
        XCTAssertNil(SubagentResult.text(callResult: "  ", run: nil))
    }

    // MARK: - re-reading the runs

    func testTheSignatureMovesWhenADelegateCallStartsOrEnds() {
        func card(_ status: ToolStatus, resultSeq: Int?) -> TranscriptItem {
            .toolCall(ToolCard(id: "toolu_sa", name: SubagentBlock.toolName,
                               input: .object([:]), result: nil, status: status,
                               inputSeq: 1, resultSeq: resultSeq))
        }
        let started = SubagentRuns.signature(items: [card(.running, resultSeq: nil)], background: [])
        XCTAssertEqual(started, "toolu_sa:running:-")
        let ended = SubagentRuns.signature(items: [card(.ok, resultSeq: 9)], background: [])
        XCTAssertNotEqual(started, ended)
        XCTAssertEqual(SubagentRuns.signature(items: [], background: []), "",
                       "a session that never delegated reads nothing")
    }

    // MARK: - nesting

    func testADelegateCallIsItsOwnRowNotFoldedIntoAStepsLine() {
        // A steps line stands in for calls with nothing of their own to draw; a SubAgent's block
        // carries its steps and Why, so it is drawn where it happened (web: isGroupableTool).
        var state = TranscriptState()
        state.items = [
            .assistant(AssistantBubble(id: "a1", text: "I'll split this.", streamingText: "",
                                       seq: 2, turnId: nil, ts: nil)),
            .toolCall(ToolCard(id: "toolu_sa", name: SubagentBlock.toolName, input: .object([:]),
                               result: nil, status: .running, inputSeq: 3)),
        ]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false)
        XCTAssertFalse(rows.contains { if case .steps = $0 { return true }; return false }, "\(rows)")
        XCTAssertTrue(rows.contains {
            if case .item(.toolCall(let card)) = $0 { return card.id == "toolu_sa" }
            return false
        }, "\(rows)")
    }

    func testADelegatesStepsNestUnderItsCallLikeAnAgentCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .toolUse, ts: "2026-11-11T08:00:00.000Z", turnId: "t1",
                         payload: .object(["id": .string("toolu_sa"),
                                           "name": .string(SubagentBlock.toolName),
                                           "input": .object(["description": .string("Find callers")])])))
        r.apply(RunEvent(seq: 2, type: .toolResult, ts: "2026-11-11T08:00:01.000Z", turnId: "t1",
                         payload: .object(["toolUseId": .string("toolu_sa"),
                                           "content": .string(#"{"runId":"sa_1","status":"DONE","result":"ok"}"#)])))
        r.apply(RunEvent(seq: 3, type: .toolUse, ts: "2026-11-11T08:00:02.000Z", turnId: nil,
                         payload: .object(["id": .string("toolu_child"), "name": .string("Grep"),
                                           "input": .object(["pattern": .string("pollQuota")]),
                                           "parentToolUseId": .string("toolu_sa")])))
        r.apply(RunEvent(seq: 4, type: .assistant, ts: "2026-11-11T08:00:03.000Z", turnId: nil,
                         payload: .object(["text": .string("Three callers, all in quota/."),
                                           "parentToolUseId": .string("toolu_sa")])))

        XCTAssertEqual(r.state.items.count, 1, "the conversation is the parent's own call")
        let sub = r.state.subagentItems["toolu_sa"] ?? []
        XCTAssertEqual(sub.count, 2, "\(sub)")
        guard case .toolCall(let grep) = sub[0], case .assistant(let words) = sub[1] else {
            return XCTFail("sub = \(sub)")
        }
        XCTAssertEqual(grep.name, "Grep")
        XCTAssertEqual(words.text, "Three callers, all in quota/.")
    }

    func testTheSheetNamesAModelWithoutItsBuildNumber() {
        XCTAssertEqual(SubagentSessionSummary.sheetModelLabel(run(modelLabel: "DeepSeek V4.1 Flash 1017")),
                       "DeepSeek V4.1 Flash")
        XCTAssertEqual(SubagentSessionSummary.sheetModelLabel(run(modelLabel: "Kimi K3")), "Kimi K3")
        XCTAssertEqual(SubagentSessionSummary.sheetModelLabel(run(modelLabel: "Opus 5.5")), "Opus 5.5")
        XCTAssertEqual(SubagentSessionSummary.sheetModelLabel(run(modelLabel: "GPT-6.2-Sol")), "GPT-6.2-Sol")
        XCTAssertEqual(SubagentSessionSummary.sheetModelLabel(run(modelLabel: "Qwen 235")), "Qwen 235")
    }
}
