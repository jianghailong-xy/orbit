import Foundation
import XCTest
@testable import OrbitKit

/// Whose message a session row previews (docs/session-list-projects-design.md §3.5, owner 2026-11-07).
/// The server keeps one unanswered message per session whoever sent it, so a coordinator's row read
/// "You:" over a task's report. Another Orbit session's message (`lastUserFrom`) is named for that
/// session, as the conversation's card names it; "You" is only ever the owner's own words.
///
/// Ports the web's `sessionLine names who sent the message it previews` cases
/// (WorkspaceView.sessionLine.test.tsx), and holds the words to the web's own source: a missing
/// counterpart is a failure, never an `XCTSkip`.
final class SessionLineSenderTests: XCTestCase {
    private let report = "Done: **the package builds**"
    private let from = SessionMessageFrom(sessionId: "session-1", title: "Build the package")

    private func session(status: RunStatus, lastAssistantText: String? = nil, lastToolUse: String? = nil,
                         lastUserText: String? = nil, lastUserFrom: SessionMessageFrom? = nil,
                         pendingApprovals: Int? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: lastAssistantText, lastToolUse: lastToolUse,
                lastUserText: lastUserText, lastUserFrom: lastUserFrom)
    }

    func testNamesAnotherSessionByItsTitleWhileTheTurnRunsAndAfterItStopped() {
        let named = SessionLine(text: "Build the package: Done: the package builds", tone: .preview)
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastAssistantText: "previous reply",
                                                     lastUserText: report, lastUserFrom: from), live: true), named)
        XCTAssertEqual(SessionLine.make(for: session(status: .interrupted, lastAssistantText: "previous reply",
                                                     lastUserText: report, lastUserFrom: from), live: true), named)
        // Trash says it the same way.
        XCTAssertEqual(SessionLine.make(for: session(status: .failed, lastUserText: report, lastUserFrom: from),
                                        live: false), named)
    }

    /// No sender is both the owner's own message (null) and an older server's (no key): the decoding
    /// case below reads both as nil.
    func testSaysYouForTheOwnersOwnMessageAndForAnOlderServer() {
        XCTAssertEqual(SessionLine.you, "You")
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastUserText: "ship it"), live: true),
                       SessionLine(text: "You: ship it", tone: .preview))
        XCTAssertEqual(SessionLine.make(for: session(status: .interrupted, lastUserText: "ship it"), live: true),
                       SessionLine(text: "You: ship it", tone: .preview))
    }

    func testCallsASenderWithNoTitleWhatTheConversationsCardCallsItNeverYou() {
        XCTAssertEqual(SessionMessageCard.untitled, "Untitled session")
        for title in ["", "   ", "\n\t "] {
            let untitled = session(status: .awaitingInput, lastUserText: "ship it",
                                   lastUserFrom: SessionMessageFrom(sessionId: "session-1", title: title))
            XCTAssertEqual(SessionLine.make(for: untitled, live: true),
                           SessionLine(text: "Untitled session: ship it", tone: .preview), title.debugDescription)
        }
        // A title is named as written, without the spaces around it.
        let padded = session(status: .awaitingInput, lastUserText: "ship it",
                             lastUserFrom: SessionMessageFrom(sessionId: "session-1", title: "  Build the package "))
        XCTAssertEqual(SessionLine.make(for: padded, live: true).text, "Build the package: ship it")
    }

    func testChangesNothingAboveTheMessageAndASenderWithNoMessageMakesNoLine() {
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastToolUse: "Bash", lastUserText: report,
                                                     lastUserFrom: from), live: true),
                       SessionLine(text: "Running Bash…", tone: .running))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: report, lastUserFrom: from,
                                                     pendingApprovals: 1), live: true),
                       SessionLine(text: "Waiting for approval", tone: .approval))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastAssistantText: "On it.",
                                                     lastUserFrom: from), live: true),
                       SessionLine(text: "On it.", tone: .preview))
    }

    /// A row's `lastUserFrom`, read with `decodeIfPresent`: an object names the sender, null is the
    /// owner, a missing key is an older server, and a value this build cannot read is no sender rather
    /// than a list that fails to decode.
    func testDecodesTheSenderAndToleratesAnOlderOrAnOddServer() throws {
        func row(_ extra: String) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data(
                #"{"id":"s1","status":"RUNNING","lastUserText":"Done"\#(extra)}"#.utf8))
        }
        let named = try row(#","lastUserFrom":{"sessionId":"0195c0de-0000-7000-8000-000000000813","title":"Build the package"}"#)
        XCTAssertEqual(named.lastUserFrom,
                       SessionMessageFrom(sessionId: "0195c0de-0000-7000-8000-000000000813", title: "Build the package"))
        XCTAssertEqual(SessionLine.make(for: named, live: true).text, "Build the package: Done")
        XCTAssertNil(try row(#","lastUserFrom":null"#).lastUserFrom)
        XCTAssertNil(try row("").lastUserFrom)
        XCTAssertEqual(SessionLine.make(for: try row(""), live: true).text, "You: Done")
        // A sender whose title is missing or null is still a sender, and an untitled one.
        XCTAssertEqual(try row(#","lastUserFrom":{"sessionId":"x"}"#).lastUserFrom, SessionMessageFrom(sessionId: "x"))
        XCTAssertEqual(try row(#","lastUserFrom":{"sessionId":"x","title":null}"#).lastUserFrom,
                       SessionMessageFrom(sessionId: "x"))
        // A shape it cannot read at all is none, and the rest of the row still reads.
        let odd = try row(#","lastUserFrom":"Build the package""#)
        XCTAssertNil(odd.lastUserFrom)
        XCTAssertEqual(odd.lastUserText, "Done")
        // A row written back out (the list's disk cache) keeps its sender.
        let again = try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(named))
        XCTAssertEqual(again.lastUserFrom, named.lastUserFrom)
    }

    /// An event folds neither the message nor its sender into a row (`SessionUpsert`), so a row keeps
    /// the pair its read gave it: a merge that dropped the sender would put "You:" back over a task's
    /// report until the next snapshot.
    func testAnEventKeepsTheSenderBesideTheMessage() throws {
        let row = session(status: .running, lastUserText: report, lastUserFrom: from)
        let event = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(
            #"{"id":"s","title":"t","status":"AWAITING_INPUT","pendingApprovals":0}"#.utf8))
        let merged = row.applying(event)
        XCTAssertEqual(merged.lastUserText, report)
        XCTAssertEqual(merged.lastUserFrom, from)
        XCTAssertEqual(row.settingTitle("Renamed").lastUserFrom, from)
        XCTAssertEqual(row.settingPendingApprovals(1).lastUserFrom, from)
        XCTAssertEqual(row.settingFolder("f1").lastUserFrom, from)
    }

    /// A project's row says its coordinator's own line when nothing outranks it (§4.2, the sixth), so it
    /// names who sent the message it previews the same way: a task's report is the task's, and only the
    /// owner's words are "You".
    func testTheProjectRowsSecondLineNamesWhoSentTheCoordinatorsMessage() {
        let membership = { (role: SessionProjectMembership.Role) in
            SessionProjectMembership(projectId: "p1", projectTitle: "Project one", projectStatus: .open, role: role)
        }
        func coordinator(_ from: SessionMessageFrom?) -> Session {
            Session(id: "coordinator", title: "Plan the release", status: .awaitingInput, runState: .awaitingInput,
                    agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                    projectId: "p1", projectTitle: "Project one",
                    lastAssistantText: "The release plan is ready", lastUserText: report, lastUserFrom: from,
                    lastTurnAt: "2026-10-04T09:40:00Z", projectMembership: membership(.coordinator))
        }
        let task = Session(id: "task", title: "Build the package", status: .awaitingInput, runState: .awaitingInput,
                           agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                           lastAssistantText: "Built.", lastTurnAt: "2026-10-04T09:30:00Z",
                           projectMembership: membership(.task))
        func line(_ from: SessionMessageFrom?) -> SessionLine? {
            SessionProjectGrouping.listing([coordinator(from), task], folders: [], projects: [],
                                           view: .open, byTag: false).projects.first?.line
        }
        XCTAssertEqual(line(SessionMessageFrom(sessionId: "task", title: "Build the package")),
                       SessionLine(text: "Build the package: Done: the package builds", tone: .preview))
        XCTAssertEqual(line(nil), SessionLine(text: "You: Done: the package builds", tone: .preview))
    }

    // MARK: - The web's own words

    private static let webSource = "src/web/src/components/WorkspaceView.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(SessionLineSenderTests.webSource) was not found above this test file. The session line's "
                + "sender is one half of a pair; if the web half moved, move this check with it rather "
                + "than deleting it."
        }
    }

    private func web() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(Self.webSource)
            if FileManager.default.fileExists(atPath: url.path) { return try String(contentsOf: url, encoding: .utf8) }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// WorkspaceView.tsx's `sentLine` and `sentBy`: the same sentence, the sender before the message;
    /// the same word for the owner, and only where nobody else is named; and the card's word for an
    /// untitled sender, which `SessionMessageCopyParityTests` holds to `SESSION_MESSAGE_UNTITLED`.
    func testTheSenderWordsAreTheWebsOwn() throws {
        let web = try web()
        // The sentence as this end builds it, spelled back with the web's own interpolations.
        let built = SessionLine.sentLine("MESSAGE", from: SessionMessageFrom(sessionId: "s", title: "SENDER")).text
        XCTAssertEqual(built, "SENDER: MESSAGE")
        let template = built.replacingOccurrences(of: "SENDER", with: "${sender}")
            .replacingOccurrences(of: "MESSAGE", with: "${plainPreview(text)}")
        XCTAssertTrue(web.contains("text: `\(template)`,"), "the web's sentence drifted from \(built.debugDescription)")
        XCTAssertTrue(web.contains("export const SENT_BY_YOU = '\(SessionLine.you)';"),
                      "the web no longer calls the owner \(SessionLine.you.debugDescription)")
        XCTAssertEqual(SessionLine.sender(nil), SessionLine.you)
        XCTAssertTrue(web.contains("const from = s.lastUserFrom;"), "the web no longer reads the row's lastUserFrom")
        XCTAssertTrue(web.contains("if (!from || typeof from !== 'object') return SENT_BY_YOU;"),
                      "the web says You for something other than no sender")
        XCTAssertTrue(web.contains("return (typeof from.title === 'string' ? from.title.trim() : '') || SESSION_MESSAGE_UNTITLED;"),
                      "the web no longer names an untitled sender as the card does")
        XCTAssertEqual(SessionLine.sender(SessionMessageFrom(sessionId: "s", title: " ")), SessionMessageCard.untitled)
        // Both of the web's lines that show a pending message name who sent it, and neither says You alone.
        XCTAssertEqual(web.components(separatedBy: "return sentLine(s.lastUserText, sentBy(s));").count - 1, 2)
        XCTAssertFalse(web.contains("`You: "), "the web still says You: whoever sent the message")
    }
}
