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
        /// Where the item is on its way to the coordinator: the address `Open coordinator` reaches.
        var delivery: ProjectOpenItemRow.Delivery?
        var actions: [ProjectOpenItemAction] = [.askCoordinatorAgain, .openTaskSession, .cancelTask]
        var question: CoordinatorQuestion?
        /// What the item's payload holds, as the read serves it (§7.5). Nil for an older item.
        var facts: OpenItemFacts?

        func build() -> ProjectOpenItemRow {
            ProjectOpenItemRow(itemId: itemId, kind: kind, title: title, detailLine: detailLine,
                               waitingSince: waitingSince, assignee: assignee,
                               assigneeReason: assigneeReason, escalateAt: escalateAt,
                               escalatedAt: escalatedAt, taskId: taskId, sessionId: sessionId,
                               fuseEpisodeId: fuseEpisodeId, delivery: delivery, actions: actions,
                               question: question, facts: facts)
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

    // MARK: the fact block (§7.5, mock 5)

    /// (a) A check that disagreed on the combined tree. The card said "Checks failed" and nothing
    /// about the check: not which command ran, what it returned, or why. Every one of those was a
    /// field of the item's payload the whole time, and this is the row that draws them.
    func testAFailedCheckDrawsItsCommandItsVerdictAndItsLog() throws {
        let decoded = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
        {"itemId":"01a0bb0b","kind":"INTEGRATION_CHECK_FAILED",
         "title":"Checks failed on the combined tree: 核实 ScheduleWakeup 是否随 warm 回收丢失",
         "detailLine":"the merge check exited 1", "assignee":"OWNER","assigneeReason":"ESCALATED",
         "waitingSince":"2026-09-19T19:01:41.497Z","escalatedAt":"2026-09-19T21:02:23.903Z",
         "taskId":"01a03f58","sessionId":"489fc485","promotionId":null,"fuseEpisodeId":null,
         "delivery":{"state":"NOT_REQUIRED","sessionId":null,"at":null},
         "actions":["ASK_COORDINATOR_AGAIN","OPEN_TASK_SESSION","CANCEL_TASK"],"question":null,
         "facts":{"task":{"id":"01a03f58","title":"核实 ScheduleWakeup 是否随 warm 回收丢失"},
                  "targetRef":"project/bg-jobs","targetSha":"b70a4461c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
                  "files":[],"nothingLanded":false,
                  "check":{"name":"MERGE_CHECK",
                           "command":"cd src/runner-go && go test -count=1 ./...",
                           "expectedExitCode":0,"exitCode":1,"timedOut":false,
                           "durationMs":340000,
                           "outputTail":"\\u001b[31m--- FAIL: TestScheduleWakeup\\u001b[0m\\n    wake_test.go:88: wake not delivered\\nFAIL\\torbit\\t341.207s"},
                  "branchUnchanged":true,"errorCode":null,"failure":null}}
        """.utf8))
        XCTAssertEqual(decoded.kind, .integrationCheckFailed)
        guard case .rows(let block) = ExceptionCards.facts(decoded) else {
            return XCTFail("a payload this build reads draws rows, not the server's sentence")
        }
        // The mock's own rows, in its own words, from the payload's own fields.
        XCTAssertEqual(block.rows, [
            ExceptionCards.FactRow(label: "Task", value: "核实 ScheduleWakeup 是否随 warm 回收丢失"),
            ExceptionCards.FactRow(label: "Into", value: "project/bg-jobs at b70a446"),
            ExceptionCards.FactRow(
                label: "Check",
                value: "cd src/runner-go && go test -count=1 ./... · exit 1 after 5m 40s"),
            ExceptionCards.FactRow(label: "Branch", value: ExceptionCards.branchUnchanged),
        ])
        try requireTheBrowsersWords()
        // The tail is the last 16 KB of what the check printed, with its colour off — an ESC byte
        // is invisible in a native Text, so what would show is literal "[31m" garbage.
        let tail = try XCTUnwrap(block.logTail)
        XCTAssertEqual(tail.lines, ["--- FAIL: TestScheduleWakeup", "    wake_test.go:88: wake not delivered",
                                    "FAIL\torbit\t341.207s"])
        XCTAssertEqual(tail.shown, tail.lines, "three lines fit under the fold")
        XCTAssertNil(tail.more)
    }

    /// A tail longer than the fold keeps its END on screen and offers the rest: the reason a check
    /// is red is the last thing it printed, which is the whole reason this block folds from there.
    func testALongCheckLogIsFoldedFromTheEnd() throws {
        let written = (1...9).map { "line \($0)" }
        let check = IntegrationCheckResult(name: "MERGE_CHECK", command: "go test ./...",
                                           exitCode: 1, durationMs: 1_000,
                                           outputTail: written.joined(separator: "\n"))
        let facts = OpenItemFacts(check: check)
        guard case .rows(let block) = ExceptionCards.facts(row { $0.kind = .integrationCheckFailed
                                                                  $0.facts = facts }) else {
            return XCTFail("a check draws rows")
        }
        let tail = try XCTUnwrap(block.logTail)
        XCTAssertEqual(tail.hidden, 3)
        XCTAssertEqual(tail.shown, Array(written.suffix(6)), "the last lines are the ones drawn")
        XCTAssertEqual(tail.more, "Show 3 more lines")
        XCTAssertEqual(ExceptionCards.CheckTail.less, "Show less")
        // A check that printed nothing draws no block at all: there is nothing to fold.
        XCTAssertNil(ExceptionCards.CheckTail.of("   \n  "))
        XCTAssertNil(ExceptionCards.CheckTail.of(nil))
    }

    /// (b) A conflicting merge: the files git could not reconcile, and the fact the reader asks
    /// first — whether the branch it was landing on moved while this failed.
    func testAConflictDrawsTheFilesAndWhetherTheTargetMoved() throws {
        let decoded = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
        {"itemId":"01a0bb0b","kind":"INTEGRATION_CONFLICT","title":"Merge conflict",
         "detailLine":"git refused the merge into project/bg-jobs","assignee":"OWNER",
         "assigneeReason":"ESCALATED","waitingSince":"2026-09-19T19:01:41.497Z",
         "escalatedAt":"2026-09-19T21:02:23.903Z","taskId":"01a03f58","sessionId":"489fc485",
         "actions":["ASK_COORDINATOR_AGAIN","OPEN_TASK_SESSION","CANCEL_TASK"],
         "facts":{"task":{"id":"01a03f58","title":"runner 托管作业支持「事件发生时叫醒会话」"},
                  "targetRef":"project/bg-jobs","targetSha":"b70a4461c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
                  "files":["src/runner-go/session_pool.go","background.go","mcp.go"],
                  "nothingLanded":true,"branchUnchanged":false}}
        """.utf8))
        guard case .rows(let block) = ExceptionCards.facts(decoded) else {
            return XCTFail("a conflict's payload draws rows")
        }
        XCTAssertEqual(block.rows, [
            ExceptionCards.FactRow(label: "Task", value: "runner 托管作业支持「事件发生时叫醒会话」"),
            ExceptionCards.FactRow(
                label: "Into",
                value: "project/bg-jobs at b70a446 · nothing landed"),
            ExceptionCards.FactRow(
                label: "Files",
                value: "src/runner-go/session_pool.go · background.go · mcp.go", mono: true),
            ExceptionCards.FactRow(label: "After a fix", value: ExceptionCards.afterAFix),
        ])
        XCTAssertNil(block.logTail, "a conflict has no check output to fold")
        // `nothing landed` is the payload's own answer and not inferred from the ref: a target that
        // DID move draws the same row without it.
        let moved = OpenItemFacts(targetRef: "project/bg-jobs", targetSha: "b70a446")
        guard case .rows(let quietly) = ExceptionCards.facts(row { $0.facts = moved }) else {
            return XCTFail("a ref draws rows")
        }
        XCTAssertEqual(quietly.rows, [ExceptionCards.FactRow(label: "Into", value: "project/bg-jobs at b70a446")])
    }

    /// A failed task's two rows: why the attempt failed and where its chain stands (§4.5) — the
    /// second of which is what says whether this is still the coordinator's to retry.
    func testAFailedTaskDrawsWhyAndWhereItsChainStands() {
        let failure = OpenItemFacts.Failure(how: "ACCEPTANCE_EXIT_MISMATCH", exitCode: 1,
                                            expectedExitCode: 0, attempt: 2, limit: 3)
        guard case .rows(let block) = ExceptionCards.facts(row { $0.facts = OpenItemFacts(failure: failure) })
        else { return XCTFail("a failed task's payload draws rows") }
        XCTAssertEqual(block.rows, [
            ExceptionCards.FactRow(label: "How", value: "the acceptance command exited 1 (expected 0)"),
            ExceptionCards.FactRow(label: "Retries",
                                   value: "attempt 2 of 3 in this chain — the 3rd failure goes "
                                       + "straight to the owner"),
        ])
        // The last failure of a chain is the owner's rather than the coordinator's, and the row says
        // which of the two it is looking at.
        let last = OpenItemFacts.Failure(how: "RUN_FAILED", attempt: 3, limit: 3)
        XCTAssertEqual(ExceptionCards.chainStanding(last),
                       "attempt 3 of 3 in this chain — this one is the owner's")
        // An unknown reason is still a sentence rather than a blank, and one with no exit code
        // quotes none — the browser's own two fallbacks.
        XCTAssertEqual(ExceptionCards.howFailed(OpenItemFacts.Failure(how: "SOMETHING_NEW")),
                       "the task failed")
        XCTAssertEqual(ExceptionCards.howFailed(OpenItemFacts.Failure(how: "RUN_FAILED")),
                       "a turn of the run failed")
        XCTAssertEqual(ExceptionCards.ordinal(1), "1st")
        XCTAssertEqual(ExceptionCards.ordinal(11), "11th")
        XCTAssertEqual(ExceptionCards.ordinal(22), "22nd")
        // The counts are the payload's: a row that guessed "attempt 1 of 3" would be describing a
        // chain nobody read, so a payload without them draws no such row.
        XCTAssertNil(ExceptionCards.chainStanding(OpenItemFacts.Failure(how: "RUN_FAILED")))
        guard case .rows(let partial) =
                ExceptionCards.facts(row { $0.facts = OpenItemFacts(failure: .init(how: "RUN_FAILED")) })
        else { return XCTFail("rows") }
        XCTAssertEqual(partial.rows.map(\.label), ["How"])
    }

    /// (e) The negative control: a payload this build cannot read — an item an older build opened,
    /// a pause, a question — draws exactly what the card drew before the rows existed, and one
    /// missing every key draws no rows rather than throwing or showing blanks.
    func testAPayloadWithoutTheKeysDrawsWhatTheCardDrewBefore() throws {
        let older = row { $0.facts = nil }
        XCTAssertEqual(ExceptionCards.facts(older), .detailLine(older.detailLine),
                       "no payload is the server's own sentence, not an empty block")

        let empty = try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
        {"itemId":"x","kind":"INTEGRATION_ERROR","title":"t","detailLine":"the job ended early",
         "waitingSince":"2026-09-19T19:01:41.497Z","assignee":"OWNER","facts":{}}
        """.utf8))
        guard case .rows(let block) = ExceptionCards.facts(empty) else {
            return XCTFail("a payload this build reads draws its rows, empty when it names nothing")
        }
        XCTAssertTrue(block.rows.isEmpty)
        XCTAssertNil(block.logTail)

        // And a check whose payload carries no output — older builds wrote none — draws its verdict
        // and no log, rather than a block with an empty pre in it.
        let quiet = row { $0.kind = .integrationCheckFailed
                          $0.facts = OpenItemFacts(check: IntegrationCheckResult(
                              name: "MERGE_CHECK", command: "npm test", exitCode: 1, durationMs: 48_000)) }
        guard case .rows(let rows) = ExceptionCards.facts(quiet) else { return XCTFail("rows") }
        XCTAssertEqual(rows.rows, [ExceptionCards.FactRow(label: "Check",
                                                          value: "npm test · exit 1 after 48s")])
        XCTAssertNil(rows.logTail)
    }

    /// The two sentences this card must not have invented: every label and every word around a value
    /// is the browser's, taken from mock 5 through `ItemFactRows`.
    private func requireTheBrowsersWords() throws {
        let web = try webSource()
        for label in ["Task", "Into", "Files", "After a fix", "Check", "Branch", "How", "Retries",
                      "Error"] {
            try require(web, "label=\"\(label)\"")
        }
        try require(web, "' · nothing landed'")
        try require(web, ExceptionCards.afterAFix)
        try require(web, ExceptionCards.branchUnchanged)
        try require(web, " after ${checkDuration(check.durationMs)}")
        try require(web, "return check.timedOut ? 'timed out' : 'no exit code'")
        try require(web, "'the acceptance command exited'")
        try require(web, "'a turn of the run failed'")
        try require(web, "'the runner finished the run as failed'")
        try require(web, "'the run stopped on an API or sign-in error and was reaped'")
        try require(web, "'its runner went offline and the attempt was taken back'")
        try require(web, "'its runtime never started and the attempt was taken back'")
        try require(web, "'somebody filed it as failed'")
        try require(web, "?? 'the task failed'")
        try require(web, "`attempt ${failure.attempt} of ${failure.limit} in this chain`")
        try require(web, "— this one is the owner's")
        try require(web, "failure goes straight to the owner")
        try require(web, "`exit ${check.exitCode}`")
        try require(web, "`Show ${hidden} more lines`")
        try require(web, "'Show less'")
        try require(web, "const CHECK_TAIL_LINES = \(ExceptionCards.CheckTail.foldedLines)")
        // The browser's own ordinal, which the mock uses for the failure that stops being the
        // coordinator's.
        try require(web, "['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'")
    }

    /// (c) The three weights of the action row (mock 7 方案 B), door by door: the press this kind of
    /// exception is asking for leads, the same step taken another way sits beside it, and the two
    /// doors that only look or only stop come after them, quiet.
    func testTheThreeWeightsAreTheMockAndTheBrowsersOwn() throws {
        // The three kinds the mock draws, for the coordinator. A conflict and a red combined-tree
        // check both want the branch fixed, so the way onto that branch leads and a fresh run is the
        // alternative; a task that failed wants another run.
        let coordinator: [ProjectOpenItemAction] = [.openCoordinator, .openTaskSession, .retry,
                                                    .cancelTask]
        func served(_ kind: ProjectOpenItemKind,
                    _ actions: [ProjectOpenItemAction],
                    assignee: ProjectOpenItemAssignee = .coordinator)
            -> [(ProjectOpenItemAction, ExceptionCards.PressTier)] {
            let row = row { $0.kind = kind; $0.actions = actions; $0.assignee = assignee
                            $0.assigneeReason = assignee == .owner ? .escalated : .defaultReason
                            // A live coordinator conversation to look in on: the address
                            // `Open coordinator` reaches, without which it is not drawn at all.
                            $0.delivery = .init(state: "DELIVERED", sessionId: "489fc485") }
            return ExceptionCards.presses(row).map { ($0.action, $0.tier) }
        }
        let conflict = served(.integrationConflict, coordinator)
        XCTAssertEqual(conflict.map { $0.0 },
                       [.openTaskSession, .retry, .openCoordinator, .cancelTask],
                       "the pair first, then the rest of the server's list in its own order")
        XCTAssertEqual(conflict.map { $0.1 }, [.primary, .secondary, .link, .link])
        let red = served(.integrationCheckFailed, coordinator)
        XCTAssertEqual(red.map { $0.0 },
                       [.openTaskSession, .retry, .openCoordinator, .cancelTask])
        XCTAssertEqual(red.map { $0.1 }, [.primary, .secondary, .link, .link])
        let failed = served(.taskFailed, coordinator)
        XCTAssertEqual(failed.map { $0.0 }, [.retry, .openTaskSession, .openCoordinator, .cancelTask])
        XCTAssertEqual(failed.map { $0.1 }, [.primary, .secondary, .link, .link])
        // A kind the mock does not draw keeps the server's own order rather than being handed a
        // step nobody asked for: the same pair, taken from where the server listed them.
        let error = served(.integrationError, coordinator)
        XCTAssertEqual(error.map { $0.0 }, [.openTaskSession, .retry, .openCoordinator, .cancelTask])
        XCTAssertEqual(error.map { $0.1 }, [.primary, .secondary, .link, .link])

        // The owner's card: the work is not theirs to run again, so the way back to the coordinator
        // leads and the run sits beside it (mock 7, 方案 B's fourth card).
        let owner = served(.taskFailed, [.askCoordinatorAgain, .openTaskSession, .cancelTask],
                           assignee: .owner)
        XCTAssertEqual(owner.map { $0.0 }, [.askCoordinatorAgain, .openTaskSession, .cancelTask])
        XCTAssertEqual(owner.map { $0.1 }, [.primary, .secondary, .link])
        // A door the row carries no address for is not drawn at all — never drawn and refused.
        let unaddressed = row { $0.kind = .taskFailed; $0.taskId = nil; $0.sessionId = nil
                                $0.assignee = .owner
                                $0.actions = [.askCoordinatorAgain, .openTaskSession, .retry,
                                              .cancelTask] }
        XCTAssertEqual(ExceptionCards.drawn(unaddressed), [.askCoordinatorAgain],
                       "the two task doors need a task, and ASK_COORDINATOR_AGAIN needs only the item")
        XCTAssertEqual(ExceptionCards.presses(unaddressed).map(\.tier), [.primary])
        // An action this build cannot name is not a press, and never becomes one.
        let unknown = row { $0.actions = [.unknown, .askCoordinatorAgain] }
        XCTAssertEqual(ExceptionCards.drawn(unknown), [.askCoordinatorAgain])

        // The words the two cards share, and the mock's own shape for them.
        let web = try webSource()
        try require(web, "OPEN_TASK_SESSION: '\(ExceptionCards.openTaskSession)'")
        try require(web, "const LEADING_ACTIONS: ReadonlySet<OpenItemAction> = new Set<OpenItemAction>([")
        for action in ["OPEN_TASK_SESSION", "RETRY", "ASK_COORDINATOR_AGAIN"] {
            try require(web, "'\(action)',")
        }
        try require(web, "INTEGRATION_CONFLICT: 'OPEN_TASK_SESSION'")
        try require(web, "INTEGRATION_CHECK_FAILED: 'OPEN_TASK_SESSION'")
        try require(web, "TASK_FAILED: 'RETRY'")
    }

    /// (d) The owner's own ending (§4.7, mock 7 方案 B): offered only where the item is theirs and
    /// its kind is one the door closes by hand, drawn last and quietest, and never sent without a
    /// reason — the door requires one.
    func testTheOwnersEndingIsOfferedLastAndNeverSentWithoutAReason() throws {
        XCTAssertTrue(ExceptionCards.markable(row()))
        // An item the coordinator is still carrying is the coordinator's to close (§4.7).
        XCTAssertFalse(ExceptionCards.markable(row { $0.assignee = .coordinator
                                                      $0.assigneeReason = .defaultReason }))
        // The three kinds with doors of their own: a question is answered, a merge is decided, a
        // pause is resumed — the server's `HAND_CLOSABLE_RESOLUTIONS` refuses all three.
        for kind: ProjectOpenItemKind in [.coordinatorQuestion, .promotionApproval, .fusePaused,
                                          .unknown] {
            XCTAssertFalse(ExceptionCards.markable(row { $0.kind = kind }),
                           "\(kind.rawValue) is not closed by hand")
        }
        for kind: ProjectOpenItemKind in [.integrationConflict, .integrationCheckFailed,
                                          .integrationError, .taskFailed] {
            XCTAssertTrue(ExceptionCards.markable(row { $0.kind = kind }))
        }

        // The reason is required: empty is not a press at all, and what travels is the trimmed one.
        XCTAssertNil(ExceptionCards.markHandledRequest(""))
        XCTAssertNil(ExceptionCards.markHandledRequest("   \n\t "))
        XCTAssertEqual(ExceptionCards.markHandledRequest("  landed by hand  ")?.note, "landed by hand")

        // It is drawn after the server's own doors and never as one of the pair: it is not on the
        // server's list at all, which is why it is the last thing in the row and the lightest — and
        // why an item nothing listed still has it.
        let unlisted = row { $0.actions = [] }
        XCTAssertTrue(ExceptionCards.presses(unlisted).isEmpty,
                      "the row's own list decides the doors: none listed is none drawn")
        XCTAssertTrue(ExceptionCards.markable(unlisted),
                      "and the ending is drawn from the KIND rather than from that list, which is "
                      + "why a project whose work was landed by hand had no press at all")
        XCTAssertEqual(ExceptionCards.presses(row()).last?.tier, .link,
                       "the doors the server lists end the row; the ending comes after them")

        // Every word of it is the browser's, including the two sentences the dialog is about.
        let web = try webSource()
        XCTAssertEqual(ExceptionCards.markHandled, try declaration(web, "MARK_HANDLED"))
        XCTAssertEqual(ExceptionCards.markHandledTitle,
                       try declaration(web, "MARK_HANDLED_MODAL_TITLE"))
        XCTAssertEqual(ExceptionCards.markHandledBody,
                       try declaration(web, "MARK_HANDLED_MODAL_BODY"))
        try require(web, "Why is it no longer open?")
        try require(web, "headline=\"The item was not closed\"")
        // And the same four kinds the browser closes by hand, in the same set the server's own door
        // names.
        for kind in ["INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR",
                     "TASK_FAILED"] {
            try require(web, "'\(kind)',")
        }
        // The door and its receipt, as the wire serves them.
        let resolved = try JSONDecoder().decode(OpenItemResolved.self, from: Data("""
        {"itemId":"01a0bb0b","state":"RESOLVED","resolution":"HANDLED"}
        """.utf8))
        XCTAssertEqual(resolved.resolution, "HANDLED")
    }
}
