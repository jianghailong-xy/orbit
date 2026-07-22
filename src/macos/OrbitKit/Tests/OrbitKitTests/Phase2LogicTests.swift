import XCTest
@testable import OrbitKit

final class Phase2LogicTests: XCTestCase {

    // MARK: bash prefix (mirrors the web's bashPrefix)

    func testBashPrefix() {
        XCTAssertEqual(Approvals.bashPrefix("git commit -m \"x\""), "git commit")
        XCTAssertEqual(Approvals.bashPrefix("ls -la"), "ls")
        XCTAssertEqual(Approvals.bashPrefix("FOO=bar git push"), "git push")   // skip env assignment
        XCTAssertEqual(Approvals.bashPrefix("  npm   test  "), "npm test")      // collapse whitespace
        XCTAssertEqual(Approvals.bashPrefix("./script.sh --flag"), "./script.sh") // flag isn't a subcmd
        XCTAssertEqual(Approvals.bashPrefix("git -C /repo status"), "git")      // -C isn't a subcmd word
        XCTAssertNil(Approvals.bashPrefix("   "))
        XCTAssertNil(Approvals.bashPrefix("|| true"))                           // no clean program word
    }

    // MARK: remember-rule

    func testRememberRule() {
        let bash = Approvals.rememberRule(toolName: "Bash",
                                          input: .object(["command": .string("git commit -m x")]))
        XCTAssertEqual(bash, PermissionRule(toolName: "Bash", ruleContent: "git commit:*"))
        XCTAssertEqual(bash.map(Approvals.rememberLabel), "git commit")

        XCTAssertNil(Approvals.rememberRule(toolName: "AskUserQuestion", input: .null))
        XCTAssertNil(Approvals.rememberRule(toolName: "ExitPlanMode", input: .null))
        XCTAssertNil(Approvals.rememberRule(toolName: "Bash",
                                            input: .object(["command": .string("|| true")])))

        let edit = Approvals.rememberRule(toolName: "Edit", input: .null)
        XCTAssertEqual(edit, PermissionRule(toolName: "Edit"))
        XCTAssertEqual(edit.map(Approvals.rememberLabel), "Edit")
    }

    // MARK: AskUserQuestion parsing

    func testParseQuestions() {
        let input: JSONValue = .object([
            "questions": .array([
                .object([
                    "header": .string("Auth method"),
                    "question": .string("Which auth?"),
                    "multiSelect": .bool(false),
                    "options": .array([
                        .object(["label": .string("JWT"), "description": .string("stateless")]),
                        .object(["label": .string("Session"), "description": .string("cookie")]),
                    ]),
                ]),
            ]),
        ])
        let qs = Approvals.parseQuestions(from: input)
        XCTAssertEqual(qs.count, 1)
        XCTAssertEqual(qs[0].header, "Auth method")
        XCTAssertEqual(qs[0].question, "Which auth?")
        XCTAssertFalse(qs[0].multiSelect)
        XCTAssertEqual(qs[0].options.map(\.label), ["JWT", "Session"])
        XCTAssertEqual(qs[0].options[0].description, "stateless")

        XCTAssertTrue(Approvals.parseQuestions(from: .object(["foo": .string("bar")])).isEmpty)
    }

    // MARK: approval kind classification (keyed on toolName — data is nested under `input`)

    func testApprovalKind() {
        XCTAssertEqual(Approvals.kind(toolName: "AskUserQuestion"), .question)
        XCTAssertEqual(Approvals.kind(toolName: "ExitPlanMode"), .plan)
        XCTAssertEqual(Approvals.kind(toolName: "Bash"), .tool)
        XCTAssertEqual(Approvals.kind(toolName: "Edit"), .tool)
        XCTAssertEqual(Approvals.kind(toolName: nil), .tool)
    }

    // MARK: AskUserQuestion answers — picked options + free text

    private func q(_ text: String, _ labels: [String], multi: Bool = false, header: String? = nil) -> AskQuestion {
        AskQuestion(header: header, question: text,
                    options: labels.map { AskOption(label: $0, description: nil) }, multiSelect: multi)
    }

    func testAnswersCombinePicksAndFreeText() {
        let qs = [q("Q1", ["A", "B"]), q("Q2", ["X"], multi: true)]

        // Nothing picked/typed → incomplete.
        XCTAssertFalse(Approvals.allAnswered(qs, selections: [:], custom: [:]))

        // Q1 picks an option; Q2 picks an option AND appends trimmed free text (multi-select).
        let sel: [String: Set<String>] = ["Q1": ["A"], "Q2": ["X"]]
        let custom = ["Q2": "  extra  "]
        XCTAssertTrue(Approvals.allAnswered(qs, selections: sel, custom: custom))
        let answers = Approvals.buildAnswers(qs, selections: sel, custom: custom)
        XCTAssertEqual(answers["Q1"], ["A"])
        XCTAssertEqual(Set(answers["Q2"] ?? []), ["X", "extra"])   // Set source → order-agnostic
    }

    func testFreeTextAloneAnswersAQuestion() {
        let qs = [q("Q1", ["A"])]
        XCTAssertTrue(Approvals.isAnswered(question: "Q1", selections: [:], custom: ["Q1": "typed"]))
        XCTAssertEqual(Approvals.buildAnswers(qs, selections: [:], custom: ["Q1": "typed"])["Q1"], ["typed"])
        // Whitespace-only text doesn't count, and a blank question is skipped from the payload.
        XCTAssertFalse(Approvals.isAnswered(question: "Q1", selections: [:], custom: ["Q1": "   "]))
        XCTAssertTrue(Approvals.buildAnswers(qs, selections: [:], custom: ["Q1": "   "]).isEmpty)
    }

    func testChatReplyLabel() {
        XCTAssertEqual(Approvals.chatReplyLabel([q("Which?", [], header: "Auth method")]), "Auth method")
        XCTAssertEqual(Approvals.chatReplyLabel([q("Which?", [])]), "Which?")   // no header → question
        XCTAssertEqual(Approvals.chatReplyLabel([]), "")
    }

    // MARK: composer gating

    func testSendAvailability() {
        XCTAssertEqual(ComposerLogic.availability(status: .awaitingInput), .sendNow)
        XCTAssertEqual(ComposerLogic.availability(status: .running), .queue)
        XCTAssertEqual(ComposerLogic.availability(status: .pending), .queue)
        XCTAssertEqual(ComposerLogic.availability(status: .succeeded), .sendNow)
        XCTAssertTrue(ComposerLogic.shouldResume(status: .parked))
        XCTAssertFalse(ComposerLogic.shouldResume(status: .awaitingInput))
    }

    func testReconcileStatus() {
        // The bug: the stream missed the (un-replayable) terminal broadcast and still looks
        // live, but the server says the session ended — trust the server so the composer resumes
        // instead of 409-ing on POST /turns.
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .awaitingInput, server: .parked), .parked)
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .running, server: .succeeded), .succeeded)
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .interrupted, server: .cancelled), .cancelled)
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .running, server: .parked), .parked)
        // Only upgrades toward terminal: a stale terminal/non-terminal snapshot never overrides a
        // freshly-live stream (e.g. a resume just re-spawned the session, so the server is PENDING).
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .running, server: .pending), .running)
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .awaitingInput, server: .running), .awaitingInput)
        // No server status (not yet fetched) → keep the stream status verbatim.
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .awaitingInput, server: nil), .awaitingInput)
        // Both terminal → the stream's own terminal value stands (no spurious change).
        XCTAssertEqual(ComposerLogic.reconcileStatus(stream: .succeeded, server: .parked), .succeeded)
    }

    func testIsLive() {
        // Live (config edits PATCH immediately) = the non-terminal set, the complement of shouldResume.
        for s in [RunStatus.running, .pending, .awaitingInput, .interrupted] {
            XCTAssertTrue(ComposerLogic.isLive(status: s), "\(s) should be live")
        }
        for s in [RunStatus.succeeded, .failed, .cancelled, .parked] {
            XCTAssertFalse(ComposerLogic.isLive(status: s), "\(s) should not be live")
        }
    }

    func testShowsInterrupt() {
        // Convenience: the idle-composer case (nothing staged to send), which is when the single
        // button morphs to Stop.
        func idle(session: RunStatus?, stream: RunStatus) -> Bool {
            ComposerLogic.showsInterrupt(session: session, stream: stream,
                                         hasText: false, hasAttachments: false, replying: false)
        }
        // The authoritative session status wins: a running session morphs to Stop even when the
        // stream status is stale — the exact cold-open case (opening an already-running session
        // never replays a `.running` event into the reducer, so the old `state.status`-only gate
        // hid the button and interrupting was impossible).
        XCTAssertTrue(idle(session: .running, stream: .awaitingInput))
        XCTAssertTrue(idle(session: .running, stream: .pending))
        XCTAssertTrue(idle(session: .running, stream: .running))
        // A non-running authoritative status stays Send, even if the stream is a stale `.running`
        // (e.g. the turn just ended but the reducer missed the un-replayed terminal transition).
        XCTAssertFalse(idle(session: .awaitingInput, stream: .running))
        XCTAssertFalse(idle(session: .parked, stream: .running))
        // No session record yet (a fresh deep link before the list loads): fall back to the stream.
        XCTAssertTrue(idle(session: nil, stream: .running))
        XCTAssertFalse(idle(session: nil, stream: .awaitingInput))

        // Anything staged to send keeps it a Send button (web parity) so a follow-up queues mid-turn,
        // even while the session is running.
        XCTAssertFalse(ComposerLogic.showsInterrupt(session: .running, stream: .running,
                                                    hasText: true, hasAttachments: false, replying: false))
        XCTAssertFalse(ComposerLogic.showsInterrupt(session: .running, stream: .running,
                                                    hasText: false, hasAttachments: true, replying: false))
        XCTAssertFalse(ComposerLogic.showsInterrupt(session: .running, stream: .running,
                                                    hasText: false, hasAttachments: false, replying: true))
    }

    func testWillQueue() {
        // The authoritative session status wins: a send during a running (or still-PENDING) turn is
        // queued → "Queued", even when the stream-reconciled status is a stale `.awaitingInput` — the
        // exact cold-open case (opening an already-running session never replays a `.running` event,
        // so the old `sessionStatus`-only gate mislabeled it "Sending…" and split the reply).
        XCTAssertTrue(ComposerLogic.willQueue(authoritative: .running, reconciled: .awaitingInput))
        XCTAssertTrue(ComposerLogic.willQueue(authoritative: .pending, reconciled: .awaitingInput))
        XCTAssertTrue(ComposerLogic.willQueue(authoritative: .running, reconciled: .running))
        // A non-queueing authoritative status delivers now (→ "Sending…"/inline), even if the stream
        // is a stale `.running` (the turn just ended but the reducer missed the un-replayed terminal).
        XCTAssertFalse(ComposerLogic.willQueue(authoritative: .awaitingInput, reconciled: .running))
        XCTAssertFalse(ComposerLogic.willQueue(authoritative: .succeeded, reconciled: .running))
        // No session record yet (a fresh deep link before the list loads): fall back to the reconciled
        // stream status.
        XCTAssertTrue(ComposerLogic.willQueue(authoritative: nil, reconciled: .running))
        XCTAssertTrue(ComposerLogic.willQueue(authoritative: nil, reconciled: .pending))
        XCTAssertFalse(ComposerLogic.willQueue(authoritative: nil, reconciled: .awaitingInput))
        XCTAssertFalse(ComposerLogic.willQueue(authoritative: nil, reconciled: .parked))
    }

    func testEffortLabelsAndWire() {
        XCTAssertEqual(Effort.allCases, [.default, .minimal, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(Effort.allCases.map(\.label),
                       ["Default", "Minimal", "Low", "Medium", "High", "xHigh", "Max"])
        XCTAssertNil(Effort.default.wire)              // Default omits --effort
        XCTAssertEqual(Effort.max.wire, "max")
        XCTAssertEqual(Effort.xhigh.rawValue, "xhigh") // wire/raw match the CLI value
    }

    func testPlanUsageRows() {
        let u = PlanUsage(fiveHour: .init(utilization: 12.4, resetsAt: "2026-06-26T10:00:00Z"),
                          sevenDay: nil,
                          sevenDayOpus: .init(utilization: 91.6, resetsAt: nil),
                          sevenDaySonnet: nil, fetchedAt: nil)
        // Absent windows are skipped; present ones keep /usage order (5-hour first).
        XCTAssertEqual(u.rows.map(\.key), ["fiveHour", "sevenDayOpus"])
        XCTAssertEqual(u.rows.map(\.percent), [12, 92])
        XCTAssertEqual(u.primaryPercent, 12)           // binding window = 5-hour
        XCTAssertNil(PlanUsage(fiveHour: nil, sevenDay: nil, sevenDayOpus: nil,
                               sevenDaySonnet: nil, fetchedAt: nil).primaryPercent)

        let codex = PlanUsage(provider: "codex", rateLimits: [
            PlanUsageRateLimit(limitId: "codex",
                               primary: .init(utilization: 22, windowDurationMins: 300),
                               secondary: .init(utilization: 35, windowDurationMins: 10_080)),
            PlanUsageRateLimit(limitId: "codex-other",
                               primary: .init(utilization: 90, windowDurationMins: 60))
        ])
        XCTAssertEqual(codex.rows.map(\.label), ["5h limit", "Weekly limit", "codex-other Usage limit"])
        XCTAssertEqual(codex.rows.map(\.percent), [22, 35, 90])
    }

    func testMakeTurn() {
        let msg = ComposerLogic.makeTurn(clientTurnId: "c1", text: "hi", shell: false, attachmentIds: [])
        XCTAssertEqual(msg.kind, "message")
        XCTAssertNil(msg.attachmentIds)

        let shell = ComposerLogic.makeTurn(clientTurnId: "c2", text: "ls", shell: true, attachmentIds: ["a1"])
        XCTAssertEqual(shell.kind, "shell")
        XCTAssertEqual(shell.attachmentIds, ["a1"])
    }

    func testParseShell() {
        // Plain text: not a shell command, trimmed.
        XCTAssertEqual(ComposerLogic.parseShell("  hello  ").text, "hello")
        XCTAssertFalse(ComposerLogic.parseShell("hello").shell)
        // `!`-prefixed: shell command with the bang stripped and re-trimmed.
        let cmd = ComposerLogic.parseShell("  !ls -la ")
        XCTAssertTrue(cmd.shell)
        XCTAssertEqual(cmd.text, "ls -la")
        // A bare `!` is a shell no-op (empty text), so send() clears without dispatching.
        let bare = ComposerLogic.parseShell("!")
        XCTAssertTrue(bare.shell)
        XCTAssertEqual(bare.text, "")
    }

    // MARK: `/` autocomplete (mirrors the web composer's slash menu)

    func testSlashToken() {
        XCTAssertNil(ComposerSlash.token(in: ""))
        XCTAssertNil(ComposerSlash.token(in: "hello"))
        XCTAssertNil(ComposerSlash.token(in: "hello/foo"))      // `/` not at a word boundary
        XCTAssertNil(ComposerSlash.token(in: "/foo bar"))       // token isn't the trailing word
        XCTAssertEqual(ComposerSlash.token(in: "/"), "")
        XCTAssertEqual(ComposerSlash.token(in: "/foo"), "foo")
        XCTAssertEqual(ComposerSlash.token(in: "hello /com"), "com")
        XCTAssertEqual(ComposerSlash.token(in: "hi\n/de"), "de") // newline counts as whitespace
    }

    func testSlashScopedAndMatches() {
        let items = [
            SlashCommandInfo(name: "status", description: nil, type: "local", agentId: nil),
            SlashCommandInfo(name: "commit", description: nil, type: "command", agentId: nil),
            SlashCommandInfo(name: "deploy", description: nil, type: "command", agentId: "a1"),
            SlashCommandInfo(name: "review", description: nil, type: "skill", agentId: "a2"),
            SlashCommandInfo(name: "compose", description: nil, type: "skill", agentId: nil),
        ]
        // host-level + this agent's assets only
        let scoped = ComposerSlash.scoped(items: items, agentID: "a1")
        XCTAssertEqual(scoped.map(\.name).sorted(), ["commit", "compose", "deploy", "status"])

        // prefix-matches sort ahead of substring matches; capped to scope
        let m = ComposerSlash.matches(items: scoped, token: "com", scope: nil)
        XCTAssertEqual(m.map(\.name), ["commit", "compose"])

        let onlyCommands = ComposerSlash.matches(items: scoped, token: "", scope: "command")
        XCTAssertEqual(onlyCommands.map(\.name).sorted(), ["commit", "deploy"])

        let local = ComposerSlash.matches(items: scoped, token: "sta", scope: nil)
        XCTAssertEqual(local.map(\.name), ["status"])

        XCTAssertTrue(ComposerSlash.matches(items: scoped, token: nil, scope: nil).isEmpty)
    }

    func testHostSlashCommandParsingAndStatusSummary() {
        XCTAssertNil(ComposerHostCommand.commandName(in: "hello /status"))
        XCTAssertEqual(ComposerHostCommand.commandName(in: "/status"), "status")
        XCTAssertEqual(ComposerHostCommand.commandName(in: " /status now "), "status")
        XCTAssertEqual(ComposerHostCommand.commandName(in: "/"), "")
        XCTAssertTrue(ComposerHostCommand.isLocal("STATUS"))

        let rows = ComposerHostCommand.statusRows(ComposerStatusSnapshot(
            surface: "App", sessionTitle: "Current session", sessionStatus: "RUNNING",
            model: "gpt-5.6-sol", effort: "", contextTokens: 94_500, contextWindow: 372_000,
            planUsageLabel: "Primary limit", planUsagePercent: 41))
        XCTAssertTrue(rows.contains(ComposerStatusRow(label: "Context", value: "25% (95k / 372k tokens)")))
        XCTAssertTrue(rows.contains(ComposerStatusRow(label: "Reasoning", value: "Default")))

        let codexRows = ComposerHostCommand.statusRows(ComposerStatusSnapshot(
            surface: "App", planUsageLabel: "5h limit", planUsagePercent: 22))
        XCTAssertTrue(codexRows.contains(ComposerStatusRow(label: "Plan usage", value: "5h limit 22%")))

        let unreported = ComposerHostCommand.statusRows(ComposerStatusSnapshot(surface: "App"))
        XCTAssertTrue(unreported.contains(ComposerStatusRow(label: "Context", value: "not reported yet")))
    }

    func testSlashPickAndOpening() {
        XCTAssertEqual(ComposerSlash.pick(text: "/com", name: "commit"), "/commit ")
        XCTAssertEqual(ComposerSlash.pick(text: "hello /com", name: "commit"), "hello /commit ")
        XCTAssertEqual(ComposerSlash.pick(text: "no token", name: "commit"), "no token")

        XCTAssertEqual(ComposerSlash.opening(text: ""), "/")
        XCTAssertEqual(ComposerSlash.opening(text: "hi "), "hi /")
        XCTAssertEqual(ComposerSlash.opening(text: "hi"), "hi /")
    }

    // MARK: attachment limits

    func testAttachmentLimits() {
        XCTAssertTrue(Attachments.isInlineImage(mimeType: "image/png"))
        XCTAssertFalse(Attachments.isInlineImage(mimeType: "application/pdf"))
        XCTAssertNil(Attachments.rejectReason(mimeType: "image/png", byteCount: 1_000))
        XCTAssertEqual(Attachments.rejectReason(mimeType: "image/png", byteCount: 0), "File is empty")
        XCTAssertEqual(Attachments.rejectReason(mimeType: "image/png", byteCount: 6 * 1024 * 1024),
                       "Image exceeds the 5MB limit")
        XCTAssertEqual(Attachments.rejectReason(mimeType: "application/zip", byteCount: 26 * 1024 * 1024),
                       "File exceeds the 25MB limit")
        XCTAssertNil(Attachments.rejectReason(mimeType: "application/zip", byteCount: 20 * 1024 * 1024))
    }

    // MARK: multipart

    func testMultipartBody() {
        let body = Multipart.body(boundary: "B", fieldName: "file", filename: "a.png",
                                  mimeType: "image/png", fileData: Data("PNG".utf8))
        let s = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(s.hasPrefix("--B\r\n"))
        XCTAssertTrue(s.contains("Content-Disposition: form-data; name=\"file\"; filename=\"a.png\""))
        XCTAssertTrue(s.contains("Content-Type: image/png\r\n\r\n"))
        XCTAssertTrue(s.contains("PNG"))
        XCTAssertTrue(s.hasSuffix("\r\n--B--\r\n"))
    }

    // MARK: diff decode + defaults

    func testFilePatchDecode() throws {
        let json = #"{"patches":[{"path":"a.swift","patch":"@@ -1 +1 @@","truncated":false},{"path":"b.txt"}]}"#
        let diff = try JSONDecoder().decode(SessionDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.patches.count, 2)
        XCTAssertEqual(diff.patches[0].path, "a.swift")
        XCTAssertEqual(diff.patches[0].truncated, false)
        XCTAssertNil(diff.patches[1].patch)
    }

    func testAgentDefaults() {
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-4-8"), "Opus 4.8")
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
        XCTAssertEqual(AgentDefaults.label(.bypass), "Bypass")
        XCTAssertEqual(AgentDefaults.defaultModelID, "claude-opus-4-8")
    }

    func testSessionDecodesStoredConfigAndResumeEncodesEffort() throws {
        let json = #"{"id":"s1","status":"RUNNING","model":"claude-sonnet-4-6","permissionMode":"plan","effort":"high","agent":{"id":"a1","name":"claude"}}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.model, "claude-sonnet-4-6")
        XCTAssertEqual(s.permissionMode, "plan")
        XCTAssertEqual(s.effort, "high")
        XCTAssertEqual(s.agent?.name, "claude")

        // Reviving carries effort; Default ("") would omit it via Effort.wire == nil.
        let data = try JSONEncoder().encode(
            ResumeRequest(clientTurnId: "c1", content: "go", model: "m", permissionMode: "auto", effort: "max"))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"effort\":\"max\""))
    }

    /// Reviving a dormant session must carry staged image ids so the server links them to the
    /// reviving turn (else the image is dropped and only the text survives). A text-only resume
    /// omits the key via synthesized `encodeIfPresent`.
    func testResumeEncodesAttachmentIds() throws {
        let withImages = try jsonObject(
            ResumeRequest(clientTurnId: "c1", content: "look", attachmentIds: ["att-1", "att-2"]))
        XCTAssertEqual(withImages["attachmentIds"] as? [String], ["att-1", "att-2"])

        let textOnly = try jsonObject(ResumeRequest(clientTurnId: "c1", content: "hi"))
        XCTAssertFalse(textOnly.keys.contains("attachmentIds"), "text-only resume must omit attachmentIds")
    }
}
