import XCTest
@testable import OrbitKit

/// Ports the web `sessionLine` cases: the Agent-console list's second line.
final class SessionLineTests: XCTestCase {
    private func session(status: RunStatus, lastAssistantText: String? = nil, lastToolUse: String? = nil,
                         lastUserText: String? = nil, runningBgCount: Int? = nil,
                         engineTurnActive: Bool? = nil,
                         pendingApprovals: Int? = nil, endReason: String? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: lastAssistantText, lastToolUse: lastToolUse, lastUserText: lastUserText,
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

    /// A turn just started (RUNNING) but the agent hasn't replied yet: the row shows the message
    /// you just sent, not the now-stale previous reply. A tool/approval frontier still outranks it.
    func testRunningShowsPendingUserMessageBeforeStaleReply() {
        let awaiting = session(status: .running, lastAssistantText: "previous reply",
                               lastUserText: "fix the drawer shadow")
        XCTAssertEqual(SessionLine.make(for: awaiting, live: true),
                       .init(text: "fix the drawer shadow", tone: .preview))

        // Once the agent picks up a tool, the tool status wins over the pending message.
        let tooling = session(status: .running, lastToolUse: "Bash", lastUserText: "fix the drawer shadow")
        XCTAssertEqual(SessionLine.make(for: tooling, live: true), .init(text: "Running Bash…", tone: .running))

        // Markdown in the sent message is flattened, like a reply preview.
        let md = session(status: .running, lastUserText: "please `run` the **tests**")
        XCTAssertEqual(SessionLine.make(for: md, live: true).text, "please run the tests")
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
                       .init(text: "设置按钮的底色很奇怪，请帮我 review", tone: .preview))

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
    /// lastUserText / runningBgCount).
    func testSessionDecodesPreviewFields() throws {
        let json = #"{"id":"s1","status":"RUNNING","lastAssistantText":"hello","lastToolUse":"Read","lastUserText":"hi there","runningBgCount":1}"#
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.lastAssistantText, "hello")
        XCTAssertEqual(s.lastToolUse, "Read")
        XCTAssertEqual(s.lastUserText, "hi there")
        XCTAssertEqual(s.runningBgCount, 1)
    }
}
