import XCTest
@testable import OrbitKit

/// Ports the web `sessionLine` cases: the Agent-console list's second line.
final class SessionLineTests: XCTestCase {
    private func session(status: RunStatus, lastAssistantText: String? = nil, lastToolUse: String? = nil,
                         lastUserText: String? = nil, runningBgCount: Int? = nil,
                         engineTurnActive: Bool? = nil,
                         pendingApprovals: Int? = nil, endReason: String? = nil,
                         recapText: String? = nil, recapAt: String? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: lastAssistantText, lastToolUse: lastToolUse, lastUserText: lastUserText,
                recapText: recapText, recapAt: recapAt,
                runningBgCount: runningBgCount, engineTurnActive: engineTurnActive, endReason: endReason)
    }

    /// A turn the runtime started for itself — a background task reporting in, a scheduled
    /// wake-up — never reaches the control plane's turn bookkeeping, so the session stays parked
    /// at AWAITING_INPUT while it streams. The row has to say what it is doing rather than fall
    /// through to the previous reply, which reads as idle. (Ports the web case of the same name.)
    func testSelfDrivenTurnReadsAsWorkingNotParked() {
        let tool = session(status: .awaitingInput,
                           lastAssistantText: "Waiting for the completion notification.",
                           lastToolUse: "Bash", engineTurnActive: true)
        XCTAssertEqual(SessionLine.make(for: tool, live: true), .init(text: "Running Bash…", tone: .running))

        // Between tools there is no frontier tool, and the stale reply would read as idle.
        let bare = session(status: .awaitingInput, engineTurnActive: true)
        XCTAssertEqual(SessionLine.make(for: bare, live: true), .init(text: "Running…", tone: .running))

        // A self-driven turn is the agent itself working, so it outranks a left-up background
        // process — which is not.
        let overBackground = session(status: .awaitingInput, runningBgCount: 2, engineTurnActive: true)
        XCTAssertEqual(SessionLine.make(for: overBackground, live: true),
                       .init(text: "Running…", tone: .running))

        // Once the turn ends the server clears the flag and the reply preview takes over again.
        let done = session(status: .awaitingInput, lastAssistantText: "All done.", engineTurnActive: false)
        XCTAssertEqual(SessionLine.make(for: done, live: true), .init(text: "All done.", tone: .preview))
    }

    func testRunningPrioritisesApprovalThenToolThenPreview() {
        let approval = session(status: .running, lastToolUse: "Bash", pendingApprovals: 2)
        XCTAssertEqual(SessionLine.make(for: approval, live: true), .init(text: "Waiting for approval", tone: .approval))

        let tool = session(status: .running, lastAssistantText: "hi", lastToolUse: "mcp__orbit__task_create")
        XCTAssertEqual(SessionLine.make(for: tool, live: true), .init(text: "Running task_create…", tone: .running))

        let preview = session(status: .running, lastAssistantText: "Working on it")
        XCTAssertEqual(SessionLine.make(for: preview, live: true), .init(text: "Working on it", tone: .preview))

        let bare = session(status: .running)
        XCTAssertEqual(SessionLine.make(for: bare, live: true), .init(text: "Running…", tone: .running))
    }

    /// A turn is running but the agent hasn't answered yet: the row shows the message you sent —
    /// marked as yours, since unmarked it reads exactly like a reply to it — not the previous
    /// turn's reply. A tool/approval frontier still outranks it.
    func testRunningShowsPendingUserMessageBeforeStaleReply() {
        let awaiting = session(status: .running, lastAssistantText: "previous reply",
                               lastUserText: "fix the drawer shadow")
        XCTAssertEqual(SessionLine.make(for: awaiting, live: true),
                       .init(text: "You: fix the drawer shadow", tone: .preview))

        // Once the agent picks up a tool, the tool status wins over the pending message.
        let tooling = session(status: .running, lastToolUse: "Bash", lastUserText: "fix the drawer shadow")
        XCTAssertEqual(SessionLine.make(for: tooling, live: true), .init(text: "Running Bash…", tone: .running))

        // Markdown in the sent message is flattened, like a reply preview.
        let md = session(status: .running, lastUserText: "please `run` the **tests**")
        XCTAssertEqual(SessionLine.make(for: md, live: true).text, "You: please run the tests")
    }

    func testPendingAndBackground() {
        XCTAssertEqual(SessionLine.make(for: session(status: .pending), live: true),
                       .init(text: "Queued", tone: .queued))
        // Muted, not the working blue: the process outlives the turn but isn't the agent working.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, runningBgCount: 2), live: true),
                       .init(text: "2 background processes running…", tone: .background))
    }

    func testParkedShowsLastReplyAndStripsMarkdown() {
        let parked = session(status: .awaitingInput,
                             lastAssistantText: "## Done\n\nFixed the `Session` model and ran ```swift\ntest()\n``` — all green.")
        let line = SessionLine.make(for: parked, live: true)
        XCTAssertEqual(line.tone, .preview)
        XCTAssertEqual(line.text, "Done Fixed the Session model and ran — all green.")
    }

    /// A turn interrupted before any reply leaves the message you sent standing (the server only
    /// clears it once the agent actually answers), and it outranks the older reply below it.
    func testInterruptedTurnShowsTheUnansweredMessage() {
        let interrupted = session(status: .interrupted, lastAssistantText: "previous reply",
                                  lastUserText: "设置按钮的底色很奇怪，请帮我 review")
        XCTAssertEqual(SessionLine.make(for: interrupted, live: true),
                       .init(text: "You: 设置按钮的底色很奇怪，请帮我 review", tone: .preview))

        // A process left up outranks it — that's live status, not history.
        let bg = session(status: .awaitingInput, lastUserText: "run the tests", runningBgCount: 1)
        XCTAssertEqual(SessionLine.make(for: bg, live: true),
                       .init(text: "Background process running…", tone: .background))
    }

    /// No reply to preview — the run ended before producing one (interrupted, failed at startup,
    /// cancelled) — so the line falls back to the run's state word rather than vanishing, which on
    /// iOS would shrink the row to a bare title.
    func testFallsBackToStateWordWithoutReply() {
        XCTAssertEqual(SessionLine.make(for: session(status: .succeeded), live: true),
                       .init(text: "Succeeded", tone: .preview))
        XCTAssertEqual(SessionLine.make(for: session(status: .failed), live: true),
                       .init(text: "Failed", tone: .preview))
        // Nothing was ever recorded to preview — an old row, or a run that died before its user
        // turn reached the server.
        XCTAssertEqual(SessionLine.make(for: session(status: .interrupted), live: true),
                       .init(text: "Interrupted", tone: .preview))
        // Every deliberate end reads "Ended" — the reason that stopped the run is not a run
        // outcome, so it no longer changes the word (see `SessionRunState`).
        XCTAssertEqual(SessionLine.make(for: session(status: .cancelled, endReason: "deleted"), live: true),
                       .init(text: "Ended", tone: .preview))
        // Trash (live: false) states the outcome the same way.
        XCTAssertEqual(SessionLine.make(for: session(status: .cancelled, endReason: "completed"), live: false),
                       .init(text: "Ended", tone: .preview))
    }

    /// The list payload's preview fields decode (server keys: lastAssistantText / lastToolUse /
    /// lastUserText / runningBgCount), and the recap beside them (0418).
    func testSessionDecodesPreviewFields() throws {
        let json = #"{"id":"s1","status":"RUNNING","lastAssistantText":"hello","lastToolUse":"Read","lastUserText":"hi there","runningBgCount":1,"recapText":"Moved the recap onto the list row.","recapAt":"2026-09-28T09:38:00.000Z"}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.lastAssistantText, "hello")
        XCTAssertEqual(s.lastToolUse, "Read")
        XCTAssertEqual(s.lastUserText, "hi there")
        XCTAssertEqual(s.runningBgCount, 1)
        XCTAssertEqual(s.recapText, "Moved the recap onto the list row.")
        XCTAssertEqual(s.recapAt, "2026-09-28T09:38:00.000Z")

        // A session the server has recapped none of — the `ORBIT_RECAP_ENABLED=0` deployment's
        // shape — answers nulls, and the row falls back exactly as it did before the recap existed.
        let bare = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s2","status":"AWAITING_INPUT","lastAssistantText":"All done.","recapText":null,"recapAt":null}"#.utf8))
        XCTAssertNil(bare.recapText)
        XCTAssertEqual(SessionLine.make(for: bare, live: true),
                       .init(text: "All done.", tone: .preview))
    }

    /// The rolling recap (0418) takes the place of the raw last reply — and only that place. Ports
    /// the web `sessionLine` cases of the same name (`WorkspaceView.sessionLine.test.tsx`).
    func testRecapTakesThePlaceOfTheReplyPreview() {
        let written = Date()
        let parked = session(status: .awaitingInput, lastAssistantText: "Committed the row change.",
                             recapText: "Moved the recap onto the list row; the three states are covered by tests.",
                             recapAt: ISO8601DateFormatter().string(from: written))
        let clock = DateFormatter(); clock.timeStyle = .short
        XCTAssertEqual(SessionLine.make(for: parked, live: true, now: written),
                       .init(text: "Moved the recap onto the list row; the three states are covered by tests.",
                             tone: .preview, label: "Recap · \(clock.string(from: written))"))

        // Another day's recap wears the date too: a bare "5:38 PM" on a row from yesterday misleads.
        let old = Date(timeIntervalSinceNow: -3 * 86_400)
        let day = DateFormatter(); day.dateFormat = "EEE, MMM d"
        let dated = session(status: .awaitingInput, lastAssistantText: "Committed the row change.",
                            recapText: "Shipped the drawer fix.", recapAt: ISO8601DateFormatter().string(from: old))
        XCTAssertEqual(SessionLine.make(for: dated, live: true, now: written),
                       .init(text: "Shipped the drawer fix.", tone: .preview,
                             label: "Recap · \(day.string(from: old)), \(clock.string(from: old))"))

        // A payload from a control plane that wrote the recap text without a time keeps the word.
        let timeless = session(status: .awaitingInput, lastAssistantText: "Committed the row change.",
                               recapText: "Shipped the drawer fix.", recapAt: nil)
        XCTAssertEqual(SessionLine.make(for: timeless, live: true, now: written),
                       .init(text: "Shipped the drawer fix.", tone: .preview, label: "Recap"))

        // No recap at all (and a blank one, which the server never stores): the reply preview the
        // row always had, with no label in front of it.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastAssistantText: "All done."), live: true),
                       .init(text: "All done.", tone: .preview))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastAssistantText: "All done.",
                                                     recapText: "   ", recapAt: nil), live: true),
                       .init(text: "All done.", tone: .preview))

        // Trash keeps it too: nothing live is left to outrank it there.
        XCTAssertEqual(SessionLine.make(for: parked, live: false, now: written).label,
                       "Recap · \(clock.string(from: written))")
    }

    /// The account's Session recaps switch (Settings): off, the same row falls through to the reply
    /// it showed before the recap existed.
    func testRecapsOffFallsBackToTheReply() {
        let parked = session(status: .awaitingInput, lastAssistantText: "Committed the row change.",
                             recapText: "Moved the recap onto the list row.", recapAt: nil)
        XCTAssertEqual(SessionLine.make(for: parked, live: true, recaps: false),
                       .init(text: "Committed the row change.", tone: .preview))
        // On (the default, and what an absent preference means): the recap, with its label.
        XCTAssertEqual(SessionLine.make(for: parked, live: true, recaps: true),
                       .init(text: "Moved the recap onto the list row.", tone: .preview, label: "Recap"))
    }

    /// Every live line still outranks the recap: it is newer work, not older prose. (The web's
    /// `never hides work that is still happening behind it`.)
    func testLiveLinesOutrankTheRecap() {
        let recap = "Moved the recap onto the list row."
        // Waiting on you.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, pendingApprovals: 1,
                                                     recapText: recap, recapAt: nil), live: true).tone, .approval)
        // Working: the tool in flight.
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastToolUse: "Bash",
                                                     recapText: recap, recapAt: nil), live: true),
                       .init(text: "Running Bash…", tone: .running))
        // A message of yours that has no answer yet — newer than the recap.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: "and now the footer?",
                                                     recapText: recap, recapAt: nil), live: true),
                       .init(text: "You: and now the footer?", tone: .preview))
        // A background process it left up.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, runningBgCount: 1,
                                                     recapText: recap, recapAt: nil), live: true),
                       .init(text: "Background process running…", tone: .background))
    }

    /// The chat page's recap line: the same recap at the top of the conversation, dated by how long
    /// ago the server wrote it. Nothing without a recap — never the raw reply, which the page holds in
    /// full below it — and nothing with the switch off; live state does not hide it.
    func testTheChatPageHeaderShowsTheRecapAndNothingElse() {
        let now = Date()
        func at(_ secondsAgo: TimeInterval) -> String {
            ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
        }
        let parked = session(status: .awaitingInput, lastAssistantText: "Committed the row change.",
                             recapText: "  Moved the recap onto the list row.\n", recapAt: at(5 * 60))
        XCTAssertEqual(SessionLine.headerRecap(for: parked, recaps: true, now: now),
                       .init(text: "Moved the recap onto the list row.", tone: .preview, label: "Recap · 5m ago"))
        // Working: the page's header says what is happening; this line says what the conversation has been.
        let working = session(status: .running, lastToolUse: "Bash",
                              recapText: "Moved the recap onto the list row.", recapAt: at(5 * 60))
        XCTAssertEqual(SessionLine.headerRecap(for: working, recaps: true, now: now)?.label, "Recap · 5m ago")
        // Older, and just written: the transcript's own relative words.
        XCTAssertEqual(SessionLine.headerRecap(for: session(status: .awaitingInput, recapText: "Shipped.",
                                                            recapAt: at(3 * 86_400)), recaps: true, now: now)?.label,
                       "Recap · 3d ago")
        XCTAssertEqual(SessionLine.headerRecap(for: session(status: .awaitingInput, recapText: "Shipped.",
                                                            recapAt: at(0)), recaps: true, now: now)?.label,
                       "Recap · just now")
        // No time on it: the word alone, as on the list row.
        XCTAssertEqual(SessionLine.headerRecap(for: session(status: .awaitingInput, recapText: "Shipped.", recapAt: nil),
                                               recaps: true, now: now)?.label, "Recap")
        // The switch off, no recap, a blank one, or no session read yet: nothing at all — not the reply.
        XCTAssertNil(SessionLine.headerRecap(for: parked, recaps: false, now: now))
        XCTAssertNil(SessionLine.headerRecap(for: session(status: .awaitingInput, lastAssistantText: "All done."),
                                             recaps: true, now: now))
        XCTAssertNil(SessionLine.headerRecap(for: session(status: .awaitingInput, lastAssistantText: "All done.",
                                                          recapText: " \n ", recapAt: at(60)), recaps: true, now: now))
        XCTAssertNil(SessionLine.headerRecap(for: nil, recaps: true, now: now))
    }
}
