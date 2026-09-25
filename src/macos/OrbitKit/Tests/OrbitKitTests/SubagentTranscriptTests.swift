import XCTest
@testable import OrbitKit

/// What a session running background sub-agents and workflows folds into. Every receipt and
/// notification below is Claude Code's own wording (claude 2.1.282), copied from a production
/// session whose iPhone transcript drew 559 of its 630 rows from its sub-agents, interleaved with
/// the workspace's own replies, and whose tray said "6 total" with nothing running while a
/// resumed workflow worked for twenty minutes.
final class SubagentTranscriptTests: XCTestCase {
    private func ev(_ seq: Int, _ type: RunEventType, _ payload: [String: JSONValue],
                    turnId: String? = nil) -> RunEvent {
        RunEvent(seq: seq, type: type, ts: "2026-09-25T08:00:\(String(format: "%02d", seq % 60)).000Z",
                 turnId: turnId, payload: .object(payload))
    }

    private let agentAck = "Async agent launched successfully. (This tool result is internal metadata — never quote"
        + " or paste any part of it, including the agentId below, into a user-facing reply.) agentId: a05fc3596d22b3d3e"
    private let workflowReceipt = "Workflow launched in background. Task ID: w2f3yv1s8\n"
        + "Summary: 3 competing designs; 2 judges\nTranscript dir: /root/.claude/projects/x/subagents/workflows/wf_37d"

    /// An async Agent call, its receipt, and what the agent it started did.
    private func agentSession() -> [RunEvent] {
        [
            ev(1, .toolUse, ["id": .string("toolu_agent"), "name": .string("Agent"),
                             "input": .object(["description": .string("Deep-read wikova"),
                                               "run_in_background": .bool(true)])], turnId: "t1"),
            ev(2, .toolResult, ["toolUseId": .string("toolu_agent"),
                                "content": .array([.object(["type": .string("text"), "text": .string(agentAck)])])],
               turnId: "t1"),
            ev(3, .assistant, ["text": .string("Both are running; I will merge the results.")], turnId: "t1"),
            ev(4, .turnEnd, ["subtype": .string("success")], turnId: "t1"),
            // The sub-agent, after the turn: its own call, result, words — and an agent IT started.
            ev(5, .toolUse, ["id": .string("toolu_sub_bash"), "name": .string("Bash"),
                             "input": .object(["command": .string("ls ~/wikova")]),
                             "parentToolUseId": .string("toolu_agent")]),
            ev(6, .toolResult, ["toolUseId": .string("toolu_sub_bash"), "content": .string("apiserver\nworker"),
                                "parentToolUseId": .string("toolu_agent")]),
            ev(7, .assistant, ["text": .string("Now the enqueue side."), "parentToolUseId": .string("toolu_agent")]),
            ev(8, .toolUse, ["id": .string("toolu_nested"), "name": .string("Agent"),
                             "input": .object(["description": .string("Crawler architecture research")]),
                             "parentToolUseId": .string("toolu_agent")]),
            ev(9, .toolUse, ["id": .string("toolu_grandchild"), "name": .string("Grep"),
                             "input": .object(["pattern": .string("crawler")]),
                             "parentToolUseId": .string("toolu_nested")]),
            ev(10, .assistant, ["text": .string("API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}"),
                                "parentToolUseId": .string("toolu_agent")]),
            // The nested agent's own receipt. Its end goes to the sub-agent that started it.
            ev(11, .toolResult, ["toolUseId": .string("toolu_nested"),
                                 "content": .string(agentAck.replacingOccurrences(of: "a05fc3596d22b3d3e", with: "a286710e930e01d6b")),
                                 "parentToolUseId": .string("toolu_agent")]),
        ]
    }

    func testASubagentsWorkNestsUnderTheCallThatStartedItAndLeavesTheConversationAlone() {
        var r = TranscriptReducer()
        for e in agentSession() { r.apply(e) }

        // The conversation is the workspace's own: its call, and its reply.
        XCTAssertEqual(r.state.items.count, 2, "\(r.state.items)")
        guard case .toolCall(let call) = r.state.items[0], case .assistant(let reply) = r.state.items[1] else {
            return XCTFail("items = \(r.state.items)")
        }
        XCTAssertEqual(call.id, "toolu_agent")
        XCTAssertEqual(reply.text, "Both are running; I will merge the results.")

        let sub = r.state.subagentItems["toolu_agent"] ?? []
        XCTAssertEqual(sub.count, 4, "\(sub)")
        guard case .toolCall(let bash) = sub[0], case .assistant(let words) = sub[1],
              case .toolCall(let nested) = sub[2], case .error(_, let failure) = sub[3] else {
            return XCTFail("sub = \(sub)")
        }
        XCTAssertEqual(bash.status, .ok, "its result closed it inside the nested list")
        XCTAssertEqual(bash.result, "apiserver\nworker")
        XCTAssertEqual(words.text, "Now the enqueue side.")
        XCTAssertEqual(nested.id, "toolu_nested")
        XCTAssertTrue(failure.hasPrefix("API Error: 529"), "a sub-agent's provider error is part of its report")
        // Not a retry card addressed to the reader in the conversation.
        XCTAssertFalse(r.state.items.contains { if case .autoRetry = $0 { return true }; return false })

        // What the nested agent started nests one level further down.
        XCTAssertEqual((r.state.subagentItems["toolu_nested"] ?? []).count, 1)
        // Only what the workspace itself started is in the tray: the nested agent's end is reported
        // to the sub-agent, never to this stream, and a row for it would read "running" for good.
        XCTAssertEqual(r.state.background.map(\.id), ["toolu_agent"])
    }

    func testTheTrayListsAnAgentAndAWorkflowFromTheirReceiptsAsRunning() {
        var r = TranscriptReducer()
        for e in agentSession().prefix(2) { r.apply(e) }
        r.apply(ev(20, .toolUse, ["id": .string("toolu_wf"), "name": .string("Workflow"),
                                  "input": .object(["resumeFromRunId": .string("wf_37d4e19e-c97")])], turnId: "t2"))
        r.apply(ev(21, .toolResult, ["toolUseId": .string("toolu_wf"), "content": .string(workflowReceipt)], turnId: "t2"))

        XCTAssertEqual(r.state.background.map(\.id), ["toolu_agent", "toolu_wf"])
        XCTAssertEqual(r.state.background.map(\.status), ["running", "running"])
        XCTAssertEqual(r.state.background.map(\.kind), ["agent", "workflow"])
        XCTAssertEqual(r.state.background.map(\.description), ["Deep-read wikova", "3 competing designs; 2 judges"])
        XCTAssertEqual(r.state.background.map(\.taskId), ["a05fc3596d22b3d3e", "w2f3yv1s8"])
    }

    /// An Agent run inline answers in its result: nothing of it is left running.
    func testAnInlineAgentPutsNothingInTheTray() {
        var r = TranscriptReducer()
        r.apply(ev(1, .toolUse, ["id": .string("toolu_inline"), "name": .string("Agent"),
                                 "input": .object(["description": .string("Quick lookup")])]))
        r.apply(ev(2, .toolResult, ["toolUseId": .string("toolu_inline"),
                                    "content": .string("Here is my research report.")]))

        XCTAssertEqual(r.state.background, [])
    }

    /// An agent resumed with SendMessage stops again and is announced without its call's id. Keyed on
    /// the empty string, that made a sixth row with no name.
    func testACompletionNamingOnlyTheTaskIdSettlesTheRowItBelongsTo() {
        var r = TranscriptReducer()
        for e in agentSession().prefix(2) { r.apply(e) }
        r.apply(ev(30, .backgroundTask, ["status": .string("completed"), "shellId": .string("a05fc3596d22b3d3e"),
                                         "toolUseId": .string("toolu_agent"),
                                         "summary": .string("Agent \"Deep-read wikova\" finished")]))
        r.apply(ev(31, .backgroundTask, ["status": .string("completed"), "shellId": .string("a05fc3596d22b3d3e"),
                                         "toolUseId": .string(""),
                                         "summary": .string("Agent \"Deep-read wikova\" finished")]))

        XCTAssertEqual(r.state.background.count, 1, "\(r.state.background)")
        XCTAssertEqual(r.state.background.first?.status, "completed")
    }

    /// A row whose launch is outside the loaded window is still named — by its notification.
    func testARowKnownOnlyFromItsEndIsNamedByItsSummary() {
        var r = TranscriptReducer()
        r.apply(ev(40, .backgroundTask, ["status": .string("completed"), "shellId": .string("wjny6s07w"),
                                         "toolUseId": .string("toolu_old_wf"),
                                         "summary": .string("Dynamic workflow \"Review the idea: two designs, red-team verify\" completed")]))

        XCTAssertEqual(r.state.background.first?.description, "Review the idea: two designs, red-team verify")
        XCTAssertEqual(r.state.background.first?.kind, "workflow")
    }

    private func progressPayload(state: String, tokens: Int) -> [String: JSONValue] {
        ["toolUseId": .string("toolu_wf"), "taskId": .string("w2f3yv1s8"), "taskType": .string("local_workflow"),
         "usage": .object(["totalTokens": .int(tokens), "toolUses": .int(63), "durationMs": .int(780000)]),
         "phases": .array([.object(["index": .int(1), "title": .string("Design")])]),
         "agents": .array([.object(["index": .int(4), "label": .string("design:page-wiki"), "phaseIndex": .int(1),
                                    "state": .string(state), "tokens": .int(412000), "toolCalls": .int(34)])])]
    }

    func testProgressIsLiveAndTheEndKeepsTheLastWord() {
        var r = TranscriptReducer()
        r.apply(ev(20, .toolUse, ["id": .string("toolu_wf"), "name": .string("Workflow"), "input": .object([:])]))
        r.apply(ev(21, .toolResult, ["toolUseId": .string("toolu_wf"), "content": .string(workflowReceipt)]))
        r.apply(RunEvent(seq: 22, type: .taskProgress, payload: .object(progressPayload(state: "running", tokens: 100))))

        XCTAssertEqual(r.state.taskProgress["toolu_wf"]?.agents.first?.state, "running")
        XCTAssertEqual(r.state.taskProgress["toolu_wf"]?.usage?.totalTokens, 100)
        XCTAssertTrue(r.state.taskProgress["toolu_wf"]?.isWorkflow == true)

        var end = ["status": JSONValue.string("completed"), "shellId": .string("w2f3yv1s8"),
                   "toolUseId": .string("toolu_wf"), "summary": .string("Dynamic workflow \"x\" completed")]
        end["progress"] = .object(progressPayload(state: "done", tokens: 792000))
        r.apply(ev(30, .backgroundTask, end))
        XCTAssertEqual(r.state.taskProgress["toolu_wf"]?.agents.first?.state, "done")

        // A frame buffered before a reconnect, delivered after the end, does not reopen it…
        r.apply(RunEvent(seq: 23, type: .taskProgress, payload: .object(progressPayload(state: "running", tokens: 200))))
        XCTAssertEqual(r.state.taskProgress["toolu_wf"]?.usage?.totalTokens, 792000)
        // …and a re-delivered end with nothing attached keeps the last word it had.
        r.apply(ev(31, .backgroundTask, ["status": .string("completed"), "shellId": .string("w2f3yv1s8"),
                                         "toolUseId": .string("toolu_wf")]))
        XCTAssertEqual(r.state.taskProgress["toolu_wf"]?.agents.first?.state, "done")
        // Live frames are animation: they never advance the persisted cursor.
        XCTAssertEqual(r.state.maxSeq, 31)
    }

    func testAnOlderPageGraftsASubagentsEarlierWorkInFrontOfItsLaterWork() {
        let all = agentSession()
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: Array(all[6...]), hasMore: true))   // from seq 7 on
        XCTAssertEqual((r.state.subagentItems["toolu_agent"] ?? []).count, 3)

        r.prependOlder(EventPage(events: Array(all[..<6]), hasMore: false))    // seqs 1…6

        let sub = r.state.subagentItems["toolu_agent"] ?? []
        XCTAssertEqual(sub.count, 4)
        guard case .toolCall(let first) = sub[0] else { return XCTFail("\(sub)") }
        XCTAssertEqual(first.id, "toolu_sub_bash", "the older part goes first")
        XCTAssertEqual(first.status, .ok)
    }

    /// Trimming the window cuts a sub-agent's work at the same seq it cuts the conversation, not
    /// with its call: a background agent works on long after it.
    func testTrimmingCutsASubagentsWorkBySeqNotWithItsCall() {
        var r = TranscriptReducer()
        for e in agentSession() { r.apply(e) }
        for i in 0..<6 { r.apply(ev(100 + i, .assistant, ["text": .string("reply \(i)")], turnId: "t\(i)")) }

        XCTAssertTrue(r.trimOlder(keeping: 3))
        let cut = r.state.oldestSeq ?? 0
        XCTAssertGreaterThan(cut, 10, "the Agent call and all of its work are older than the window")
        XCTAssertNil(r.state.subagentItems["toolu_agent"], "nothing newer than the cut was left under it")

        // Its work newer than the cut stays, although the call itself was trimmed.
        var late = TranscriptReducer()
        for e in agentSession() { late.apply(e) }
        for i in 0..<4 { late.apply(ev(300 + i, .assistant, ["text": .string("reply \(i)")], turnId: "u\(i)")) }
        late.apply(ev(400, .assistant, ["text": .string("a late report"), "parentToolUseId": .string("toolu_agent")]))
        XCTAssertTrue(late.trimOlder(keeping: 2))
        let kept = late.state.subagentItems["toolu_agent"] ?? []
        XCTAssertEqual(kept.count, 1, "\(kept)")
    }

    func testASnapshotRoundTripsAndOneFromBeforeTheseKeysStillDecodes() throws {
        var r = TranscriptReducer()
        for e in agentSession() { r.apply(e) }
        r.apply(RunEvent(seq: 22, type: .taskProgress, payload: .object(progressPayload(state: "running", tokens: 1))))
        let data = try JSONEncoder().encode(r.state)
        let back = try JSONDecoder().decode(TranscriptState.self, from: data)
        XCTAssertEqual(back, r.state)

        var old = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        old.removeValue(forKey: "subagentItems")
        old.removeValue(forKey: "taskProgress")
        let legacy = try JSONDecoder().decode(TranscriptState.self,
                                              from: JSONSerialization.data(withJSONObject: old))
        XCTAssertEqual(legacy.subagentItems, [:])
        XCTAssertEqual(legacy.items, r.state.items)
    }

    func testReceiptReadings() {
        XCTAssertEqual(BackgroundSummary.shellID("Command running in background with ID: bei75180m. Output is being written to: /x/bei75180m.output"), "bei75180m")
        XCTAssertEqual(BackgroundSummary.agentID(agentAck), "a05fc3596d22b3d3e")
        XCTAssertNil(BackgroundSummary.agentID("Here is my report. agentId: nope"))
        XCTAssertEqual(BackgroundSummary.workflow(workflowReceipt)?.taskID, "w2f3yv1s8")
        XCTAssertEqual(BackgroundSummary.workflow(workflowReceipt)?.summary, "3 competing designs; 2 judges")
        XCTAssertNil(BackgroundSummary.workflow("Error: script must begin with export const meta"))
        XCTAssertEqual(BackgroundSummary.parse("Agent \"Fill wikova gaps: citations\" finished")?.title, "Fill wikova gaps: citations")
        XCTAssertNil(BackgroundSummary.parse("Monitor reached its timeout and stopped"))
    }
}

/// The list line, header word and glyph for a session parked while its sub-agents work — the state
/// the iPhone read as "Waiting for your reply" (web parity: `parkedWorkLabel`, `statusLabel`, `StatusIcon`).
final class RunningSubagentStatusTests: XCTestCase {
    private func session(_ status: RunStatus, subagents: Int?, bg: Int? = nil,
                         lastToolUse: String? = nil, engineTurnActive: Bool? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, lastAssistantText: "the last reply",
                lastToolUse: lastToolUse, runningBgCount: bg, runningSubagentCount: subagents,
                engineTurnActive: engineTurnActive)
    }

    func testParkedWithAgentsAtWorkReadsAsRunningAgent() {
        let one = session(.awaitingInput, subagents: 1, bg: 2)
        XCTAssertEqual(SessionLine.make(for: one, live: true), .init(text: "Running Agent…", tone: .running))
        XCTAssertEqual(SessionHeader.statusWord(for: one), "Running Agent")
        XCTAssertEqual(SessionStatusGlyph.make(for: one).shape, .spinner)

        let three = session(.awaitingInput, subagents: 3)
        XCTAssertEqual(SessionLine.make(for: three, live: true).text, "Running 3 agents…")
        XCTAssertEqual(SessionHeader.statusWord(for: three), "Running 3 agents")
    }

    func testNoAgentsKeepsTheOldReadings() {
        let idle = session(.awaitingInput, subagents: 0, bg: 2)
        XCTAssertEqual(SessionLine.make(for: idle, live: true).text, "2 background processes running…")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.awaitingInput, subagents: nil)), "Waiting for your reply")
    }

    func testAToolInFlightStillNamesTheTool() {
        let tool = session(.running, subagents: 1, lastToolUse: "Bash")
        XCTAssertEqual(SessionLine.make(for: tool, live: true).text, "Running Bash…")
        XCTAssertEqual(SessionLine.make(for: session(.running, subagents: 1), live: true).text, "Running Agent…")
    }
}
