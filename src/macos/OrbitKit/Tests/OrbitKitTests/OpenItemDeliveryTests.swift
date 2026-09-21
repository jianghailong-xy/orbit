import Foundation
import XCTest
@testable import OrbitKit

/// An exception item's delivery is drawn from the payload the control plane recorded beside the
/// turn's echo (`openItemDelivery`) — never from the paragraph the coordinator was sent.
///
/// The paragraph is written for the AGENT and runs to 30 lines; drawn as a message it reads as
/// something the reader typed, and everything it says about the item (which files a merge conflicted
/// on, which check disagreed, whether the work has landed) is prose. These tests are the client half
/// of the pair the web is held to (`OpenItemDeliveryCard.test.tsx`): with the payload the card is
/// drawn from fields, and without one the turn is exactly what it was before any of this existed.
///
/// `OpenItemDeliveryCopyParityTests` is the other half — it holds the words and the field names to
/// the browser's, since neither end compiles the other.
final class OpenItemDeliveryTests: XCTestCase {

    // MARK: - the payload, as the apiserver writes it (project-open-item.ts `readOpenItemDeliveryCard`)

    /// One `user` event exactly as the server stores it: the runner's echo of the turn, and the card
    /// recorded beside it. Decoded through `RunEvent` rather than handed to the parser as a value, so
    /// what is asserted is the wire path a client actually gets.
    private func delivered(_ card: String, text: String = OpenItemDeliveryTests.told) throws -> RunEvent {
        let json = """
            {"seq": 4, "type": "user", "turnId": "turn-1", "ts": "2026-09-21T12:26:47.307Z",
             "payload": {"text": \(Self.jsonString(text)), "openItemDelivery": \(card)}}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private static func jsonString(_ text: String) -> String {
        let data = try! JSONEncoder().encode(text)
        return String(decoding: data, as: UTF8.self)
    }

    /// The paragraph a delivery really carries (project-open-item.ts `openItemMessage`), Chinese
    /// because the agent reads it, with the doors and the item's id in it. Short here: the client
    /// never reads it, only folds it.
    static let told = """
        【例外待办】Merge conflict: 回填历史 user 事件的 controlPlaneNote

        项目 34ODoUKJGEsfbgcJDGS4q 的一次集成没有把工作放进集成线：
        合并冲突（LAND_TASK），目标分支 refs/heads/project/34ODoUKJGEsfbgcJDGS4q 没有动。
        """

    /// The same card the web's suite fixtures (`OpenItemDeliveryCard.test.tsx`'s `CARD`), field for
    /// field, so the two ends are visibly reading one payload.
    private let conflictCard = """
        {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d",
         "kind": "INTEGRATION_CONFLICT",
         "title": "Merge conflict: 回填历史 user 事件的 controlPlaneNote",
         "task": {"id": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e",
                  "title": "回填历史 user 事件的 controlPlaneNote",
                  "sessionId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f"},
         "files": ["src/web/src/components/Transcript.tsx",
                   "src/apiserver/src/projects/coordinator-delivery.service.ts",
                   "src/web/src/lib/deliveredMessage.ts",
                   "docs/project-integration-line-contract.md",
                   "src/web/src/index.css"],
         "targetRef": "refs/heads/project/34ODoUKJGEsfbgcJDGS4q",
         "check": null, "errorCode": null, "failure": null,
         "actions": ["OPEN_COORDINATOR", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"],
         "landing": {"receipts": 0, "state": "NOT_KNOWN", "upstream": "main", "integration": "main"}}
        """

    // MARK: - (a) a payload with a card decodes to every field of it

    func testReadsEveryFieldOfADeliveredCard() throws {
        let card = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))

        XCTAssertEqual(card.itemId, "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d")
        XCTAssertEqual(card.kind, .integrationConflict)
        XCTAssertEqual(card.title, "Merge conflict: 回填历史 user 事件的 controlPlaneNote")
        XCTAssertEqual(card.task?.id, "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e")
        XCTAssertEqual(card.task?.title, "回填历史 user 事件的 controlPlaneNote")
        XCTAssertEqual(card.task?.sessionId, "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f")
        XCTAssertEqual(card.files, [
            "src/web/src/components/Transcript.tsx",
            "src/apiserver/src/projects/coordinator-delivery.service.ts",
            "src/web/src/lib/deliveredMessage.ts",
            "docs/project-integration-line-contract.md",
            "src/web/src/index.css",
        ])
        XCTAssertEqual(card.targetRef, "refs/heads/project/34ODoUKJGEsfbgcJDGS4q")
        XCTAssertNil(card.check)
        XCTAssertNil(card.errorCode)
        XCTAssertNil(card.failure)
        // The doors arrive as the server's own values, unlabelled: which ones are drawn is the
        // card's business (`actionLabels`), and one this build has never heard of is dropped there
        // rather than here — the reader keeps the payload whole.
        XCTAssertEqual(card.actions, ["OPEN_COORDINATOR", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"])
        XCTAssertEqual(card.landing, OpenItemDeliveryLandingFacts(
            receipts: 0, state: .notKnown, upstream: "main", integration: "main"))
    }

    func testReadsTheFailuresOwnFacts() throws {
        let event = try delivered("""
            {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d", "kind": "TASK_FAILED",
             "title": "Task failed: 回填历史 user 事件的 controlPlaneNote",
             "task": {"id": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e", "title": "回填",
                      "sessionId": null},
             "files": [], "targetRef": null, "check": null, "errorCode": null,
             "failure": {"how": "ACCEPTANCE_EXIT_MISMATCH", "exitCode": 1, "expectedExitCode": 0,
                         "attempt": 2, "limit": 3},
             "actions": ["RETRY", "CANCEL_TASK"],
             "landing": {"receipts": 1, "state": "ON_INTEGRATION_LINE", "upstream": "main",
                         "integration": "project/34ODoUKJGEsfbgcJDGS4q"}}
            """)
        let card = try XCTUnwrap(OpenItemDelivery.parse(event.payload))

        XCTAssertEqual(card.failure?.how, "ACCEPTANCE_EXIT_MISMATCH")
        XCTAssertEqual(card.failure?.exitCode, 1)
        XCTAssertEqual(card.failure?.expectedExitCode, 0)
        XCTAssertEqual(card.failure?.attempt, 2)
        XCTAssertEqual(card.failure?.limit, 3)
        XCTAssertNil(card.task?.sessionId)
        XCTAssertEqual(card.landing?.state, .onIntegrationLine)
        XCTAssertEqual(card.landing?.integration, "project/34ODoUKJGEsfbgcJDGS4q")
    }

    func testReadsTheChecksOwnFactsAndAnIntegrationError() throws {
        let checked = try delivered("""
            {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d", "kind": "INTEGRATION_CHECK_FAILED",
             "title": "Checks failed on the combined tree: 回填", "task": null, "files": [],
             "targetRef": "refs/heads/main",
             "check": {"name": "apiserver", "exitCode": 1, "expectedExitCode": 0},
             "errorCode": null, "failure": null, "actions": [],
             "landing": {"receipts": 0, "state": "NOT_KNOWN", "upstream": "main",
                         "integration": "main"}}
            """)
        let check = try XCTUnwrap(OpenItemDelivery.parse(checked.payload)?.check)
        XCTAssertEqual(check.name, "apiserver")
        XCTAssertEqual(check.exitCode, 1)
        XCTAssertEqual(check.expectedExitCode, 0)

        let errored = try delivered("""
            {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d", "kind": "INTEGRATION_ERROR",
             "title": "Integration error: 回填", "task": null, "files": [],
             "targetRef": "refs/heads/project/x", "check": null, "errorCode": "PUSH_REJECTED",
             "failure": null, "actions": [], "landing": null}
            """)
        let card = try XCTUnwrap(OpenItemDelivery.parse(errored.payload))
        XCTAssertEqual(card.errorCode, "PUSH_REJECTED")
        XCTAssertNil(card.landing, "a card with no landing is a card that says nothing about one")
    }

    // MARK: - (b) no card is ever half-drawn

    /// The three keys that make a payload a card at all (`lib/openItemDelivery.ts`): miss any one and
    /// the whole payload is NOT a card. Half a card would be a delivery drawn from a paragraph with
    /// its fields filled in from whatever the reader guessed.
    func testIsNotACardWithoutTheThreeFieldsThatMakeOne() throws {
        let missing: [String] = [
            #"{"kind": "TASK_FAILED", "title": "t"}"#,                     // no itemId
            #"{"itemId": "", "kind": "TASK_FAILED", "title": "t"}"#,       // empty itemId
            #"{"itemId": "x", "title": "t"}"#,                             // no kind
            #"{"itemId": "x", "kind": 7, "title": "t"}"#,                  // kind is not a string
            #"{"itemId": "x", "kind": "TASK_FAILED"}"#,                    // no title
            #"{"itemId": "x", "kind": "TASK_FAILED", "title": ""}"#,       // empty title
        ]
        for card in missing {
            let event = try delivered(card)
            XCTAssertNil(OpenItemDelivery.parse(event.payload),
                         "this payload is not a card: \(card)")
        }
    }

    func testIsNotACardWhenThePayloadIsNotAnObjectOrIsAbsent() throws {
        // The ordinary case: somebody's message, with the field absent entirely.
        XCTAssertNil(OpenItemDelivery.parse(.object(["text": .string("hello")])))
        // A delivery stored before the payload existed: same event, nothing beside the echo.
        let old = try JSONDecoder().decode(
            RunEvent.self, from: Data(#"{"seq":1,"type":"user","payload":{"text":"【例外待办】…"}}"#.utf8))
        XCTAssertNil(OpenItemDelivery.parse(old.payload))
        // Present but not an object — a value the parser does not recognise is not a card.
        XCTAssertNil(OpenItemDelivery.parse(.object(["openItemDelivery": .string("merge")])))
        XCTAssertNil(OpenItemDelivery.parse(.object(["openItemDelivery": .null])))
        XCTAssertNil(OpenItemDelivery.parse(.object(["openItemDelivery": .array([])])))
        XCTAssertNil(OpenItemDelivery.parse(.null))
        XCTAssertNil(OpenItemDelivery.parse(.array([.string("openItemDelivery")])))
    }

    /// The nested fields are each read the way the web reads them: a value that is not shaped like
    /// its type is the field being ABSENT, never a card that fails to draw over it.
    func testNestedFieldsThatAreNotShapedLikeTheirTypeAreDroppedNotGuessed() throws {
        let event = try delivered("""
            {"itemId": "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d", "kind": "TASK_FAILED",
             "title": "t",
             "task": {"title": "no id"}, "files": ["a", 3, null, "b"],
             "targetRef": "", "check": {"exitCode": 1}, "errorCode": null,
             "failure": {"how": "RUN_FAILED", "attempt": 1},
             "actions": ["RETRY", 5],
             "landing": {"receipts": "none", "state": "NOT_KNOWN", "upstream": "", "integration": ""}}
            """)
        let card = try XCTUnwrap(OpenItemDelivery.parse(event.payload),
                                 "the card itself is fine — its fields are what is thin")

        XCTAssertNil(card.task, "a task without an id names nothing")
        XCTAssertEqual(card.files, ["a", "b"], "only the strings of the file list survive")
        XCTAssertNil(card.targetRef, "an empty target ref is no target ref")
        XCTAssertNil(card.check, "a check without a name is not a check")
        XCTAssertNil(card.failure, "a failure with no limit has no chain to place it in")
        XCTAssertEqual(card.actions, ["RETRY"])
        // The landing's branches default where the payload left them blank, exactly as the web
        // defaults them — but a receipts count that is not a number is no landing at all.
        XCTAssertNil(card.landing)
    }

    func testTheLandingDefaultsItsBranchesAndRejectsAStateItDoesNotKnow() throws {
        let event = try delivered("""
            {"itemId": "x", "kind": "TASK_FAILED", "title": "t",
             "landing": {"receipts": 2, "state": "ON_UPSTREAM"}}
            """)
        let landing = try XCTUnwrap(OpenItemDelivery.parse(event.payload)?.landing)
        XCTAssertEqual(landing.upstream, "main")
        XCTAssertEqual(landing.integration, "main")

        let unknownState = try delivered("""
            {"itemId": "x", "kind": "TASK_FAILED", "title": "t",
             "landing": {"receipts": 2, "state": "PROBABLY", "upstream": "main", "integration": "main"}}
            """)
        XCTAssertNil(OpenItemDelivery.parse(unknownState.payload)?.landing)
    }

    /// A kind this build has never seen still draws — under the card's generic header — rather than
    /// failing the read that carried it (the web's label table degrades the same way).
    func testAKindThisBuildDoesNotKnowStillDraws() throws {
        let event = try delivered(#"{"itemId": "x", "kind": "SOMETHING_NEW", "title": "t"}"#)
        let card = try XCTUnwrap(OpenItemDelivery.parse(event.payload))
        XCTAssertEqual(card.kind, .unknown)
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(card.kind), OpenItemDeliveryCard.header)
    }

    // MARK: - what the card says, out of those fields

    func testNamesTheKindTheWayTheProductNamesIt() {
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.integrationConflict), "Merge conflict")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.integrationCheckFailed), "Checks failed")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.integrationError), "Integration error")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.taskFailed), "Task failed")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.promotionApproval), "Merge approval")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.coordinatorQuestion), "Question")
        XCTAssertEqual(OpenItemDeliveryCard.kindLabel(.fusePaused), "Project paused")
    }

    func testSaysWhyTheItemIsHereOutOfItsOwnFields() throws {
        let conflict = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))
        XCTAssertEqual(OpenItemDeliveryCard.headline(conflict),
                       "git refused the merge into refs/heads/project/34ODoUKJGEsfbgcJDGS4q; the "
                           + "target branch did not move. The platform will not retry it by itself.")

        let failed = try XCTUnwrap(OpenItemDelivery.parse(try delivered("""
            {"itemId": "x", "kind": "TASK_FAILED", "title": "t",
             "failure": {"how": "ACCEPTANCE_EXIT_MISMATCH", "exitCode": 1, "expectedExitCode": 0,
                         "attempt": 2, "limit": 3}}
            """).payload))
        XCTAssertEqual(OpenItemDeliveryCard.headline(failed),
                       "The acceptance command disagreed with what the task declared — exit 1, "
                           + "expected 0 · attempt 2 of 3 in this chain.")

        // A failure whose exit code the payload never recorded says which half it is missing rather
        // than inventing a zero: "exit 0, expected 0" would read as a clean run that failed anyway.
        let codeless = try XCTUnwrap(OpenItemDelivery.parse(try delivered("""
            {"itemId": "x", "kind": "TASK_FAILED", "title": "t",
             "failure": {"how": "RUN_FAILED", "attempt": 1, "limit": 3}}
            """).payload))
        XCTAssertEqual(OpenItemDeliveryCard.headline(codeless),
                       "A turn of the run failed · attempt 1 of 3 in this chain.")

        // A kind with no fact of its own beyond the title says nothing extra.
        let question = try XCTUnwrap(OpenItemDelivery.parse(try delivered("""
            {"itemId": "x", "kind": "COORDINATOR_QUESTION", "title": "Coordinator asks: merge?"}
            """).payload))
        XCTAssertNil(OpenItemDeliveryCard.headline(question))
    }

    /// The one line the card exists for: what the platform already knew about the landing, which the
    /// coordinator otherwise re-checks by hand every time an item comes round. `NOT_KNOWN` is said as
    /// what it is — no receipt is no EVIDENCE, never "it did not land".
    func testSaysTheLandingInTheThreeCases() throws {
        func landing(_ json: String) throws -> (text: String, landed: Bool) {
            let event = try delivered(#"{"itemId": "x", "kind": "TASK_FAILED", "title": "t", "landing": \#(json)}"#)
            let card = try XCTUnwrap(OpenItemDelivery.parse(event.payload))
            return try XCTUnwrap(OpenItemDeliveryCard.landingLine(card))
        }

        let upstream = try landing(#"{"receipts": 1, "state": "ON_UPSTREAM", "upstream": "main", "integration": "main"}"#)
        XCTAssertEqual(upstream.text, "Already on main — a merge receipt records this work there.")
        XCTAssertTrue(upstream.landed)

        let line = try landing(#"{"receipts": 2, "state": "ON_INTEGRATION_LINE", "upstream": "main", "integration": "project/x"}"#)
        XCTAssertEqual(line.text, "On project/x, not yet on main — a merge receipt records it on "
                       + "the project branch.")
        XCTAssertTrue(line.landed)

        let none = try landing(#"{"receipts": 0, "state": "NOT_KNOWN", "upstream": "main", "integration": "main"}"#)
        XCTAssertEqual(none.text, "No merge receipt for this work — Orbit cannot tell whether it has "
                       + "landed.")
        XCTAssertFalse(none.landed)

        // Receipts that exist but name another branch: the count is said, and what it does not
        // answer is said with it.
        let some = try landing(#"{"receipts": 2, "state": "NOT_KNOWN", "upstream": "main", "integration": "project/x"}"#)
        XCTAssertEqual(some.text, "2 merge receipts, none naming main — Orbit cannot tell whether "
                       + "this work has landed.")
        let one = try landing(#"{"receipts": 1, "state": "NOT_KNOWN", "upstream": "main", "integration": "main"}"#)
        XCTAssertEqual(one.text, "1 merge receipt, none naming main — Orbit cannot tell whether this "
                       + "work has landed.")
        XCTAssertFalse(one.landed)

        // No landing in the payload: no line, rather than a line about nothing.
        let absent = try XCTUnwrap(OpenItemDelivery.parse(
            try delivered(#"{"itemId": "x", "kind": "TASK_FAILED", "title": "t"}"#).payload))
        XCTAssertNil(OpenItemDeliveryCard.landingLine(absent))
    }

    /// The doors, in the server's order, and only the ones a reader can name here: the coordinator's
    /// own conversation and the session link are drawn as themselves (web leads its chips the same
    /// way), and a value this build does not know has no label to draw.
    func testDrawsTheDoorsTheServerOfferedAndNoOthers() throws {
        let card = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))
        XCTAssertEqual(OpenItemDeliveryCard.actionLabels(card.actions),
                       ["Retry the task", "Cancel the task"])

        XCTAssertEqual(OpenItemDeliveryCard.actionLabels(
            ["ASK_COORDINATOR_AGAIN", "REVIEW", "ANSWER", "RESUME", "SOMETHING_NEW"]),
            ["Ask the coordinator again", "Review the merge", "Answer the question",
             "Resume the project"])
        XCTAssertEqual(OpenItemDeliveryCard.actionLabels([]), [])
    }

    func testFoldsTheFileListPastThree() throws {
        let card = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))
        XCTAssertEqual(OpenItemDeliveryCard.filesShown, 3)
        XCTAssertEqual(OpenItemDeliveryCard.filesToggle(total: card.files.count, expanded: false),
                       "Show 2 more files")
        XCTAssertEqual(OpenItemDeliveryCard.filesToggle(total: card.files.count, expanded: true),
                       "Show fewer files")
        // Nothing folded means nothing to press.
        XCTAssertNil(OpenItemDeliveryCard.filesToggle(total: 3, expanded: false))
        XCTAssertNil(OpenItemDeliveryCard.filesToggle(total: 3, expanded: true))
        XCTAssertNil(OpenItemDeliveryCard.filesToggle(total: 0, expanded: false))
    }

    /// The foot line, in the spelling the web draws it in: the item's PUBLIC id — the payload carries
    /// a uuid, and both clients show the base62 one.
    func testDrawsTheItemIdInThePublicSpellingAndTheTimeItArrived() throws {
        let card = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-21T12:29:47Z"))
        // The card says the age the way every other row does — `RelativeTime`, which floors: 179
        // seconds is 2 minutes.
        XCTAssertEqual(OpenItemDeliveryCard.meta(card, ts: "2026-09-21T12:26:47.307Z", now: now),
                       "Item 30sxqUAeWVTWSpHLLkk73 · a notification, not an interruption · 2m ago")
        XCTAssertEqual(OpenItemDeliveryCard.meta(card),
                       "Item 30sxqUAeWVTWSpHLLkk73 · a notification, not an interruption",
                       "an event with no clock says only what the card is")
        // An id in neither spelling is left alone: this line is a footnote, not a link.
        let odd = try XCTUnwrap(OpenItemDelivery.parse(try delivered(#"{"itemId": "not-an-id", "kind": "TASK_FAILED", "title": "t"}"#).payload))
        XCTAssertEqual(OpenItemDeliveryCard.meta(odd),
                       "Item not-an-id · a notification, not an interruption")
    }

    /// Where the two links go: the app's own `orbit-task:` / `orbit-session:` doors, which both
    /// shells route (`ReferenceLink`), and nothing at all for an item that is about no task.
    func testLinksToTheTaskAndItsSession() throws {
        let card = try XCTUnwrap(OpenItemDelivery.parse(try delivered(conflictCard).payload))
        XCTAssertEqual(OpenItemDeliveryCard.taskLink(card)?.absoluteString,
                       "orbit-task:0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e")
        XCTAssertEqual(OpenItemDeliveryCard.sessionLink(card)?.absoluteString,
                       "orbit-session:0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f")

        let promotion = try XCTUnwrap(OpenItemDelivery.parse(try delivered("""
            {"itemId": "x", "kind": "PROMOTION_APPROVAL", "title": "Approve merge to main",
             "task": null, "actions": ["REVIEW"]}
            """).payload))
        XCTAssertNil(OpenItemDeliveryCard.taskLink(promotion))
        XCTAssertNil(OpenItemDeliveryCard.sessionLink(promotion))
    }

    // MARK: - (c) a delivery with no card keeps the reading it has always had

    /// The negative control, at the reducer: the same conversation, the same words, nothing recorded
    /// beside them. The turn is the person's own bubble holding exactly that text — and `itemCard` is
    /// nil, which is what the console checks before it draws a delivery as anything else.
    func testADeliveryWithNoPayloadStaysTheMessageItAlwaysWas() throws {
        // The paragraph as a JSON string literal — the echo a real event carries is escaped, since
        // the delivery is many lines of prose.
        let text = Self.jsonString(Self.told)
        for payload in ["{\"text\": \(text)}",
                        "{\"text\": \(text), \"openItemDelivery\": null}",
                        "{\"text\": \(text), \"openItemDelivery\": {\"kind\": \"TASK_FAILED\"}}"] {
            let event = try JSONDecoder().decode(
                RunEvent.self, from: Data("{\"seq\": 4, \"type\": \"user\", \"payload\": \(payload)}".utf8))
            var reducer = TranscriptReducer()
            reducer.apply(event)

            let bubble = try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
                guard case .user(let b) = item else { return nil }
                return b
            })
            XCTAssertNil(bubble.itemCard)
            XCTAssertEqual(bubble.text, Self.told, "the echo is left exactly as it was")
        }
    }

    /// The other end of the same rule: with the payload, the turn still holds the paragraph — folded
    /// by the card rather than dropped with it — and the bar that names it reads the card's words.
    func testADeliveryWithAPayloadCarriesTheCardAndKeepsTheParagraph() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try delivered(conflictCard))

        let bubble = try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        })
        XCTAssertEqual(bubble.itemCard?.itemId, "0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d")
        XCTAssertEqual(bubble.text, Self.told, "the paragraph the agent read is folded, not dropped")

        let summary = StickySummary.of(text: bubble.text, note: bubble.note, itemCard: bubble.itemCard)
        XCTAssertEqual(summary.label, "↑ Exception item")
        // The kind, then the item's own title — which in this product already opens with the kind
        // ("Merge conflict: <task>", §4.2), so the bar reads it twice. That is the browser's own
        // pair, copied rather than improved on: `OpenItemDeliveryCopyParityTests` holds the two ends
        // to the same words, and a bar that quietly dropped half of one would be a third wording.
        XCTAssertEqual(summary.text, "Merge conflict: Merge conflict: 回填历史 user 事件的 controlPlaneNote")
    }

    /// A cached transcript written before the card existed rehydrates: the key is absent, so the
    /// deliveries in it keep the reading they had — and one written with the card keeps it.
    func testASnapshotFromBeforeTheCardStillRehydrates() throws {
        // A `TranscriptItem` is a Codable enum with associated values, so each row is nested under
        // its case's `_0` — this is the shape the store writes, without the `itemCard` key.
        let snapshot = #"""
            {"state":{"items":[{"user":{"_0":{"id":"i1","text":"【例外待办】…","attachments":[],
              "pending":false,"queued":false,"undelivered":false,"steer":false}}}],
              "pendingApprovals":[],"background":[],"queued":[],"status":"AWAITING_INPUT","maxSeq":4},
             "seen":[4],"idSeq":1}
            """#
        let restored = try JSONDecoder().decode(TranscriptReducer.self, from: Data(snapshot.utf8))
        guard case .user(let old)? = restored.state.items.first else {
            return XCTFail("the cached turn came back as something other than a user bubble")
        }
        XCTAssertNil(old.itemCard)
        XCTAssertEqual(old.text, "【例外待办】…")

        var live = TranscriptReducer()
        live.apply(try delivered(conflictCard))
        let round = try JSONDecoder().decode(TranscriptReducer.self,
                                            from: JSONEncoder().encode(live))
        guard case .user(let kept)? = round.state.items.first else {
            return XCTFail("the delivery came back as something other than a user bubble")
        }
        XCTAssertEqual(kept.itemCard, live.state.items.first.flatMap { item -> OpenItemDelivery? in
            guard case .user(let b) = item else { return nil }
            return b.itemCard
        })
    }
}
