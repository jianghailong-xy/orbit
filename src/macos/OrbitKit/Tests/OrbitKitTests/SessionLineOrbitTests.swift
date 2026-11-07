import Foundation
import XCTest
@testable import OrbitKit

/// A message Orbit wrote itself, on the session row (docs/session-list-projects-design.md §3.5, owner
/// 2026-11-07). The server marks the unanswered message Orbit's (`lastUserFromOrbit`) — a coordinator's
/// notification, a watch's wake, the owner's answer handed on, a task run's brief — and the row says
/// "Orbit", never "You": a coordinator's notification in the sentence its line in the conversation says
/// (`CoordinatorDeliveryCard.sentence`), any other message of Orbit's in its first line.
///
/// Ports the web's `sessionLine says Orbit for the message Orbit wrote` cases
/// (WorkspaceView.sessionLine.test.tsx), and holds the word and the line to the web's own source: a
/// missing counterpart is a failure, never an `XCTSkip`.
final class SessionLineOrbitTests: XCTestCase {
    private let evidence = CoordinatorDelivery(
        kind: .evidenceSubmitted, task: .init(id: "task-1", title: "Write Orbit on the row"), revision: 2,
        deliveredAt: "2026-11-07T07:30:00.000Z")
    private let notification = "From Orbit · project “Rows” has a revision of completion evidence for you to decide\n\nTask “Write Orbit on the row” …"
    private let wake = "Orbit Watch w-1 matched at generation 2: **CI** finished\n\nThis turn was queued by the watch, not typed by a person."

    private func session(status: RunStatus, lastAssistantText: String? = nil, lastToolUse: String? = nil,
                         lastUserText: String? = nil, lastUserFrom: SessionMessageFrom? = nil,
                         lastUserFromOrbit: OrbitMessageFrom? = nil, pendingApprovals: Int? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: pendingApprovals, branch: nil, updatedAt: nil,
                lastAssistantText: lastAssistantText, lastToolUse: lastToolUse,
                lastUserText: lastUserText, lastUserFrom: lastUserFrom, lastUserFromOrbit: lastUserFromOrbit)
    }

    func testSaysANotificationsOwnSentenceWhileTheTurnRunsAfterItStoppedAndInTrash() {
        XCTAssertEqual(SessionLine.orbit, "Orbit")
        let told = OrbitMessageFrom(coordinatorDelivery: evidence)
        let line = SessionLine(text: "Orbit: Evidence revision 2 submitted: Write Orbit on the row", tone: .preview)
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastAssistantText: "previous reply",
                                                     lastUserText: notification, lastUserFromOrbit: told), live: true), line)
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastAssistantText: "previous reply",
                                                     lastUserText: notification, lastUserFromOrbit: told), live: true), line)
        XCTAssertEqual(SessionLine.make(for: session(status: .interrupted, lastUserText: notification,
                                                     lastUserFromOrbit: told), live: true), line)
        XCTAssertEqual(SessionLine.make(for: session(status: .failed, lastUserText: notification,
                                                     lastUserFromOrbit: told), live: false), line)
    }

    func testSaysEveryKindOfNotificationAsItsLineInTheConversationSaysIt() throws {
        for kind in CoordinatorDelivery.Kind.allCases {
            // Read as the conversation reads a card: the fields its sentence does not name are left out.
            let card = try XCTUnwrap(CoordinatorDelivery.parseCard(.object([
                "kind": .string(kind.rawValue),
                "task": .object(["id": .string("task-1"), "title": .string("Build the package")]),
                "revision": .int(3), "count": .int(2), "deliveredAt": .string("2026-11-07T07:30:00.000Z"),
            ])), kind.rawValue)
            let told = session(status: .awaitingInput, lastUserText: notification,
                               lastUserFromOrbit: OrbitMessageFrom(coordinatorDelivery: card))
            XCTAssertEqual(SessionLine.make(for: told, live: true),
                           SessionLine(text: "Orbit: \(CoordinatorDeliveryCard.sentence(card))", tone: .preview), kind.rawValue)
        }
        // Spelled out for three of them, so a sentence that changed is read here as well as in the conversation.
        func said(_ card: CoordinatorDelivery) -> String {
            SessionLine.make(for: session(status: .awaitingInput, lastUserText: notification,
                                          lastUserFromOrbit: OrbitMessageFrom(coordinatorDelivery: card)), live: true).text
        }
        XCTAssertEqual(said(CoordinatorDelivery(kind: .criterionUnlanded, count: 2, deliveredAt: "2026-11-07T07:30:00.000Z")),
                       "Orbit: Work not on main yet: 2 tasks")
        XCTAssertEqual(said(CoordinatorDelivery(kind: .acceptanceLandedDone, count: 1, deliveredAt: "2026-11-07T07:30:00.000Z")),
                       "Orbit: The only criterion landed, recorded Done")
        XCTAssertEqual(said(CoordinatorDelivery(kind: .criteriaApproved, deliveredAt: "2026-11-07T07:30:00.000Z")),
                       "Orbit: Criteria proposal approved")
    }

    func testSaysTheFirstLineOfAnyOtherMessageOfOrbitsFlattenedLikeAPreview() {
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: wake,
                                                     lastUserFromOrbit: OrbitMessageFrom()), live: true),
                       SessionLine(text: "Orbit: Orbit Watch w-1 matched at generation 2: CI finished", tone: .preview))
        // Blank lines before it are not its first line.
        XCTAssertEqual(SessionLine.make(for: session(status: .running,
                                                     lastUserText: "\n  \nStart the task “Write Orbit on the row”.\n\nTask details:",
                                                     lastUserFromOrbit: OrbitMessageFrom()), live: true).text,
                       "Orbit: Start the task “Write Orbit on the row”.")
    }

    func testSaysYouOnlyForTheOwnersWordsAndNamesAnotherSessionAsBefore() {
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: "ship it"), live: true).text,
                       "You: ship it")
        // An older server sends no mark at all: every message reads as it did.
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: notification), live: true).text,
                       "You: From Orbit · project “Rows” has a revision of completion evidence for you to decide Task “Write Orbit on the row” …")
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: "ship it",
                                                     lastUserFrom: SessionMessageFrom(sessionId: "s1", title: "Build the package")),
                                        live: true).text,
                       "Build the package: ship it")
    }

    func testChangesNothingAboveTheMessageAndAMarkWithNoMessageMakesNoLine() {
        let told = OrbitMessageFrom(coordinatorDelivery: evidence)
        XCTAssertEqual(SessionLine.make(for: session(status: .running, lastToolUse: "Bash", lastUserText: notification,
                                                     lastUserFromOrbit: told), live: true),
                       SessionLine(text: "Running Bash…", tone: .running))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastUserText: notification,
                                                     lastUserFromOrbit: told, pendingApprovals: 1), live: true),
                       SessionLine(text: "Waiting for approval", tone: .approval))
        XCTAssertEqual(SessionLine.make(for: session(status: .awaitingInput, lastAssistantText: "On it.",
                                                     lastUserFromOrbit: told), live: true),
                       SessionLine(text: "On it.", tone: .preview))
    }

    /// A row's `lastUserFromOrbit`, read leniently: an object marks the message Orbit's, with the card when
    /// this build can read it; null is anybody else's; a missing key is an older server; and a value this
    /// build cannot read is no mark, rather than a list that fails to decode.
    func testDecodesTheMarkAndToleratesAnOlderOrAnOddServer() throws {
        func row(_ extra: String) throws -> Session {
            try JSONDecoder().decode(Session.self, from: Data(
                #"{"id":"s1","status":"AWAITING_INPUT","lastUserText":"From Orbit · project “Rows” has news"\#(extra)}"#.utf8))
        }
        let card = #"{"kind":"EVIDENCE_SUBMITTED","task":{"id":"task-1","title":"Write Orbit on the row"},"revision":2,"count":null,"deliveredAt":"2026-11-07T07:30:00.000Z","toCoordinator":true}"#
        let told = try row(#","lastUserFrom":null,"lastUserFromOrbit":{"coordinatorDelivery":\#(card)}"#)
        XCTAssertEqual(told.lastUserFromOrbit, OrbitMessageFrom(coordinatorDelivery: evidence))
        XCTAssertEqual(SessionLine.make(for: told, live: true).text, "Orbit: Evidence revision 2 submitted: Write Orbit on the row")
        let plain = try row(#","lastUserFromOrbit":{"coordinatorDelivery":null}"#)
        XCTAssertEqual(plain.lastUserFromOrbit, OrbitMessageFrom())
        XCTAssertEqual(SessionLine.make(for: plain, live: true).text, "Orbit: From Orbit · project “Rows” has news")
        // A card a later server writes, which this build cannot read: still Orbit's, with its first line.
        let later = try row(#","lastUserFromOrbit":{"coordinatorDelivery":{"kind":"A_KIND_FROM_A_LATER_SERVER","deliveredAt":"2026-11-07T07:30:00.000Z"}}"#)
        XCTAssertEqual(later.lastUserFromOrbit, OrbitMessageFrom())
        XCTAssertNil(try row(#","lastUserFromOrbit":null"#).lastUserFromOrbit)
        XCTAssertNil(try row("").lastUserFromOrbit)
        XCTAssertEqual(SessionLine.make(for: try row(""), live: true).text, "You: From Orbit · project “Rows” has news")
        // A shape it cannot read at all is none, and the rest of the row still reads.
        let odd = try row(#","lastUserFromOrbit":"Orbit""#)
        XCTAssertNil(odd.lastUserFromOrbit)
        XCTAssertEqual(odd.lastUserText, "From Orbit · project “Rows” has news")
        // A row written back out (the list's disk cache) keeps its mark and its card.
        let again = try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(told))
        XCTAssertEqual(again.lastUserFromOrbit, told.lastUserFromOrbit)
    }

    /// An event folds neither the message nor its mark into a row (`SessionUpsert`), so a row keeps the
    /// pair its read gave it.
    func testAnEventKeepsTheMarkBesideTheMessage() throws {
        let mark = OrbitMessageFrom(coordinatorDelivery: evidence)
        let row = session(status: .running, lastUserText: notification, lastUserFromOrbit: mark)
        let event = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(
            #"{"id":"s","title":"t","status":"AWAITING_INPUT","pendingApprovals":0}"#.utf8))
        let merged = row.applying(event)
        XCTAssertEqual(merged.lastUserText, notification)
        XCTAssertEqual(merged.lastUserFromOrbit, mark)
        XCTAssertEqual(row.settingTitle("Renamed").lastUserFromOrbit, mark)
        XCTAssertEqual(row.settingPendingApprovals(1).lastUserFromOrbit, mark)
        XCTAssertEqual(row.settingFolder("f1").lastUserFromOrbit, mark)
    }

    /// A project's row says its coordinator's own line when nothing outranks it (§4.2, the sixth): a
    /// notification the coordinator has not answered yet says Orbit, in its line's sentence.
    func testTheProjectRowsSecondLineSaysOrbitForTheCoordinatorsNotification() {
        let membership = { (role: SessionProjectMembership.Role) in
            SessionProjectMembership(projectId: "p1", projectTitle: "Project one", projectStatus: .open, role: role)
        }
        func coordinator(_ mark: OrbitMessageFrom?, text: String) -> Session {
            Session(id: "coordinator", title: "Plan the release", status: .awaitingInput, runState: .awaitingInput,
                    agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                    projectId: "p1", projectTitle: "Project one",
                    lastAssistantText: "The release plan is ready", lastUserText: text, lastUserFromOrbit: mark,
                    lastTurnAt: "2026-10-04T09:40:00Z", projectMembership: membership(.coordinator))
        }
        let task = Session(id: "task", title: "Build the package", status: .awaitingInput, runState: .awaitingInput,
                           agentId: "w1", assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                           lastAssistantText: "Built.", lastTurnAt: "2026-10-04T09:30:00Z",
                           projectMembership: membership(.task))
        func line(_ mark: OrbitMessageFrom?, _ text: String) -> SessionLine? {
            SessionProjectGrouping.listing([coordinator(mark, text: text), task], folders: [], projects: [],
                                           view: .open, byTag: false).projects.first?.line
        }
        XCTAssertEqual(line(OrbitMessageFrom(coordinatorDelivery: evidence), notification),
                       SessionLine(text: "Orbit: Evidence revision 2 submitted: Write Orbit on the row", tone: .preview))
        XCTAssertEqual(line(OrbitMessageFrom(), wake),
                       SessionLine(text: "Orbit: Orbit Watch w-1 matched at generation 2: CI finished", tone: .preview))
        XCTAssertEqual(line(nil, "Ship the release"), SessionLine(text: "You: Ship the release", tone: .preview))
    }

    // MARK: - The web's own words

    private static let webSource = "src/web/src/components/WorkspaceView.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(SessionLineOrbitTests.webSource) was not found above this test file. Orbit's line is one half "
                + "of a pair; if the web half moved, move this check with it rather than deleting it."
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

    /// WorkspaceView.tsx's `orbitLine`: the same word, the same sentence — Orbit before what it says — the
    /// conversation's own reading and sentence for a notification card, the first line that is not blank
    /// for anything else, and both of the lines that show a pending message asking it first.
    func testOrbitsWordAndLineAreTheWebsOwn() throws {
        let web = try web()
        XCTAssertTrue(web.contains("export const SENT_BY_ORBIT = '\(SessionLine.orbit)';"),
                      "the web no longer calls Orbit \(SessionLine.orbit.debugDescription)")
        // The sentence as this end builds it, spelled back with the web's own interpolations.
        let built = try XCTUnwrap(SessionLine.orbitLine("SAID", OrbitMessageFrom())).text
        XCTAssertEqual(built, "\(SessionLine.orbit): SAID")
        let template = built.replacingOccurrences(of: SessionLine.orbit, with: "${SENT_BY_ORBIT}")
            .replacingOccurrences(of: "SAID", with: "${said}")
        XCTAssertTrue(web.contains("return { text: `\(template)`, tone: 'preview' };"),
                      "the web's Orbit line drifted from \(built.debugDescription)")
        XCTAssertTrue(web.contains("const orbit = s.lastUserFromOrbit;"), "the web no longer reads the row's lastUserFromOrbit")
        XCTAssertTrue(web.contains("if (!orbit || typeof orbit !== 'object') return null;"),
                      "the web says Orbit for something other than an object mark")
        XCTAssertTrue(web.contains("const card = parseCoordinatorDelivery(orbit);"),
                      "the web no longer reads the card as the conversation reads it")
        XCTAssertTrue(web.contains("? coordinatorDeliverySentence(card)"),
                      "the web no longer says the conversation line's own sentence")
        XCTAssertTrue(web.contains(": plainPreview(String(s.lastUserText).split('\\n').find((line) => line.trim() !== '') ?? '');"),
                      "the web no longer says the first line that is not blank")
        XCTAssertNil(SessionLine.orbitLine("SAID", nil))
        XCTAssertEqual(web.components(separatedBy: "return orbitLine(s) ?? sentLine(s.lastUserText, sentBy(s));").count - 1, 2,
                       "a web line that shows a pending message does not ask whether Orbit wrote it")
    }
}
