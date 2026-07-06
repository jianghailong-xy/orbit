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

    /// The tray title comes from the launching Bash(run_in_background) tool_use — the background_task
    /// completion event carries no command. Prefer the human `description` when present (web parity).
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
        XCTAssertEqual(r.state.background.first?.command, "wait then greet",
                       "description preferred over the raw command")
        XCTAssertEqual(r.state.background.first?.status, "completed")
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

    /// An interrupt drops queued follow-ups server-side, so the durable `interrupt` event clears the
    /// local queue too — otherwise a queued bubble would linger with no `user` event to reconcile it.
    func testInterruptClearsQueue() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "queued one", queued: true)
        XCTAssertEqual(r.state.queued.count, 1)
        r.apply(RunEvent(seq: 5, type: .interrupt, payload: .object([:])))
        XCTAssertTrue(r.state.queued.isEmpty)
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
}

// Test-only convenience accessors (kept out of the library surface).
extension TranscriptItem {
    var asUser: UserBubble? { if case .user(let b) = self { return b }; return nil }
    var asAssistant: AssistantBubble? { if case .assistant(let b) = self { return b }; return nil }
    var asTool: ToolCard? { if case .toolCall(let c) = self { return c }; return nil }
}
