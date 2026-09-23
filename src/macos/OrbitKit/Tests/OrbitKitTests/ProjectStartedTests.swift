import Foundation
import XCTest
@testable import OrbitKit

/// The message telling a coordinator its project was started, read the way the browser reads it
/// (`lib/projectStarted.ts`) and carried onto the bubble the console draws it as.
///
/// The pair that holds it in place is the one the exception item's card has: with the payload the
/// turn carries the card and keeps the words; without one — the same words — it is the bubble it
/// always was, and nothing is guessed from the prose.
final class ProjectStartedTests: XCTestCase {

    private static let told = """
        From Orbit · project started

        The account owner confirmed the 8 acceptance criteria of project “Codex 多账户” \
        (34Tcl0kralZrY8opuLJU4) and started it at 2026-09-23T05:06:07.072Z.
        """

    private static let card = """
        {"by": "CONFIRMATION", "projectId": "01a0cca0-aeaa-7618-bd5a-caccc089108c",
         "projectTitle": "Codex 多账户：一台机器上登录多个 Codex", "criteriaCount": 8,
         "held": [{"id": "01a0cca7-84ec-75cf-9b65-b94a4ce3bf76", "title": "runner：Codex 账户槽"},
                  {"id": "01a0cca7-84ec-75cf-9b65-b94a4ce3bf77", "title": "runner + apiserver：登录中继"},
                  {"id": "01a0cca7-84ec-75cf-9b65-b94a4ce3bf78", "title": "web：按账户上报状态"},
                  {"id": "01a0cca7-84ec-75cf-9b65-b94a4ce3bf79", "title": "web：配额按账户归属"}],
         "heldCount": 8}
        """

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    /// One `user` event as the server stores it: the echo, and the card when there is one.
    private func echo(_ payload: String) throws -> RunEvent {
        try JSONDecoder().decode(RunEvent.self, from: Data("""
            {"seq": 7, "type": "user", "turnId": "turn-started", "ts": "2026-09-23T05:06:08.000Z",
             "payload": \(payload)}
            """.utf8))
    }

    private func bubble(after event: RunEvent) throws -> UserBubble {
        var reducer = TranscriptReducer()
        reducer.apply(event)
        return try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        })
    }

    // MARK: - the payload

    func testReadsEveryFieldOfTheCard() throws {
        let b = try bubble(after: try echo(
            "{\"text\": \(Self.jsonString(Self.told)), \"projectStarted\": \(Self.card)}"))
        let card = try XCTUnwrap(b.startedCard)
        XCTAssertEqual(card.by, .confirmation)
        XCTAssertEqual(card.projectId, "01a0cca0-aeaa-7618-bd5a-caccc089108c")
        XCTAssertEqual(card.projectTitle, "Codex 多账户：一台机器上登录多个 Codex")
        XCTAssertEqual(card.criteriaCount, 8)
        XCTAssertEqual(card.held.map(\.title),
                       ["runner：Codex 账户槽", "runner + apiserver：登录中继", "web：按账户上报状态",
                        "web：配额按账户归属"])
        XCTAssertEqual(card.heldCount, 8)
        XCTAssertEqual(b.text, Self.told, "the words the agent read are folded, not dropped")
        XCTAssertNil(b.itemCard, "a project start is not an exception item")
    }

    /// The negative control: the same words with nothing recorded beside them, or with something
    /// that is not a card, stay the person's bubble.
    func testAMessageWithoutACardStaysTheBubbleItAlwaysWas() throws {
        let text = Self.jsonString(Self.told)
        for payload in ["{\"text\": \(text)}",
                        "{\"text\": \(text), \"projectStarted\": null}",
                        "{\"text\": \(text), \"projectStarted\": \"started\"}",
                        "{\"text\": \(text), \"projectStarted\": {\"by\": \"LATER\", \"projectId\": \"p\", \"projectTitle\": \"t\"}}",
                        "{\"text\": \(text), \"projectStarted\": {\"by\": \"SWITCH\", \"projectId\": \"\", \"projectTitle\": \"t\"}}",
                        "{\"text\": \(text), \"projectStarted\": {\"by\": \"SWITCH\", \"projectId\": \"p\"}}"] {
            let b = try bubble(after: try echo(payload))
            XCTAssertNil(b.startedCard, "drew a card from \(payload)")
            XCTAssertEqual(b.text, Self.told)
        }
    }

    func testTheCountIsNeverFewerThanTheTasksItLists() throws {
        let card = try XCTUnwrap(ProjectStarted.parseCard(try JSONDecoder().decode(JSONValue.self, from: Data("""
            {"by": "SWITCH", "projectId": "p", "projectTitle": "t",
             "held": [{"id": "a", "title": "one"}, {"id": "", "title": "no id"}, {"title": "none"}],
             "heldCount": -4}
            """.utf8))))
        XCTAssertEqual(card.held.map(\.title), ["one"], "a task without an id is not drawn")
        XCTAssertEqual(card.heldCount, 1)
        XCTAssertNil(card.criteriaCount)
    }

    // MARK: - while it waits on the queue

    func testAQueuedMessageCarriesTheCardTheEchoWillBeDrawnAs() throws {
        let rows = try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("""
            [{"turnId": "turn-started", "kind": "message", "content": \(Self.jsonString(Self.told)),
              "attachments": [], "projectStarted": \(Self.card)}]
            """.utf8))
        var reducer = TranscriptReducer()
        reducer.reconcileQueuedTurns(rows, knownBefore: [])
        let queued = try XCTUnwrap(reducer.state.queued.first)
        XCTAssertEqual(queued.startedCard?.projectTitle, "Codex 多账户：一台机器上登录多个 Codex")
        XCTAssertEqual(queued.text, Self.told)
        XCTAssertTrue(queued.queued)
    }

    // MARK: - what the card and the bar say

    func testTheBarNamesTheTurnTheWayTheCardDoes() throws {
        let b = try bubble(after: try echo(
            "{\"text\": \(Self.jsonString(Self.told)), \"projectStarted\": \(Self.card)}"))
        let summary = StickySummary.of(text: b.text, note: b.note, itemCard: b.itemCard,
                                       startedCard: b.startedCard)
        XCTAssertEqual(summary.label, "↑ Project started")
        XCTAssertEqual(summary.text, "Codex 多账户：一台机器上登录多个 Codex")
    }

    func testSaysHowItWasStartedAndWhatWaits() throws {
        let confirmed = ProjectStarted(by: .confirmation, projectId: "p", projectTitle: "t",
                                       criteriaCount: 8)
        let switched = ProjectStarted(by: .switch, projectId: "p", projectTitle: "t")
        XCTAssertEqual(ProjectStartedCard.label(confirmed.by), "Project started")
        XCTAssertEqual(ProjectStartedCard.kind(confirmed.by), "Criteria confirmed")
        XCTAssertEqual(ProjectStartedCard.label(switched.by), "Project switched on")
        XCTAssertEqual(ProjectStartedCard.kind(switched.by), "Automatic on")
        XCTAssertEqual(ProjectStartedCard.startedBy(confirmed), "Started by you, confirming 8 criteria")
        XCTAssertEqual(ProjectStartedCard.startedBy(switched), "Switched on by you")
        XCTAssertEqual(ProjectStartedCard.heldLead(1),
                       "1 task is set to start by hand, so it waits for the coordinator:")
        XCTAssertEqual(ProjectStartedCard.heldLead(8),
                       "8 tasks are set to start by hand, so they wait for the coordinator:")
        let now = ISO8601DateFormatter().date(from: "2026-09-23T05:09:08Z")!
        XCTAssertEqual(ProjectStartedCard.meta(confirmed, ts: "2026-09-23T05:06:08.000Z", now: now),
                       "Started by you, confirming 8 criteria · a notification, not an interruption · "
                        + (RelativeTime.format("2026-09-23T05:06:08.000Z", now: now) ?? ""))
    }

    func testFoldsTheTasksPastThreeAndLinksEachOne() throws {
        let card = try XCTUnwrap(ProjectStarted.parseCard(
            try JSONDecoder().decode(JSONValue.self, from: Data(Self.card.utf8))))
        XCTAssertEqual(ProjectStartedCard.tasksToggle(card, expanded: false), "Show 1 more")
        XCTAssertEqual(ProjectStartedCard.tasksToggle(card, expanded: true), "Show fewer")
        let three = ProjectStarted(by: .switch, projectId: "p", projectTitle: "t",
                                   held: Array(card.held.prefix(3)))
        XCTAssertNil(ProjectStartedCard.tasksToggle(three, expanded: false))
        XCTAssertEqual(ProjectStartedCard.taskLink(card.held[0])?.absoluteString,
                       "orbit-task:01a0cca7-84ec-75cf-9b65-b94a4ce3bf76")
        XCTAssertEqual(ProjectStartedCard.projectLink(card)?.absoluteString,
                       "orbit-project:01a0cca0-aeaa-7618-bd5a-caccc089108c")
        XCTAssertNil(ProjectStartedCard.taskLink(ProjectStartedTask(id: "not an id", title: "x")))
    }
}
