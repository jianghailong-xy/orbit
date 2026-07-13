import XCTest
@testable import OrbitKit

/// Ports the web `sessionLine` cases: the Agent-console list's second line.
final class SessionLineTests: XCTestCase {
    private func session(status: RunStatus, lastAssistantText: String? = nil, lastToolUse: String? = nil,
                         lastUserText: String? = nil, runningBgCount: Int? = nil,
                         pendingApprovals: Int? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: lastAssistantText, lastToolUse: lastToolUse, lastUserText: lastUserText,
                runningBgCount: runningBgCount)
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
        XCTAssertEqual(SessionLine.make(for: md, live: true)?.text, "please run the tests")
    }

    func testPendingAndBackground() {
        XCTAssertEqual(SessionLine.make(for: session(status: .pending), live: true),
                       .init(text: "Queued", tone: .queued))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, runningBgCount: 2), live: true),
                       .init(text: "2 background processes running…", tone: .running))
    }

    func testParkedShowsLastReplyAndStripsMarkdown() {
        let parked = session(status: .awaitingInput,
                             lastAssistantText: "## Done\n\nFixed the `Session` model and ran ```swift\ntest()\n``` — all green.")
        let line = SessionLine.make(for: parked, live: true)
        XCTAssertEqual(line?.tone, .preview)
        XCTAssertEqual(line?.text, "Done Fixed the Session model and ran — all green.")
    }

    func testNoLineWhenIdleWithoutReply() {
        XCTAssertNil(SessionLine.make(for: session(status: .succeeded), live: true))
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
