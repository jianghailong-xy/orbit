import Foundation
import XCTest
@testable import OrbitKit

/// THE EXCEPTION CARD — the item that became the owner's without anybody asking, and the pause only
/// they can lift (contract §7.5 mock 5's right column, §6.3 F-T4 mock 6 ①).
///
/// Why this card has a test at all: the server counts these items on the project's coordinator
/// conversation, so the session list, the console header and the needs-you banner all say somebody
/// is waiting on the owner — and until this card existed, nothing in that conversation could be
/// pressed. A row reading "Waiting for approval" over a conversation with nothing in it is the
/// defect; what keeps it closed is that every word the card says traces to the browser's own, and
/// that its press is offered exactly when the server listed the door.
final class ExceptionCardsTests: XCTestCase {

    private static let webCard = "src/web/src/components/ProjectProgressStatus.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case notInWeb(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(ExceptionCardsTests.webCard) was not found above this test file. This "
                    + "card is one half of a pair; if the web half moved, move this check with it "
                    + "rather than deleting it."
            case .notInWeb(let what):
                return "\(what) is not in \(ExceptionCardsTests.webCard) any more. Either it was "
                    + "renamed — then rename it here too, which is what this check is for — or the "
                    + "browser no longer says it and this client is saying it alone."
            }
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCard).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.noRepo
    }

    /// The web source with its wrapped string literals put back together: where a long sentence
    /// breaks across lines is a formatting decision, while the words are the contract.
    private func webSource() throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(Self.webCard), encoding: .utf8)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"])", with: "= $1", options: .regularExpression)
    }

    /// One `const NAME = '…';` declaration, by name — the same read `OwnerItemCardsTests` makes of
    /// the question card's exports.
    private func declaration(_ source: String, _ name: String) throws -> String {
        let pattern = "const \(name) =\\s*['\"](.+?)['\"];"
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: source) else {
            throw ParityError.notInWeb(name)
        }
        return String(source[range])
    }

    private func require(_ source: String, _ needle: String) throws -> String {
        guard source.contains(needle) else { throw ParityError.notInWeb(needle) }
        return needle
    }

    // MARK: fixtures

    /// Noon UTC two days on from the wait below, so every span in these tests is arithmetic a
    /// reader can check by eye.
    private let now = RelativeTime.parse("2026-09-21T12:00:00Z")!

    private struct Fixture {
        var itemId = "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"
        var kind: ProjectOpenItemKind = .taskFailed
        var title = "Task failed: P5.1 实现游戏 Route Handlers、鉴权与玩家视图协议"
        var detailLine = "the run ended with exit code 1"
        /// 2026-09-19T19:01:41.497Z — the wait that ran into the escalation (§4.7).
        var waitingSince = "2026-09-19T19:01:41.497Z"
        var assignee: ProjectOpenItemAssignee = .owner
        var assigneeReason: ProjectOpenItemAssigneeReason = .escalated
        var escalateAt: String?
        /// 19:01:41 → 21:02:23 is two hours and forty-two seconds, which the span floors to `2h`.
        var escalatedAt: String? = "2026-09-19T21:02:23.903Z"
        var taskId: String? = "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"
        var sessionId: String? = "489fc485-949c-533a-9b56-7712a68762ef"
        var fuseEpisodeId: String?
        var actions: [ProjectOpenItemAction] = [.askCoordinatorAgain, .openTaskSession, .cancelTask]
        var question: CoordinatorQuestion?

        func build() -> ProjectOpenItemRow {
            ProjectOpenItemRow(itemId: itemId, kind: kind, title: title, detailLine: detailLine,
                               waitingSince: waitingSince, assignee: assignee,
                               assigneeReason: assigneeReason, escalateAt: escalateAt,
                               escalatedAt: escalatedAt, taskId: taskId, sessionId: sessionId,
                               fuseEpisodeId: fuseEpisodeId, actions: actions, question: question)
        }
    }

    private func row(_ overrides: (inout Fixture) -> Void = { _ in }) -> ProjectOpenItemRow {
        var fixture = Fixture()
        overrides(&fixture)
        return fixture.build()
    }

    private func view(_ rows: [ProjectOpenItemRow]) -> ProjectOpenItemsView {
        ProjectOpenItemsView(needsYou: rows, withCoordinator: [])
    }

    // MARK: the words are the browser's

    func testTheProvenanceMarkAndTheTwoPressesAreTheBrowsersWords() throws {
        let web = try webSource()
        XCTAssertEqual(ExceptionCards.provenance, try declaration(web, "FROM_ORBIT"))
        XCTAssertEqual(ExceptionCards.provenanceTitle, try declaration(web, "FROM_ORBIT_TITLE"))
        // The presses are keys in `ACTION_LABEL`, not exported consts — read as the browser writes
        // them, and asserted against what this client draws.
        try require(web, "ASK_COORDINATOR_AGAIN: '\(ExceptionCards.askCoordinatorAgain)'")
        try require(web, "RESUME: '\(ExceptionCards.resume)'")
    }

    /// The card's second control is the one every other Orbit card uses to hand its reply to the
    /// composer — one word for one thing (`Approvals.chatAction`) — and the two sentences that
    /// control arms are this card's own: the composer has to say WHAT the reply is about, and the
    /// coordinator is told WHICH item, since the item is not in that transcript.
    ///
    /// The prefix and the placeholder are native-only, and deliberately so: the browser's card
    /// answers this item with a door and says nothing about it (its two presses are the server's
    /// own list), so there is no counterpart to compare them against — the family they belong to is
    /// the composer handoffs, whose other members' words are compared where those live
    /// (`ComposerHandoffWiringTests`).
    func testTheChatHandoffSaysWhatTheReplyIsAbout() {
        let escalated = row()
        XCTAssertEqual(ExceptionCards.chatBanner(escalated, isPause: false),
                       "\(ExceptionCards.chatPrefix)\(escalated.title)")
        XCTAssertTrue(ExceptionCards.chatPrefix.hasSuffix(": "),
                      "the bar's line runs into the item's title")
        XCTAssertTrue(ExceptionCards.chatPlaceholder.hasSuffix("…"),
                      "and the composer asks for the sentence a message needs")

        let pause = row { $0.kind = .fusePaused; $0.assigneeReason = .defaultReason
                          $0.escalatedAt = nil; $0.title = "The coordinator paused itself" }
        XCTAssertEqual(ExceptionCards.chatBanner(pause, isPause: true),
                       "\(ExceptionCards.pauseChatPrefix)\(pause.title)")
        XCTAssertNotEqual(ExceptionCards.chatPrefix, ExceptionCards.pauseChatPrefix,
                          "a pause is not an exception, and the coordinator reading the bar "
                              + "would be told the wrong noun by the card that knows better")
    }

    /// What the coordinator is told: the item, in full, because its own list may not have carried
    /// it to the reader — and the item's address, so an answer about an item that has since moved
    /// can be told apart from one about this one.
    func testTheContextCarriesTheItemAndWhereItIs() {
        let escalated = row()
        let context = ExceptionCards.chatContext(projectTitle: "Wikids", row: escalated,
                                                 isPause: false, now: now)
        XCTAssertTrue(context.contains("“Wikids”"), "the project it is about is named")
        XCTAssertTrue(context.contains(escalated.title))
        XCTAssertTrue(context.contains(escalated.detailLine))
        XCTAssertTrue(context.contains(escalated.itemId),
                      "the id is the address the coordinator acts on")
        XCTAssertTrue(context.contains("no one acted on it for 2h"),
                      "how it became the owner's, in the web's own words")

        let pause = row { $0.kind = .fusePaused; $0.assigneeReason = .defaultReason
                          $0.escalatedAt = nil }
        let paused = ExceptionCards.chatContext(projectTitle: nil, row: pause, isPause: true,
                                               now: now)
        XCTAssertTrue(paused.contains("the coordinator stopped itself"))
        XCTAssertFalse(paused.contains("no one acted on it"),
                       "a pause did not escalate, and saying it did would be a lie about why it "
                          + "is the owner's")
        XCTAssertFalse(paused.contains(" in “"),
                       "a session with no project names none rather than an empty one")
    }

    /// §7.5's five headings, taken from the switch arms themselves rather than from a phrase a
    /// comment could satisfy: the browser's sentence for each reason, and this client's, are the
    /// same one.
    func testTheEscalationHeadingsAreTheBrowsersSentences() throws {
        let web = try webSource()
        XCTAssertEqual(ExceptionCards.heading(row { $0.assigneeReason = .escalated }, now: now),
                       try require(web, "Now yours — no one acted on this for ")
                       + ExceptionCards.waitedBeforeEscalation(row()))
        XCTAssertEqual(ExceptionCards.heading(row { $0.assigneeReason = .coordinatorEnded }, now: now),
                       try require(web, "Now yours — the coordinator conversation ended"))
        XCTAssertEqual(ExceptionCards.heading(row { $0.assigneeReason = .chainLimit }, now: now),
                       try require(web, "Now yours — the 3rd failure in this chain"))
        XCTAssertEqual(ExceptionCards.heading(row { $0.assigneeReason = .handedOver }, now: now),
                       try require(web, "Now yours — the coordinator handed it over"))
        XCTAssertEqual(ExceptionCards.heading(row { $0.assigneeReason = .noCoordinator }, now: now),
                       try require(web, "Now yours — this project has no coordinator (waiting ")
                       + ExceptionCards.waited(row(), now: now) + ")")
        // The browser's own fallback for a row whose escalated instant it does not have.
        try require(web, "'a while'")
        XCTAssertEqual(ExceptionCards.waitedBeforeEscalation(row { $0.escalatedAt = nil }), "a while")
    }

    /// The two headers say what the needs-you banner says about the same fact: a person who presses
    /// "Escalated to you" in the banner and lands on a card reading something else has been told the
    /// same thing twice in two ways.
    func testTheHeadersAgreeWithTheBanner() {
        let since = "2026-09-19T19:01:41.497Z"
        let escalated = SessionOwnerItem(itemId: "i", kind: .escalated, title: "t", since: since)
        let paused = SessionOwnerItem(itemId: "i", kind: .fusePaused, title: "t", since: since)
        XCTAssertEqual(NeedsYouLogic.ownerItemText(escalated, project: nil),
                       ExceptionCards.escalatedTitle)
        XCTAssertEqual(NeedsYouLogic.ownerItemText(paused, project: nil),
                       ExceptionCards.pauseTitle)
    }

    // MARK: what gets a card

    /// The owner's group, minus the two kinds that have cards of their own — the same filter the
    /// browser's `ItemAsCard` applies, and for the same reason: one question, answered in one place.
    func testTheCardsAreTheOwnersGroupWithoutTheTwoThatHaveTheirOwn() {
        let question = row { $0.itemId = "q"; $0.kind = .coordinatorQuestion
                             $0.question = CoordinatorQuestion(question: "which line?") }
        let promotion = row { $0.itemId = "p"; $0.kind = .promotionApproval
                              $0.assigneeReason = .defaultReason; $0.actions = [.review] }
        let escalated = row { $0.itemId = "e" }
        let pause = row { $0.itemId = "f"; $0.kind = .fusePaused
                          $0.assigneeReason = .defaultReason; $0.escalatedAt = nil
                          $0.fuseEpisodeId = "ep"; $0.actions = [.resume] }
        // A coordinator's own item, which this card must not draw: it is work in progress, and the
        // list it would repeat is the coordinator's.
        let withCoordinator = row { $0.itemId = "c"; $0.assignee = .coordinator
                                    $0.assigneeReason = .defaultReason }
        let items = ProjectOpenItemsView(needsYou: [question, promotion, escalated, pause],
                                         withCoordinator: [withCoordinator])
        XCTAssertEqual(ExceptionCards.cards(items).map(\.itemId), ["e", "f"])
        XCTAssertEqual(ExceptionCards.cards(nil).count, 0)
    }

    /// The three standings, and the one that must never be mistaken for another: no read yet is not
    /// "it went away".
    func testTheThreeStandings() {
        XCTAssertEqual(ExceptionCards.standing(items: nil, itemId: "e"), .unread)
        XCTAssertEqual(ExceptionCards.standing(items: view([]), itemId: "e"), .gone)
        let escalated = row()
        XCTAssertEqual(ExceptionCards.standing(items: view([escalated]),
                                               itemId: escalated.itemId), .open(escalated))
        XCTAssertEqual(ExceptionCards.standing(items: view([escalated]), itemId: "somebody-else"), .gone,
                       "the id is the address: a different one is a different item")
        XCTAssertTrue(ExceptionCards.isOpen(.open(escalated)))
        XCTAssertFalse(ExceptionCards.isOpen(.gone))
        XCTAssertFalse(ExceptionCards.isOpen(.unread))
    }

    // MARK: what the card says

    /// An item that was the owner's from the start has no heading — it is not an escalation — so the
    /// card opens with the item's own title rather than a sentence this build made up.
    func testNoHeadingForAnItemThatWasAlwaysTheOwnersAndTheHeadingSlotNeverOpensBlank() {
        let pause = row { $0.kind = .fusePaused; $0.assigneeReason = .defaultReason
                          $0.escalatedAt = nil
                          $0.title = "Coordinator paused — 3 self-started runs today"
                          $0.fuseEpisodeId = "ep"; $0.actions = [.resume] }
        XCTAssertNil(ExceptionCards.heading(pause, now: now))
        XCTAssertEqual(ExceptionCards.headingLine(pause, now: now), pause.title)
        XCTAssertNil(ExceptionCards.subject(pause, now: now),
                     "the heading is the title — drawing it again would print it twice")

        let escalated = row()
        XCTAssertEqual(ExceptionCards.headingLine(escalated, now: now),
                       "Now yours — no one acted on this for 2h")
        XCTAssertEqual(ExceptionCards.subject(escalated, now: now), escalated.title)
    }

    /// How long the coordinator had it, from the two instants — never from the project's setting,
    /// which can be changed afterwards and would then make this sentence lie about what happened.
    func testWaitedBeforeEscalation() {
        XCTAssertEqual(ExceptionCards.waitedBeforeEscalation(row()), "2h")
        // A clock that ran backwards — or a stored row meeting a setting changed under it — floors
        // at zero rather than printing a negative span.
        XCTAssertEqual(ExceptionCards.waitedBeforeEscalation(row {
            $0.escalatedAt = "2026-09-19T18:00:00Z"
        }), "1s")
    }

    /// The footer and the wait, in the browser's `ownerLine` and `formatSpan` words.
    func testTheFooterAndTheWait() {
        XCTAssertEqual(ExceptionCards.ownerLine(row(), now: now), "Owner: you · waiting 1d 16h")
        // Two days and sixteen hours would floor to `2d 16h` only past the second day: the span
        // says the smaller of the two numbers, and both clients have to floor the same way.
        XCTAssertEqual(ExceptionCards.waited(row { $0.waitingSince = "2026-09-19T12:00:00Z" },
                                             now: now), "2d")
        XCTAssertEqual(ExceptionCards.ownerLine(row { $0.waitingSince = "2026-09-21T11:45:00Z" },
                                               now: now), "Owner: you · waiting 15m")
    }

    // MARK: what the card offers

    /// A press is drawn exactly when the server listed the door. That is the whole rule: the
    /// listing is computed from facts the client cannot see — is there a live coordinator
    /// conversation, is there an episode — and a button the door would refuse is worse than none.
    func testThePressesFollowTheServersOwnList() {
        XCTAssertTrue(ExceptionCards.askable(row()))
        XCTAssertFalse(ExceptionCards.askable(row { $0.actions = [.openTaskSession, .cancelTask] }),
                       "no conversation to hand it to — the server lists no ASK_COORDINATOR_AGAIN")

        XCTAssertTrue(ExceptionCards.resumable(row { $0.fuseEpisodeId = "ep"
                                                     $0.actions = [.resume] }))
        XCTAssertFalse(ExceptionCards.resumable(row { $0.fuseEpisodeId = nil
                                                      $0.actions = [.resume] }),
                       "the door takes the episode by id; a card without one cannot press it")
        XCTAssertFalse(ExceptionCards.resumable(row { $0.fuseEpisodeId = "ep"; $0.actions = [] }))
    }


    // MARK: the row as the server serves it

    /// The fields this card reads, off the wire — including the two enums the card's answers turn
    /// on, and the `delivery` block it deliberately ignores.
    func testTheRowDecodesTheFieldsTheCardDraws() throws {
        let json = """
        {"itemId":"01a0bb0b","kind":"TASK_FAILED",
         "title":"Task failed: P5.1 实现游戏 Route Handlers",
         "detailLine":"the run ended with exit code 1",
         "assignee":"OWNER","assigneeReason":"ESCALATED",
         "waitingSince":"2026-09-19T19:01:41.497Z","escalateAt":null,
         "escalatedAt":"2026-09-19T21:02:23.903Z",
         "taskId":"01a03f58","sessionId":"489fc485","promotionId":null,"fuseEpisodeId":null,
         "delivery":{"state":"NOT_REQUIRED","sessionId":null,"at":null},
         "actions":["ASK_COORDINATOR_AGAIN","OPEN_TASK_SESSION","CANCEL_TASK"],
         "question":null}
        """
        let decoded = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.kind, .taskFailed)
        XCTAssertEqual(decoded.assignee, .owner)
        XCTAssertEqual(decoded.assigneeReason, .escalated)
        XCTAssertTrue(decoded.assigneeReason.isEscalation)
        XCTAssertEqual(decoded.escalatedAt, "2026-09-19T21:02:23.903Z")
        XCTAssertEqual(decoded.actions, [.askCoordinatorAgain, .openTaskSession, .cancelTask])
        XCTAssertTrue(ExceptionCards.askable(decoded))
        XCTAssertNil(decoded.question)
        XCTAssertEqual(ExceptionCards.heading(decoded, now: now),
                       "Now yours — no one acted on this for 2h")
    }

    /// An action or a reason this build has never heard of is decoded rather than failing the read
    /// that carried it — the list has other rows on it, and one unknown door is not a broken
    /// project. It draws no button, which is the same answer any action the server did not list
    /// gets.
    func testAnUnknownReasonAndActionDoNotFailTheRead() throws {
        let json = """
        {"itemId":"x","kind":"SOMETHING_NEW","title":"t","detailLine":"d",
         "waitingSince":"2026-09-19T19:01:41.497Z","assignee":"OWNER",
         "assigneeReason":"A_REASON_FROM_LATER","actions":["A_DOOR_FROM_LATER"]}
        """
        let decoded = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.kind, .unknown)
        XCTAssertEqual(decoded.assigneeReason, .unknown)
        XCTAssertFalse(decoded.assigneeReason.isEscalation)
        XCTAssertEqual(decoded.actions, [.unknown])
        XCTAssertFalse(ExceptionCards.askable(decoded))
        XCTAssertFalse(ExceptionCards.resumable(decoded))
        XCTAssertEqual(ExceptionCards.headingLine(decoded, now: now), "t")
    }

    /// A row from an older control plane, which sends neither the reason nor the actions: the card
    /// draws, with no press — never with one the server never offered.
    func testAnOlderRowsShorterPayloadStillDraws() throws {
        let json = """
        {"itemId":"x","kind":"TASK_FAILED","title":"t","detailLine":"d",
         "waitingSince":"2026-09-19T19:01:41.497Z"}
        """
        let decoded = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.assignee, .unknown)
        XCTAssertEqual(decoded.assigneeReason, .unknown)
        XCTAssertTrue(decoded.actions.isEmpty)
        XCTAssertFalse(ExceptionCards.askable(decoded))
        XCTAssertEqual(ExceptionCards.ownerLine(decoded, now: now), "Owner: you · waiting 1d 16h")
    }

    /// The two receipts the card draws, off the doors' own answers (§4.7, §6.3 F-T4).
    func testTheDoorAnswersDecode() throws {
        let returned = try JSONDecoder().decode(OpenItemReturned.self, from: Data("""
        {"itemId":"01a0bb0b","assignee":"COORDINATOR",
         "waitingSince":"2026-09-21T12:00:00.000Z","escalateAt":"2026-09-21T18:00:00.000Z"}
        """.utf8))
        XCTAssertEqual(returned.assignee, .coordinator)
        XCTAssertNotNil(returned.escalateAt)

        // Only the instant is read: the door also answers the held work it released, and the card
        // has no use for it — the item list says the pause is gone by no longer carrying it.
        let resumed = try JSONDecoder().decode(FuseResumed.self, from: Data("""
        {"episode":{"id":"ep"},"resumedAt":"2026-09-21T12:00:00.000Z","held":[{"id":"h"}]}
        """.utf8))
        XCTAssertEqual(resumed.resumedAt, "2026-09-21T12:00:00.000Z")
    }
}
