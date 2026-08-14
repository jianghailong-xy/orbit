import XCTest
@testable import OrbitKit

/// The Phase-0 gate: a recorded session transcript folded by the reducer must produce exactly
/// the expected bubbles / approvals / background state — with seq dedup and optimistic
/// reconciliation. This is the test that de-risks the whole native-console bet.
final class TranscriptReducerTests: XCTestCase {

    /// A representative turn: user → streamed assistant text → tool call+result → more text →
    /// a resolved approval → a background process → a DUPLICATE durable event → turn end.
    private func recordedSession() -> [RunEvent] {
        [
            RunEvent(seq: 1, type: .system, payload: .object(["text": .string("session started")])),
            RunEvent(seq: 2, type: .user, payload: .object(["text": .string("List the files"),
                                                            "clientTurnId": .string("c1")])),
            RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("I'll ")])),
            RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("list them.")])),
            RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string("I'll list them.")])),
            RunEvent(seq: 4, type: .toolUse, payload: .object(["toolUseId": .string("t1"),
                                                               "name": .string("Bash"),
                                                               "input": .object(["command": .string("ls")])])),
            RunEvent(seq: 5, type: .toolResult, payload: .object(["toolUseId": .string("t1"),
                                                                  "content": .string("a.txt\nb.txt")])),
            RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Done.")])),
            RunEvent(seq: 6, type: .assistant, payload: .object(["text": .string("Done.")])),
            RunEvent(seq: 0, type: .approvalRequest, payload: .object(["id": .string("ap1"),
                                                                       "toolName": .string("Bash"),
                                                                       "input": .object(["command": .string("rm x")])])),
            RunEvent(seq: 0, type: .approvalResolved, payload: .object(["id": .string("ap1")])),
            // Background Bash launch (run_in_background): the command lives HERE, on the tool_use —
            // the background_* events below never carry it (the real runner contract).
            RunEvent(seq: 7, type: .toolUse, payload: .object(["toolUseId": .string("bgt1"),
                                                               "name": .string("Bash"),
                                                               "input": .object(["command": .string("npm test"),
                                                                                 "run_in_background": .bool(true)])])),
            // Runner keys these by shellId + toolUseId and streams the live tail under `content`.
            RunEvent(seq: 8, type: .backgroundTask, payload: .object(["shellId": .string("bg1"),
                                                                      "toolUseId": .string("bgt1"),
                                                                      "status": .string("running")])),
            RunEvent(seq: 0, type: .backgroundOutput, payload: .object(["shellId": .string("bg1"),
                                                                        "toolUseId": .string("bgt1"),
                                                                        "content": .string("PASS")])),
            RunEvent(seq: 9, type: .backgroundTask, payload: .object(["shellId": .string("bg1"),
                                                                      "toolUseId": .string("bgt1"),
                                                                      "status": .string("completed")])),
            // Duplicate of seq 3 (e.g. an over-eager reconnect replay): must be deduped.
            RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string("I'll list them.")])),
            RunEvent(seq: 10, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])),
        ]
    }

    func testFoldsRecordedSession() {
        var r = TranscriptReducer()
        for ev in recordedSession() { r.apply(ev) }
        let s = r.state

        // 5 transcript items: user, assistant, tool (ls), assistant, tool (background npm test).
        // (system is lifecycle, not an item.)
        XCTAssertEqual(s.items.count, 5, "expected user + assistant + tool + assistant + background tool")

        XCTAssertEqual(s.items[0].asUser?.text, "List the files")
        XCTAssertEqual(s.items[0].asUser?.pending, false)

        // Streaming deltas folded into the bubble, then replaced by the durable full text.
        XCTAssertEqual(s.items[1].asAssistant?.displayText, "I'll list them.")
        XCTAssertEqual(s.items[1].asAssistant?.isFinalized, true)

        let tool = s.items[2].asTool
        XCTAssertEqual(tool?.id, "t1")
        XCTAssertEqual(tool?.name, "Bash")
        XCTAssertEqual(tool?.result, "a.txt\nb.txt")
        XCTAssertEqual(tool?.status, .ok)

        XCTAssertEqual(s.items[3].asAssistant?.displayText, "Done.")

        // Approval requested then resolved → nothing pending.
        XCTAssertTrue(s.pendingApprovals.isEmpty)

        // One background process, completed, with its output tail captured.
        XCTAssertEqual(s.background.count, 1)
        XCTAssertEqual(s.background.first?.status, "completed")
        XCTAssertEqual(s.background.first?.outputTail, "PASS")
        XCTAssertEqual(s.background.first?.command, "npm test",
                       "command is correlated from the launching Bash tool_use, not the background event")

        XCTAssertEqual(s.status, .awaitingInput)
        // maxSeq tracks the durable high-water (turn_end seq 10) — the reconnect cursor.
        XCTAssertEqual(s.maxSeq, 10)
    }

    /// An AskUserQuestion arrives as BOTH a `tool_use` (read-only tool card) and an `approval_request`
    /// (interactive card). While the question is pending, only the interactive card should show — the
    /// read-only card is suppressed to avoid double-displaying the question (web parity); once answered
    /// it becomes the historical record.
    func testAskUserQuestionCardSuppressedWhileApprovalPending() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .toolUse, payload: .object([
            "toolUseId": .string("q1"), "name": .string("AskUserQuestion"),
            "input": .object(["questions": .array([.object([
                "question": .string("Pick one"),
                "options": .array([.object(["label": .string("A")]), .object(["label": .string("B")])])])])])])))
        r.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap-q1"), "toolName": .string("AskUserQuestion"),
            "input": .object(["questions": .array([.object(["question": .string("Pick one")])])])])))

        let card = r.state.items.first { if case .toolCall = $0 { return true }; return false }!
        XCTAssertTrue(Approvals.duplicatesPendingApproval(card, pendingApprovals: r.state.pendingApprovals),
                      "read-only question card must be hidden while its approval is pending")

        // Answered: tool_result sets the card's result and the approval resolves → shown as history.
        r.apply(RunEvent(seq: 2, type: .toolResult, payload: .object([
            "toolUseId": .string("q1"), "content": .string("A")])))
        r.apply(RunEvent(seq: 0, type: .approvalResolved, payload: .object(["id": .string("ap-q1")])))
        let answered = r.state.items.first { if case .toolCall = $0 { return true }; return false }!
        XCTAssertFalse(Approvals.duplicatesPendingApproval(answered, pendingApprovals: r.state.pendingApprovals),
                       "answered question card must render as the historical record")

        // A regular tool-permission approval never suppresses its tool card.
        var r2 = TranscriptReducer()
        r2.apply(RunEvent(seq: 1, type: .toolUse, payload: .object([
            "toolUseId": .string("b1"), "name": .string("Bash"),
            "input": .object(["command": .string("rm x")])])))
        r2.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap-b1"), "toolName": .string("Bash"),
            "input": .object(["command": .string("rm x")])])))
        let bash = r2.state.items.first { if case .toolCall = $0 { return true }; return false }!
        XCTAssertFalse(Approvals.duplicatesPendingApproval(bash, pendingApprovals: r2.state.pendingApprovals))
    }

    /// The runner keys background events by `shellId`/`toolUseId` and re-sends the WHOLE output
    /// tail under `content` on every change (a capped file snapshot, not a delta). Repeated
    /// `background_output` events must REPLACE the tail, and the process id must track shellId —
    /// not mint a fresh synthetic "i<n>" each time (the bug that showed bare ids in the tray).
    func testBackgroundOutputSnapshotReplacesAndKeepsOneProcess() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .backgroundOutput,
                         payload: .object(["shellId": .string("sh1"), "content": .string("line 1\n")])))
        r.apply(RunEvent(seq: 0, type: .backgroundOutput,
                         payload: .object(["shellId": .string("sh1"), "content": .string("line 1\nline 2\n")])))
        XCTAssertEqual(r.state.background.count, 1, "same shellId ⇒ one process, not one per event")
        XCTAssertEqual(r.state.background.first?.id, "sh1", "id tracks shellId, no synthetic fallback")
        XCTAssertEqual(r.state.background.first?.outputTail, "line 1\nline 2\n", "snapshot replaces, not appends")
    }

    /// The tray row is correlated from the launching Bash(run_in_background) tool_use — the
    /// background_task completion event carries neither command nor description. Keep BOTH: the human
    /// `description` titles the row while `command` retains the raw command for the expanded body
    /// (web parity: `BgShell.command` + `.description`).
    func testBackgroundCommandTitledFromLaunchDescription() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 4, type: .toolUse, payload: .object([
            "toolUseId": .string("tu9"), "name": .string("Bash"),
            "input": .object(["command": .string("sleep 30 && echo done"),
                              "description": .string("wait then greet"),
                              "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 5, type: .backgroundTask, payload: .object([
            "shellId": .string("sh9"), "toolUseId": .string("tu9"), "status": .string("completed")])))
        XCTAssertEqual(r.state.background.count, 1)
        XCTAssertEqual(r.state.background.first?.command, "sleep 30 && echo done",
                       "raw command retained so the expanded row can surface it")
        XCTAssertEqual(r.state.background.first?.description, "wait then greet",
                       "human description kept as the tray-row title")
        XCTAssertEqual(r.state.background.first?.status, "completed")
    }

    /// Regression (the reported bug): a background launch WITH a human description must keep the raw
    /// command too — `description` titles the tray row while `command` feeds its expanded body.
    /// Previously the reducer stored only `description ?? command`, so a described process lost its
    /// command entirely and the expanded row could never show it (web showed it; iOS/macOS didn't).
    func testBackgroundLaunchKeepsBothDescriptionAndCommand() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 4, type: .toolUse, payload: .object([
            "toolUseId": .string("tu5"), "name": .string("Bash"),
            "input": .object(["command": .string("gh run watch 123 --interval 30"),
                              "description": .string("Watch PR #21 CI"),
                              "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 5, type: .toolResult, payload: .object([
            "toolUseId": .string("tu5"), "isError": .bool(false),
            "content": .string("Command running in background with ID: bg21. Output is being written to: /t/bg21.output.")])))
        XCTAssertEqual(r.state.background.count, 1, "confirmed launch surfaces one row")
        XCTAssertEqual(r.state.background.first?.description, "Watch PR #21 CI", "description titles the row")
        XCTAssertEqual(r.state.background.first?.command, "gh run watch 123 --interval 30",
                       "raw command retained for the expanded body — not overwritten by the description")
        XCTAssertEqual(r.state.background.first?.status, "running")
    }

    /// A background shell must appear in the tray as soon as its launch is confirmed by the
    /// tool_result ("…running in background with ID…") — WITHOUT waiting for a background_task,
    /// which may never arrive (still running, or its completion notification was never recorded as
    /// an event). Regression: iOS built the tray only from background_task events, so a running
    /// shell that web showed (web builds from the launch) was invisible on iOS.
    func testRunningBackgroundShellVisibleFromLaunchAlone() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 10, type: .toolUse, payload: .object([
            "toolUseId": .string("tu5"), "name": .string("Bash"),
            "input": .object(["command": .string("npm run dev"), "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 11, type: .toolResult, payload: .object([
            "toolUseId": .string("tu5"),
            "content": .string("Command running in background with ID: dev123. Output is being written to: /t/dev123.output.")])))
        // No background_task yet — the shell is still running.
        XCTAssertEqual(r.state.background.count, 1, "running shell must be visible from the launch alone")
        XCTAssertEqual(r.state.background.first?.command, "npm run dev")
        XCTAssertEqual(r.state.background.first?.status, "running")

        // A later completion (background_task) updates the SAME row, correlated by toolUseId.
        r.apply(RunEvent(seq: 20, type: .backgroundTask, payload: .object([
            "shellId": .string("dev123"), "toolUseId": .string("tu5"), "status": .string("completed")])))
        XCTAssertEqual(r.state.background.count, 1, "completion updates, not duplicates")
        XCTAssertEqual(r.state.background.first?.status, "completed")
        XCTAssertEqual(r.state.background.first?.command, "npm run dev")
    }

    /// A failed background launch (its tool_result lacks the confirmation) must NOT create a phantom
    /// tray row.
    func testFailedBackgroundLaunchCreatesNoTrayRow() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 10, type: .toolUse, payload: .object([
            "toolUseId": .string("tu6"), "name": .string("Bash"),
            "input": .object(["command": .string("bad &"), "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 11, type: .toolResult, payload: .object([
            "toolUseId": .string("tu6"), "isError": .bool(true),
            "content": .string("bash: bad: command not found")])))
        XCTAssertTrue(r.state.background.isEmpty, "no confirmation ⇒ no tray row")
    }

    /// The composer's context gauge reads the latest positive `contextTokens` from any event. New
    /// runners normally report it on `turn_end`; a lightweight status/unknown event may also
    /// refresh it without ending the active turn. Later events that omit it keep the last known
    /// value rather than blanking the gauge.
    func testEventsCarryContextTokens() {
        var r = TranscriptReducer()
        XCTAssertNil(r.state.contextTokens, "no usage event yet ⇒ gauge hidden")
        r.apply(RunEvent(seq: 1, type: .turnEnd,
                         payload: .object(["status": .string("AWAITING_INPUT"), "contextTokens": .int(94500)])))
        XCTAssertEqual(r.state.contextTokens, 94500)
        r.apply(RunEvent(seq: 2, type: .system, payload: .object(["contextTokens": .int(109879)])))
        XCTAssertEqual(r.state.contextTokens, 109879)
        r.apply(RunEvent(seq: 3, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])))
        XCTAssertEqual(r.state.contextTokens, 109879, "an event without the field keeps the last value")
        r.apply(RunEvent(seq: 4, type: .system, payload: .object(["contextTokens": .int(0)])))
        XCTAssertEqual(r.state.contextTokens, 109879, "zero does not blank the last known value")
    }

    /// A `Read` on an image delivers `content` as an array of base64 `image` blocks, not a string.
    /// The reducer must decode those into `ToolCard.resultImages` for inline display (web parity),
    /// and leave `result` nil so no empty OUTPUT text panel renders alongside the image.
    func testImageToolResultDecodesIntoResultImages() {
        var r = TranscriptReducer()
        let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])   // PNG magic header
        r.apply(RunEvent(seq: 1, type: .toolUse, payload: .object([
            "toolUseId": .string("img1"), "name": .string("Read"),
            "input": .object(["file_path": .string("/tmp/proto.png")])])))
        r.apply(RunEvent(seq: 2, type: .toolResult, payload: .object([
            "toolUseId": .string("img1"),
            "content": .array([.object([
                "type": .string("image"),
                "source": .object(["type": .string("base64"),
                                   "media_type": .string("image/png"),
                                   "data": .string(pngBytes.base64EncodedString())])])])])))
        let tool = r.state.items.first?.asTool
        XCTAssertEqual(tool?.status, .ok)
        XCTAssertEqual(tool?.resultImages, [pngBytes], "image block base64 should decode into resultImages")
        XCTAssertNil(tool?.result, "an image-only result carries no text → result stays nil")
    }

    /// The tray row keeps the launch wall-clock (the surfacing tool_result's `ts`) so it can render
    /// "5m ago" like web's `BgShell.startedTs`. Stored raw; the view formats it via `RelativeTime`.
    func testBackgroundShellCapturesStartedAtFromLaunchTimestamp() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 10, type: .toolUse, payload: .object([
            "toolUseId": .string("tu7"), "name": .string("Bash"),
            "input": .object(["command": .string("npm run dev"), "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 11, type: .toolResult, ts: "2026-06-26T10:00:00Z", payload: .object([
            "toolUseId": .string("tu7"),
            "content": .string("Command running in background with ID: dev7. Output is being written to: /t/dev7.output.")])))
        XCTAssertEqual(r.state.background.first?.startedAt, "2026-06-26T10:00:00Z")
    }

    func testDurableDedupKeepsSingleItem() {
        var r = TranscriptReducer()
        let ev = RunEvent(seq: 42, type: .assistant, payload: .object(["text": .string("hi")]))
        r.apply(ev)
        r.apply(ev)                              // replayed on reconnect
        XCTAssertEqual(r.state.items.count, 1)
        XCTAssertEqual(r.state.maxSeq, 42)
    }

    func testOptimisticUserReconciledByClientTurnId() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c9", text: "deploy please")
        XCTAssertEqual(r.state.items.count, 1)
        XCTAssertEqual(r.state.items[0].asUser?.pending, true)

        // Server echoes the durable user turn carrying the same clientTurnId.
        r.apply(RunEvent(seq: 10, type: .user, payload: .object(["text": .string("deploy please"),
                                                                 "clientTurnId": .string("c9")])))
        XCTAssertEqual(r.state.items.count, 1, "must reconcile, not duplicate")
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
    }

    /// Real-world path: the runner's durable `user` event echoes the server `turnId` (top-level),
    /// NOT `clientTurnId` in the payload. The optimistic bubble — tagged with that turnId from the
    /// POST /turns response — must reconcile by turnId instead of duplicating. (Regression: macOS
    /// previously matched only on the never-echoed clientTurnId, so every sent message doubled.)
    func testOptimisticUserReconciledByServerTurnId() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c9", text: "ask me a question")
        r.setOptimisticTurnId(clientTurnId: "c9", turnId: "turn-77")   // from POST /turns response
        XCTAssertEqual(r.state.items[0].asUser?.pending, true)

        r.apply(RunEvent(seq: 10, type: .user, turnId: "turn-77",
                         payload: .object(["text": .string("ask me a question")])))
        XCTAssertEqual(r.state.items.count, 1, "must reconcile by server turnId, not duplicate")
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
    }

    /// Regression (the reported iOS bug): the durable `user` event can beat the POST /turns response
    /// that assigns the turnId — iOS runs SSE and REST on separate connection pools, so their
    /// ordering isn't guaranteed. The optimistic bubble is still untagged (turnId nil) when the event
    /// lands, so a turnId-only match misses; matching on the message text reconciles it in place
    /// instead of leaving the original stuck on "Sending…" beside a duplicate. A late
    /// `setOptimisticTurnId` must then be a no-op, not resurrect the duplicate.
    func testOptimisticUserReconciledByTextWhenTurnIdRacesLate() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c9", text: "先做123条的效果图")
        XCTAssertEqual(r.state.items[0].asUser?.pending, true)

        // Durable event arrives FIRST — no clientTurnId echo, bubble still turnId nil.
        r.apply(RunEvent(seq: 10, type: .user, turnId: "turn-77",
                         payload: .object(["text": .string("先做123条的效果图")])))
        XCTAssertEqual(r.state.items.count, 1, "must reconcile by text, not duplicate")
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
        XCTAssertEqual(r.state.items[0].asUser?.turnId, "turn-77", "adopts the server turnId")

        // The POST response finally lands and tries to tag the (already reconciled) bubble.
        r.setOptimisticTurnId(clientTurnId: "c9", turnId: "turn-77")
        XCTAssertEqual(r.state.items.count, 1, "late tag must not strand a duplicate")
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
    }

    /// A message sent while another turn is in flight is held in `state.queued` (rendered after the
    /// transcript, out of the running turn's output) and flagged `queued` so it reads "Queued" not
    /// "Sending…" (web parity). An idle send has no in-flight reply to split, so it goes into `items`.
    func testOptimisticUserCarriesQueuedFlag() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "do this next", queued: true)
        XCTAssertTrue(r.state.items.isEmpty, "a queued send is held out of the transcript")
        XCTAssertEqual(r.state.queued.count, 1)
        XCTAssertEqual(r.state.queued[0].pending, true)
        XCTAssertEqual(r.state.queued[0].queued, true)

        r.addOptimisticUser(clientTurnId: "c2", text: "right away")   // idle send → straight into items
        XCTAssertEqual(r.state.items.count, 1)
        XCTAssertEqual(r.state.items[0].asUser?.queued, false)
    }

    /// Regression (the reported iOS bug): an expired sign-in fails the run *before* the runner feeds
    /// the message to the agent, so no durable `user` event is ever emitted for it and the server
    /// drains the queued turn silently. The bubble used to sit on "Sending…" for the life of the
    /// session — a message that was going nowhere, looking like it was still on its way. The terminal
    /// status is the signal: anything still pending when the run settles was never taken.
    func testTerminalStatusMarksUnconfirmedSendsUndelivered() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "什么是 icr")
        r.addOptimisticUser(clientTurnId: "c2", text: "and this too", queued: true)
        // The signed-out engine reports itself as an error event → the sign-in remedy card.
        r.apply(RunEvent(seq: 10, type: .error, payload: .object([
            "message": .string("Failed to authenticate: Claude Code is installed on this runner but not signed in."),
        ])))
        r.apply(RunEvent(seq: 11, type: .turnEnd, payload: .object(["status": .string("FAILED")])))

        XCTAssertEqual(r.state.status, .failed)
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
        XCTAssertEqual(r.state.items[0].asUser?.undelivered, true)
        XCTAssertEqual(r.state.items[0].asUser?.text, "什么是 icr", "the text stays — the card's Retry re-sends it")
        XCTAssertEqual(r.state.queued[0].undelivered, true, "a queued turn is drained by the same end")
    }

    /// The mark applies only to turns the server never echoed, and only when the run actually ends.
    func testUndeliveredMarkSparesConfirmedTurnsAndLiveStatuses() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "ship it")
        r.apply(RunEvent(seq: 10, type: .user, payload: .object(["text": .string("ship it"),
                                                                 "clientTurnId": .string("c1")])))
        r.apply(RunEvent(seq: 11, type: .turnEnd, payload: .object(["status": .string("FAILED")])))
        XCTAssertEqual(r.state.items[0].asUser?.undelivered, false,
                       "this turn WAS delivered — the run failed afterwards, which the error row says")

        var live = TranscriptReducer()
        live.addOptimisticUser(clientTurnId: "c2", text: "still going")
        live.apply(RunEvent(seq: 10, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])))
        XCTAssertEqual(live.state.items[0].asUser?.pending, true, "a live session's send is still on its way")
        XCTAssertEqual(live.state.items[0].asUser?.undelivered, false)
    }

    /// Regression (the reported iOS bug): a message sent mid-stream must NOT be spliced into the
    /// middle of the reply. The assistant keeps streaming after the send — the queued bubble stays
    /// apart in `state.queued`, and the open assistant bubble keeps growing in place, unsplit.
    func testQueuedSendDoesNotSplitStreamingReply() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .textDelta, payload: .object(["delta": .string("Working on ")])))
        r.addOptimisticUser(clientTurnId: "c1", text: "also do this", queued: true)
        r.apply(RunEvent(seq: 2, type: .textDelta, payload: .object(["delta": .string("it now.")])))

        XCTAssertEqual(r.state.items.count, 1, "one assistant bubble — not split around the send")
        XCTAssertEqual(r.state.items[0].asAssistant?.displayText, "Working on it now.")
        XCTAssertEqual(r.state.queued.map(\.text), ["also do this"], "the send waits after the transcript")
    }

    /// When the runner leases the queued turn, its durable `user` event (carrying the tagged server
    /// turnId) moves it out of `state.queued` into `items` as a real, correctly-ordered row.
    func testQueuedSendReconcilesIntoTranscriptWhenLeased() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object(["text": .string("done")])))
        r.addOptimisticUser(clientTurnId: "c1", text: "next task", queued: true)
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t9")   // from POST /turns response
        XCTAssertEqual(r.state.queued.count, 1)

        r.apply(RunEvent(seq: 2, type: .user, turnId: "t9",
                         payload: .object(["text": .string("next task")])))
        XCTAssertTrue(r.state.queued.isEmpty, "leased → removed from the queue")
        XCTAssertEqual(r.state.items.count, 2, "[assistant, user] in order")
        XCTAssertEqual(r.state.items.last?.asUser?.text, "next task")
        XCTAssertEqual(r.state.items.last?.asUser?.pending, false)
    }

    /// The same POST-vs-SSE race on the queued path: a mid-turn send whose turnId tag loses the race
    /// must still be pulled out of `state.queued` by its durable `user` event (matched on text),
    /// leaving one correctly-ordered row rather than a stuck "Queued" placeholder plus a duplicate.
    func testQueuedSendReconciledByTextWhenTurnIdRacesLate() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object(["text": .string("on it")])))
        r.addOptimisticUser(clientTurnId: "c1", text: "next task", queued: true)
        XCTAssertEqual(r.state.queued.count, 1)

        // Durable event beats the POST response — queued bubble still untagged (turnId nil).
        r.apply(RunEvent(seq: 2, type: .user, turnId: "t9",
                         payload: .object(["text": .string("next task")])))
        XCTAssertTrue(r.state.queued.isEmpty, "leased by text match → removed from the queue")
        XCTAssertEqual(r.state.items.count, 2, "[assistant, user] — no duplicate")
        XCTAssertEqual(r.state.items.last?.asUser?.text, "next task")
        XCTAssertEqual(r.state.items.last?.asUser?.pending, false)
    }

    /// An interrupt drops queued follow-ups server-side, so the durable `interrupt` event clears the
    /// local queue too — otherwise a queued bubble would linger with no `user` event to reconcile it.
    func testInterruptClearsQueue() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "queued one", queued: true)
        XCTAssertEqual(r.state.queued.count, 1)
        r.apply(RunEvent(seq: 5, type: .interrupt, payload: .object([:])))
        XCTAssertTrue(r.state.queued.isEmpty)
    }

    /// The queued bubble's Cancel button withdraws one waiting message by id, leaving any other
    /// queued sends untouched (the server DELETE targets the same single turn). A lost race is a
    /// no-op: if the runner already leased it, its durable `user` event just lands normally, since
    /// `appendUser` finds nothing left in the queue to reconcile.
    func testRemoveQueuedWithdrawsOneWaitingMessage() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .textDelta, payload: .object(["delta": .string("working")])))
        r.addOptimisticUser(clientTurnId: "c1", text: "first queued", queued: true)
        r.addOptimisticUser(clientTurnId: "c2", text: "second queued", queued: true)
        let firstID = r.state.queued[0].id

        r.removeQueued(id: firstID)
        XCTAssertEqual(r.state.queued.map(\.text), ["second queued"], "only the targeted turn is withdrawn")
        XCTAssertEqual(r.state.items.count, 1, "the streaming reply is undisturbed")

        r.removeQueued(id: "not-a-real-id")   // unknown id → no-op
        XCTAssertEqual(r.state.queued.count, 1)
    }

    /// A send that failed for good (retries exhausted) takes its optimistic bubble back down, from
    /// wherever it sits — a queued send waits in `state.queued`, an idle one is already in `items` —
    /// so a message that never reached the server doesn't read as delivered. The composer gets the
    /// text back instead (`ConsoleModel.send`).
    func testRemoveOptimisticUserDropsTheUndeliveredBubble() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "never landed")
        r.addOptimisticUser(clientTurnId: "c2", text: "queued, never landed", queued: true)

        r.removeOptimisticUser(clientTurnId: "c1")
        XCTAssertTrue(r.state.items.isEmpty, "the undelivered bubble is gone from the transcript")
        r.removeOptimisticUser(clientTurnId: "c2")
        XCTAssertTrue(r.state.queued.isEmpty, "…and from the queue")

        r.removeOptimisticUser(clientTurnId: "never-sent")   // unknown id → no-op
    }

    /// A bubble the durable `user` event already reconciled belongs to a turn that DID land — only
    /// the response to it was lost — so a late failure must leave it alone. (The replay's idempotent
    /// clientTurnId normally recovers that turn; this is the belt to that suspenders.)
    func testRemoveOptimisticUserKeepsAnAlreadyReconciledTurn() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "landed after all")
        r.apply(RunEvent(seq: 3, type: .user, payload: .object(["text": .string("landed after all"),
                                                                "clientTurnId": .string("c1")])))
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)

        r.removeOptimisticUser(clientTurnId: "c1")
        XCTAssertEqual(r.state.items.count, 1, "a confirmed turn stays in the transcript")
    }

    /// Removing a bubble from the middle of the transcript must close the gap for the open-bubble
    /// cursors too (they're item INDICES): a failed send while another turn is still streaming would
    /// otherwise send the next delta into the wrong bubble.
    func testRemoveOptimisticUserKeepsStreamingCursorsAligned() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "this one fails")
        r.apply(RunEvent(seq: 1, type: .textDelta, payload: .object(["delta": .string("still ")])))

        r.removeOptimisticUser(clientTurnId: "c1")
        r.apply(RunEvent(seq: 2, type: .textDelta, payload: .object(["delta": .string("streaming")])))
        XCTAssertEqual(r.state.items.count, 1, "only the assistant bubble is left")
        XCTAssertEqual(r.state.items[0].asAssistant?.displayText, "still streaming")
    }

    /// The durable `user` event carries `attachments` ([{id,mime,name}]) and a `ts` — both must
    /// land on the bubble so it can render image thumbnails / file chips and a relative time
    /// (web parity; the runner echoes `attachments`, not `attachmentIds`).
    func testUserEventParsesAttachmentsAndTimestamp() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 7, type: .user, ts: "2026-06-26T10:00:00Z",
                         payload: .object([
                            "text": .string("look at this"),
                            "attachments": .array([
                                .object(["id": .string("att1"), "mime": .string("image/png"), "name": .string("a.png")]),
                                .object(["id": .string("att2"), "mime": .string("application/pdf")]),
                                .object(["mime": .string("image/png")]),   // no id → dropped
                            ]),
                         ])))
        let bubble = r.state.items[0].asUser
        XCTAssertEqual(bubble?.attachments.map(\.id), ["att1", "att2"])
        XCTAssertEqual(bubble?.attachments.first?.mime, "image/png")
        XCTAssertEqual(bubble?.attachments.first?.isImage, true)
        XCTAssertEqual(bubble?.attachments.last?.isImage, false)   // application/pdf
        XCTAssertEqual(bubble?.ts, "2026-06-26T10:00:00Z")
    }

    /// An optimistic image bubble (id-only, mime unknown) reconciles to the durable event, which
    /// supplies the real mime + a timestamp — without duplicating the bubble.
    func testOptimisticBubbleAdoptsDurableAttachmentsAndTs() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "see screenshot",
                            attachments: [TurnAttachment(id: "att1")])
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1")
        XCTAssertNil(r.state.items[0].asUser?.attachments.first?.mime)
        XCTAssertEqual(r.state.items[0].asUser?.attachments.first?.isImage, true)   // unknown mime ⇒ image

        r.apply(RunEvent(seq: 9, type: .user, ts: "2026-06-26T12:00:00Z", turnId: "t1",
                         payload: .object([
                            "text": .string("see screenshot"),
                            "attachments": .array([
                                .object(["id": .string("att1"), "mime": .string("image/jpeg")]),
                            ]),
                         ])))
        XCTAssertEqual(r.state.items.count, 1, "reconcile, not duplicate")
        XCTAssertEqual(r.state.items[0].asUser?.pending, false)
        XCTAssertEqual(r.state.items[0].asUser?.attachments.first?.mime, "image/jpeg")
        XCTAssertEqual(r.state.items[0].asUser?.ts, "2026-06-26T12:00:00Z")
    }

    func testTextDeltaWithoutDurableFinalizeStillRenders() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("partial ")])))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("answer")])))
        r.apply(RunEvent(seq: 5, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])))
        XCTAssertEqual(r.state.items.count, 1)
        XCTAssertEqual(r.state.items[0].asAssistant?.displayText, "partial answer")
    }

    /// A live AskUserQuestion nudge carries its questions nested under `input` (the control plane
    /// sends `{id, toolName, input, toolUseId}`). It must classify as `.question` so the form
    /// renders — not as a generic `.tool` allow/deny — and `input` must still parse the questions.
    func testLiveAskUserQuestionClassifiesAsQuestion() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap-q"),
            "toolName": .string("AskUserQuestion"),
            "input": .object(["questions": .array([
                .object(["question": .string("Which DB?"),
                         "options": .array([.object(["label": .string("Postgres")])])]),
            ])]),
        ])))
        XCTAssertEqual(r.state.pendingApprovals.count, 1)
        let appr = r.state.pendingApprovals[0]
        XCTAssertEqual(appr.kind, .question)
        XCTAssertEqual(appr.toolName, "AskUserQuestion")
        XCTAssertEqual(appr.input.map { Approvals.parseQuestions(from: $0) }?.first?.question, "Which DB?")
    }

    /// Reconciling durable approvals (the REST source of truth) against local state: a listed
    /// approval already folded in from a live nudge isn't duplicated, a newly listed one is added,
    /// and a human decision removes one optimistically.
    func testReconcileAddsAndDedupes() {
        var r = TranscriptReducer()
        // A live nudge already folded in for ap1.
        r.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap1"), "toolName": .string("Bash"),
            "input": .object(["command": .string("ls")])])))

        r.reconcileApprovals([
            PendingApproval(id: "ap1", kind: .tool, toolName: "Bash", input: nil),         // dup → skipped
            PendingApproval(id: "ap2", kind: .question, toolName: "AskUserQuestion", input: nil),
        ], knownBefore: ["ap1"])
        XCTAssertEqual(r.state.pendingApprovals.map(\.id), ["ap1", "ap2"], "ap1 not duplicated")

        r.removeApproval(id: "ap2")
        XCTAssertEqual(r.state.pendingApprovals.map(\.id), ["ap1"])
    }

    /// The reported bug: a card answered on the web client while this client was disconnected must
    /// disappear on reconnect. Its seq-0 `approval_resolved` is never replayed, so the durable REST
    /// list (which no longer includes it) is the only signal — reconciling against it drops the card,
    /// because it was known before the fetch yet is absent from the authoritative list.
    func testReconcileDropsApprovalResolvedElsewhere() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap-web"), "toolName": .string("AskUserQuestion"),
            "input": .object(["questions": .array([])])])))
        XCTAssertEqual(r.state.pendingApprovals.map(\.id), ["ap-web"])

        // Reconnect: GET /approvals returns empty (it was answered on web).
        r.reconcileApprovals([], knownBefore: ["ap-web"])
        XCTAssertTrue(r.state.pendingApprovals.isEmpty, "card resolved on web is cleared on reconnect")
    }

    /// Race safety: a live `approval_request` that folds in *during* the REST fetch (so its id isn't
    /// in the pre-fetch `knownBefore` snapshot) must survive reconciliation even though the older REST
    /// snapshot predates it — otherwise a freshly-arrived prompt would be clobbered on every reconnect.
    func testReconcileKeepsLiveNudgeThatRacedTheFetch() {
        var r = TranscriptReducer()
        // A nudge for ap-live arrives while the (empty) REST fetch is in flight.
        r.apply(RunEvent(seq: 0, type: .approvalRequest, payload: .object([
            "id": .string("ap-live"), "toolName": .string("Bash"),
            "input": .object(["command": .string("ls")])])))

        // The REST snapshot (taken before ap-live existed) is empty, and knownBefore predates it too.
        r.reconcileApprovals([], knownBefore: [])
        XCTAssertEqual(r.state.pendingApprovals.map(\.id), ["ap-live"], "concurrent live nudge preserved")
    }

    // MARK: - tail-first initial load (the "reopened session shows no reply" fix)

    /// The server's `/events/page` JSON decodes into `EventPage`, and folding that page — which
    /// starts mid-conversation (its first event is an orphan `tool_result` whose `tool_use` is on
    /// an earlier page) — still reconstructs the recent assistant reply and advances the status.
    /// This is the contract `ConsoleModel.run()` relies on to paint a reopened session at its latest
    /// message instead of replaying the whole history over SSE.
    func testFoldsTailPageWithOrphanBoundaryEvent() throws {
        let json = """
        { "hasMore": true, "events": [
          { "seq": 840, "type": "tool_result", "payload": { "toolUseId": "old", "content": "..." } },
          { "seq": 841, "type": "assistant", "payload": { "text": "侦察回来了。" } },
          { "seq": 842, "type": "turn_end", "payload": { "status": "AWAITING_INPUT" } }
        ] }
        """
        let page = try JSONDecoder().decode(EventPage.self, from: Data(json.utf8))
        XCTAssertTrue(page.hasMore)
        XCTAssertEqual(page.events.count, 3)

        var r = TranscriptReducer()
        for ev in page.events { r.apply(ev) }
        let s = r.state

        // The orphan tool_result folds to nothing; the assistant reply renders; status advances.
        XCTAssertEqual(s.items.compactMap(\.asAssistant).map(\.text), ["侦察回来了。"])
        XCTAssertEqual(s.status, .awaitingInput)
        // maxSeq is the tail's high-water mark, so the follow-on SSE resumes from seq > 842.
        XCTAssertEqual(s.maxSeq, 842)
    }

    // MARK: - scroll-up history paging (prependOlder — the "can't reach the top" fix)

    func testApplyTailPageTracksHistoryWindow() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("hi")])),
            RunEvent(seq: 42, type: .assistant, payload: .object(["text": .string("hello")])),
        ], hasMore: true))
        XCTAssertEqual(r.state.oldestSeq, 41, "low-water mark = the before= cursor for scroll-up")
        XCTAssertEqual(r.state.maxSeq, 42)
        XCTAssertTrue(r.state.hasMoreOlder)
    }

    func testPrependOlderGraftsHistoryInFront() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("latest question")])),
            RunEvent(seq: 42, type: .assistant, payload: .object(["text": .string("latest reply")])),
        ], hasMore: true))

        r.prependOlder(EventPage(events: [
            RunEvent(seq: 1, type: .user, payload: .object(["text": .string("first question")])),
            RunEvent(seq: 2, type: .assistant, payload: .object(["text": .string("first reply")])),
            RunEvent(seq: 3, type: .toolUse, payload: .object(["toolUseId": .string("t9"),
                                                               "name": .string("Bash"),
                                                               "input": .object(["command": .string("ls")])])),
            RunEvent(seq: 4, type: .toolResult, payload: .object(["toolUseId": .string("t9"),
                                                                  "content": .string("a.txt")])),
        ], hasMore: false))

        XCTAssertEqual(r.state.items.count, 5)
        XCTAssertEqual(r.state.items.first?.asUser?.text, "first question", "history grafts in front")
        XCTAssertEqual(r.state.items.last?.asAssistant?.text, "latest reply", "window tail untouched")
        XCTAssertEqual(r.state.items[2].asTool?.status, .ok, "a tool pair inside the page folds normally")
        XCTAssertEqual(r.state.oldestSeq, 1, "cursor moved back to the page's first event")
        XCTAssertEqual(r.state.maxSeq, 42, "high-water mark keeps the live window's")
        XCTAssertFalse(r.state.hasMoreOlder, "the page said history starts here")
        XCTAssertEqual(Set(r.state.items.map(\.id)).count, r.state.items.count,
                       "prepended synthetic ids must not collide with the parent's")
    }

    func testPrependOlderDiscardsHistoricalSideEffects() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("latest")])),
        ], hasMore: true))
        r.apply(RunEvent(seq: 50, type: .status, payload: .object(["status": .string("RUNNING")])))

        r.prependOlder(EventPage(events: [
            RunEvent(seq: 4, type: .user, payload: .object(["text": .string("earlier")])),
            RunEvent(seq: 5, type: .turnEnd, payload: .object(["status": .string("AWAITING_INPUT")])),
            RunEvent(seq: 6, type: .backgroundTask, payload: .object(["shellId": .string("bg9"),
                                                                      "status": .string("running")])),
        ], hasMore: true))

        XCTAssertEqual(r.state.status, .running, "a historical turn_end must not clobber the live status")
        XCTAssertTrue(r.state.background.isEmpty, "a historical background task must not resurrect the tray")
        XCTAssertEqual(r.state.items.compactMap { $0.asUser?.text }, ["earlier", "latest"])
        XCTAssertTrue(r.state.hasMoreOlder)
    }

    /// The open-bubble cursors are item indices; the graft must shift them or the next delta
    /// streams into a PREPENDED bubble (and the finalize overwrites it).
    func testPrependOlderShiftsOpenStreamingCursor() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("question")])),
        ], hasMore: true))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Hel")])))

        r.prependOlder(EventPage(events: [
            RunEvent(seq: 1, type: .user, payload: .object(["text": .string("old question")])),
            RunEvent(seq: 2, type: .assistant, payload: .object(["text": .string("old reply")])),
        ], hasMore: false))

        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("lo")])))
        r.apply(RunEvent(seq: 42, type: .assistant, payload: .object(["text": .string("Hello")])))

        XCTAssertEqual(r.state.items.count, 4, "user + assistant + user + ONE live bubble")
        XCTAssertEqual(r.state.items[1].asAssistant?.text, "old reply", "prepended bubble untouched")
        XCTAssertEqual(r.state.items.last?.asAssistant?.text, "Hello",
                       "the post-graft delta streams into the live bubble, not a prepended one")
    }

    func testPrependOlderDedupsAlreadyLoadedSeqs() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("latest")])),
        ], hasMore: true))
        r.prependOlder(EventPage(events: [
            RunEvent(seq: 40, type: .user, payload: .object(["text": .string("fresh older")])),
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("latest")])),   // overlap: already loaded
        ], hasMore: false))
        XCTAssertEqual(r.state.items.compactMap { $0.asUser?.text }, ["fresh older", "latest"])
        XCTAssertEqual(r.state.oldestSeq, 40)
    }

    func testPrependOlderEmptyPageStopsPaging() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .user, payload: .object(["text": .string("latest")])),
        ], hasMore: true))
        XCTAssertTrue(r.state.hasMoreOlder)

        r.prependOlder(EventPage(events: [], hasMore: true))
        XCTAssertFalse(r.state.hasMoreOlder, "an empty page can't advance the cursor — stop, don't loop")
        XCTAssertEqual(r.state.items.count, 1)
        XCTAssertEqual(r.state.oldestSeq, 41)
    }

    /// A page can end mid-tool-call (its result was folded — unmatched — before this page loaded,
    /// or hasn't happened yet). The grafted card stays running; a result that arrives AFTER the
    /// graft must close it, because closeTool scans all items including prepended ones.
    func testLiveResultClosesGraftedRunningCard() {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            RunEvent(seq: 41, type: .assistant, payload: .object(["text": .string("working…")])),
        ], hasMore: true))
        r.prependOlder(EventPage(events: [
            RunEvent(seq: 40, type: .toolUse, payload: .object(["toolUseId": .string("t1"),
                                                                "name": .string("Bash"),
                                                                "input": .object(["command": .string("sleep 99")])])),
        ], hasMore: false))
        XCTAssertEqual(r.state.items.first?.asTool?.status, .running)

        r.apply(RunEvent(seq: 42, type: .toolResult, payload: .object(["toolUseId": .string("t1"),
                                                                       "content": .string("done")])))
        XCTAssertEqual(r.state.items.first?.asTool?.status, .ok)
    }

    /// The server's authoritative list (GET .../background) is seeded via `seedBackground`. It must
    /// (1) surface shells the loaded window never held, (2) recover an agent shell's output that the
    /// live (broadcast-only) tail never persisted, and (3) NOT clobber the fresher live output/state of
    /// a shell the reducer already tracks — only advance a still-running row to the server's terminal
    /// state. Rows end up ordered by launch time. This is the reported iOS↔web mismatch, both halves.
    func testSeedBackgroundMergesCompleteListWithoutClobberingLive() {
        var r = TranscriptReducer()
        // Live state: one shell surfaced from its in-window launch, with a fresh live tail, still running.
        r.apply(RunEvent(seq: 7, type: .toolUse, payload: .object([
            "toolUseId": .string("tuLive"), "name": .string("Bash"),
            "input": .object(["command": .string("gh run watch"),
                              "description": .string("Watch beta.79 build (background)"),
                              "run_in_background": .bool(true)])])))
        r.apply(RunEvent(seq: 8, type: .toolResult, payload: .object([
            "toolUseId": .string("tuLive"),
            "content": .string("Command running in background with ID: shLive. Output written to: /t/shLive.output.")])))
        r.apply(RunEvent(seq: 0, type: .backgroundOutput, payload: .object([
            "toolUseId": .string("tuLive"), "content": .string("live tail fresh")])))
        XCTAssertEqual(r.state.background.count, 1)

        // Server snapshot: an OLDER shell the window never held (output recovered from its Read poll),
        // plus the live shell again but STALE — no output, already reported terminal.
        r.seedBackground([
            BackgroundProc(id: "tuOld", command: "watch pr ci", description: "Watch PR CI (background)",
                           status: "completed", outputTail: "recovered from Read poll",
                           startedAt: "2026-07-10T00:00:01Z"),
            BackgroundProc(id: "tuLive", command: "gh run watch",
                           description: "Watch beta.79 build (background)",
                           status: "completed", outputTail: "STALE server snapshot",
                           startedAt: "2026-07-10T09:00:00Z"),
        ])

        // ① The count grew to the full session history (the reported "8 vs 3").
        XCTAssertEqual(r.state.background.count, 2)
        // ② Ordered by launch — the older shell first.
        XCTAssertEqual(r.state.background.map(\.id), ["tuOld", "tuLive"])
        // ③ The older shell's recovered output surfaced (the reported "No output captured yet").
        let old = r.state.background.first { $0.id == "tuOld" }
        XCTAssertEqual(old?.outputTail, "recovered from Read poll")
        XCTAssertEqual(old?.status, "completed")
        // ④ The live shell KEEPS its fresh live tail (the stale server snapshot must not clobber it)…
        let live = r.state.background.first { $0.id == "tuLive" }
        XCTAssertEqual(live?.outputTail, "live tail fresh")
        // …but its status advances running → the server's terminal state.
        XCTAssertEqual(live?.status, "completed")
    }

    /// A seeded row that the live stream later settles must NOT be resurrected to "running" by a
    /// re-seed of an older (still-running) server snapshot — seedBackground only advances a row that is
    /// itself still running. Guards the reconnect re-seed path.
    func testSeedBackgroundNeverResurrectsASettledRow() {
        var r = TranscriptReducer()
        r.seedBackground([BackgroundProc(id: "tu", command: "c", description: nil,
                                         status: "completed", outputTail: "done", startedAt: "2026-07-10T00:00:01Z")])
        // A stale re-seed (snapshot taken before completion) says it's still running.
        r.seedBackground([BackgroundProc(id: "tu", command: "c", description: nil,
                                         status: "running", outputTail: "", startedAt: "2026-07-10T00:00:01Z")])
        XCTAssertEqual(r.state.background.first?.status, "completed", "a settled row is never resurrected")
    }

    /// A tool card carries the seq + `truncated` flag of BOTH the call and its result, so an
    /// expanded card knows which events to refetch whole (`APIClient.eventFull`). The two are
    /// separate events with separate seqs — mixing them up would fetch the wrong payload.
    func testToolCardRecordsWhatWasClippedAndWhere() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 11, type: .toolUse, payload: .object(["toolUseId": .string("t9"),
                                                                    "name": .string("Write"),
                                                                    "input": .object(["content": .string("first 2KB")])]),
                         truncated: true))
        r.apply(RunEvent(seq: 12, type: .toolResult, payload: .object(["toolUseId": .string("t9"),
                                                                       "content": .string("clipped output")]),
                         truncated: true))
        let card = r.state.items.last?.asTool
        XCTAssertEqual(card?.inputSeq, 11)
        XCTAssertEqual(card?.inputTruncated, true)
        XCTAssertEqual(card?.resultSeq, 12)
        XCTAssertEqual(card?.resultTruncated, true)
    }

    /// The common case: nothing was clipped, so no card ever asks for a refetch.
    func testUnclippedToolCardIsNotFlagged() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 3, type: .toolUse, payload: .object(["toolUseId": .string("t1"),
                                                                   "name": .string("Bash"),
                                                                   "input": .object(["command": .string("ls")])])))
        r.apply(RunEvent(seq: 4, type: .toolResult, payload: .object(["toolUseId": .string("t1"),
                                                                      "content": .string("a.txt")])))
        let card = r.state.items.last?.asTool
        XCTAssertEqual(card?.inputTruncated, false)
        XCTAssertEqual(card?.resultTruncated, false)
        XCTAssertEqual(card?.resultSeq, 4)
    }

    /// An engine that dies on startup says why only on stderr, carried by a `system` event. Dropping
    /// it left the turn a silent blank — the user re-sends, it fails identically, and nothing on
    /// screen ever says why (observed: seven "继续编辑" bubbles against seven swallowed
    /// "--dangerously-skip-permissions cannot be used with root/sudo privileges" lines).
    func testEngineStderrBecomesAnErrorRow() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, payload: .object(["text": .string("继续编辑")])))
        r.apply(RunEvent(seq: 2, type: .system, payload: .object([
            "stderr": .string("--dangerously-skip-permissions cannot be used with root/sudo privileges\n")])))
        XCTAssertEqual(r.state.items.count, 2)
        guard case .error(_, let message)? = r.state.items.last else {
            return XCTFail("expected an error row, got \(String(describing: r.state.items.last))")
        }
        XCTAssertEqual(message, "--dangerously-skip-permissions cannot be used with root/sudo privileges")
    }

    /// A `system` event with no stderr is lifecycle noise and still earns no row.
    func testSystemEventWithoutStderrStaysSilent() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .system, payload: .object(["subtype": .string("thinking_tokens")])))
        XCTAssertTrue(r.state.items.isEmpty)
    }

    /// Colour codes are stripped: events stored before the runner started stripping at the source
    /// still carry them, and the ESC byte would show as literal "[31m" garbage.
    func testEngineStderrIsStrippedOfAnsi() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .system, payload: .object([
            "stderr": .string("\u{1B}[31mError: Session ID abc is already in use.\u{1B}[0m\n")])))
        guard case .error(_, let message)? = r.state.items.last else { return XCTFail("expected an error row") }
        XCTAssertEqual(message, "Error: Session ID abc is already in use.")
    }

    /// The one line that says nothing about the session: Claude Code warns about connectors on every
    /// start when an auth token is in its environment — which is how every configured provider
    /// (DeepSeek, …) borrows the claude runtime, so each of those sessions would open on a red row.
    func testBenignConnectorWarningIsNotAnError() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .system, payload: .object([
            "stderr": .string("⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set")])))
        XCTAssertTrue(r.state.items.isEmpty)
    }

    /// A repeat folds into the first row as a count — an engine re-reporting one line per request
    /// would otherwise fill the transcript with identical rows. Folded on the line minus its leading
    /// timestamp, since the runtimes that log at all stamp every line.
    func testRepeatedEngineStderrFoldsIntoOneRow() {
        var r = TranscriptReducer()
        for (i, ts) in ["2026-08-12T17:24:09.394Z", "2026-08-12T17:24:12.214Z", "2026-08-12T17:24:15.774Z"].enumerated() {
            r.apply(RunEvent(seq: i + 1, type: .system,
                             payload: .object(["stderr": .string("\(ts) custom tool call output is missing")])))
        }
        XCTAssertEqual(r.state.items.count, 1, "three occurrences of one line take one row")
        guard case .error(_, let message)? = r.state.items.first else { return XCTFail("expected an error row") }
        XCTAssertEqual(message, "2026-08-12T17:24:09.394Z custom tool call output is missing ×3")
    }

    /// An API error arrives as an ordinary assistant reply with a `success` result, so a transcript
    /// that trusts the event type renders the agent apparently answering "API Error: 400". One we
    /// cannot place stays a plain error line — a re-send would reproduce it.
    func testApiErrorReplyBecomesAnErrorRowNotABubble() {
        var r = TranscriptReducer()
        let text = "API Error: 400 {\"type\":\"invalid_request_error\",\"message\":\"prompt is too long\"}"
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object(["text": .string(text)])))
        XCTAssertEqual(r.state.items.count, 1)
        guard case .error(_, let message)? = r.state.items.first else {
            return XCTFail("expected an error row, got \(String(describing: r.state.items.first))")
        }
        XCTAssertEqual(message, text)
    }

    /// The text that streamed in as a reply must not survive alongside the row that reclassifies it,
    /// or the failure shows twice — once as prose, once as the error.
    func testStreamedApiErrorLeavesNoAssistantBubbleBehind() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("API Error: 529 ")])))
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string("Overloaded")])))
        // The durable `assistant` event carries no text of its own — it finalizes what streamed.
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object(["text": .string("")])))
        XCTAssertEqual(r.state.items.count, 1)
        guard case .autoRetry(let n)? = r.state.items.first else {
            return XCTFail("expected an auto-retry card, got \(String(describing: r.state.items.first))")
        }
        XCTAssertEqual(n.variant, .apiError)
        XCTAssertEqual(n.message, "API Error: 529 Overloaded")
    }

    /// A spent quota and an overloaded provider both fix themselves — they earn the card carrying
    /// the pending retry, not a bare error line the reader can only stare at.
    func testSelfHealingFailuresBecomeAutoRetryCards() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, payload: .object(["text": .string("keep going")])))
        r.apply(RunEvent(seq: 2, type: .assistant, payload: .object([
            "text": .string("You've hit your session limit · resets 6:20pm (Europe/Berlin)")])))
        guard case .autoRetry(let n)? = r.state.items.last else { return XCTFail("expected a quota card") }
        XCTAssertEqual(n.variant, .quota)
        XCTAssertFalse(n.stale)
        XCTAssertTrue(n.afterUserMsg, "the message it would re-send is the line directly above")
    }

    /// The next user message — the retry firing, a manual retry, or the user typing something else —
    /// settles the outage. Without this the card of a failure the session recovered from would keep
    /// its countdown, and (the armed retry being cleared once it fires) read as "switched off".
    func testNextUserMessageSettlesTheLiveCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object([
            "text": .string("API Error: 529 Overloaded")])))
        r.apply(RunEvent(seq: 2, type: .user, payload: .object(["text": .string("keep going")])))
        guard case .autoRetry(let n)? = r.state.items.first else { return XCTFail("expected a card") }
        XCTAssertTrue(n.stale, "the session went on — this outage is over")
    }

    /// Only the newest card describes a live situation. A second outage stales the first, so two
    /// countdowns for one armed retry can never be on screen at once.
    func testASecondOutageStalesTheFirstCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object([
            "text": .string("API Error: 529 Overloaded")])))
        r.apply(RunEvent(seq: 2, type: .user, payload: .object(["text": .string("again")])))
        r.apply(RunEvent(seq: 3, type: .assistant, payload: .object([
            "text": .string("API Error: 503 Service Unavailable")])))
        let cards = r.state.items.compactMap { item -> AutoRetryNotice? in
            if case .autoRetry(let n) = item { return n }
            return nil
        }
        XCTAssertEqual(cards.count, 2)
        XCTAssertTrue(cards[0].stale)
        XCTAssertFalse(cards[1].stale, "the newest card is the live one")
    }

    /// The terminal `status` the server broadcasts when a turn is finalized (a spent quota, the
    /// reaper) rides `RunEvent.sentinelSeq`. Letting it advance the reconnect cursor is how a
    /// session goes permanently blind: every later reconnect asks for `?sinceSeq=2^53-1`, the
    /// server's `seq > sinceSeq` replay returns nothing, and whatever ran while the app wasn't
    /// watching live is never seen. It must still apply the status.
    func testTerminalStatusBroadcastDoesNotMoveTheReconnectCursor() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 41, type: .user, payload: .object(["text": .string("/upgrade")])))
        r.apply(RunEvent(seq: 42, type: .assistant, payload: .object([
            "text": .string("You've hit your weekly limit · resets 6am (Europe/Berlin)")])))
        r.apply(RunEvent(seq: RunEvent.sentinelSeq, type: .status,
                         payload: .object(["status": .string("FAILED"), "final": .bool(true)])))

        XCTAssertEqual(r.state.status, .failed, "the finalization still lands")
        XCTAssertEqual(r.state.maxSeq, 42, "reconnect cursor stays on the last real event")
        XCTAssertEqual(r.state.oldestSeq, 41, "scroll-up cursor stays on the last real event")

        // The retry the user then sends must fold normally — the sentinel didn't poison dedup.
        r.apply(RunEvent(seq: 43, type: .user, payload: .object(["text": .string("/upgrade")])))
        XCTAssertEqual(r.state.maxSeq, 43)
    }

    /// A reply that merely quotes a limit is an ordinary reply — rendering it as the provider
    /// refusing to answer would replace it with a card saying the opposite of what it says.
    func testAReplyAboutAQuotaStaysAReply() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .assistant, payload: .object([
            "text": .string("I checked: the run died because the account had hit your usage limit.")])))
        XCTAssertNotNil(r.state.items.first?.asAssistant, "expected a normal assistant bubble")
    }
}

// Test-only convenience accessors (kept out of the library surface).
extension TranscriptItem {
    var asUser: UserBubble? { if case .user(let b) = self { return b }; return nil }
    var asAssistant: AssistantBubble? { if case .assistant(let b) = self { return b }; return nil }
    var asTool: ToolCard? { if case .toolCall(let c) = self { return c }; return nil }
}
