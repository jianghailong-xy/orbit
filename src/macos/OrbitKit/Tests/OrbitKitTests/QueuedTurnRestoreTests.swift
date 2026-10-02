import Foundation
import XCTest
@testable import OrbitKit

/// What the console puts back into the composer when turns come off the queue unrun.
///
/// On 2026-09-25 an iPhone's composer filled with a `<background-job-wake>` block: the turn the
/// control plane had queued for a finished `bg_run` job (session 01a0d619…, the interrupt at seq
/// 8067). Two things put it there, and either was enough on its own:
///
///  - The runner, shutting down mid-turn, marked that turn `interrupt {reason: runner_restart}`.
///    The console read it as a Stop, which drops the queue server-side, so it cleared its own queue
///    and folded what had been in it into the composer. Nothing had been dropped: the wake was still
///    queued, and it was delivered two minutes later.
///  - What it folded back was a turn nobody typed. Only a watch's wake was kept out of the composer;
///    the control plane's wakes, an exception item's delivery and a project's start were not — on a
///    real Stop or a Cancel just as much.
final class QueuedTurnRestoreTests: XCTestCase {

    /// The turn that was folded into the composer, as the queued-turn list serves it.
    private static let backgroundWake = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_10bca948d369｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dispatch-priority.pg.spec.ts｜land gate: re-verify on main 10005b52f
              ended｜completed｜exit code 0
              output /root/.orbit/runs/01a0d619-3b66-779a-99c9-14130651347d/bgj_10bca948d369.output｜this covers bytes 0–821
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
        </background-job-wake>
        """

    private static let scheduledWakeup = """
        <scheduled-wakeup>
          The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:
            2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z
            reason: waiting for CI run 4242
            what you left for this turn:
              read the CI result and fix what failed
          The control plane recorded this for you; the user did not say it. To wait again, call mcp__orbit__schedule_wakeup again.
        </scheduled-wakeup>
        """

    private func interrupt(_ payload: [String: JSONValue]) -> RunEvent {
        RunEvent(seq: 8067, type: .interrupt, payload: .object(payload))
    }

    // MARK: which interrupt drops the queue

    /// A runner going down mid-turn is not a Stop: the control plane re-delivers the cut-short turn
    /// and every turn queued behind it is still delivered after it.
    func testARunnerRestartLeavesTheQueueWhereItIs() {
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([QueuedTurnInfo(turnId: "t-wake", content: Self.backgroundWake)],
                               knownBefore: [])
        r.addOptimisticUser(clientTurnId: "c1", text: "and then deploy", queued: true)
        let restart = interrupt(["reason": .string("runner_restart")])

        XCTAssertFalse(TranscriptReducer.dropsQueue(restart))
        r.apply(restart)

        XCTAssertEqual(r.state.queued.map(\.text), [Self.backgroundWake, "and then deploy"],
                       "nothing was dropped server-side, so nothing leaves the local queue")
        XCTAssertEqual(r.state.status, .interrupted, "the turn it cut short still reads as interrupted")
    }

    /// The interrupts a Stop produces still drop it: the claude runner's, which names the request it
    /// answered, and every other engine's, which carries nothing.
    func testAStopStillDropsTheQueue() {
        for payload: [String: JSONValue] in [["requestId": .string("ctrl-1")], [:]] {
            var r = TranscriptReducer()
            r.addOptimisticUser(clientTurnId: "c1", text: "queued one", queued: true)
            XCTAssertTrue(TranscriptReducer.dropsQueue(interrupt(payload)), "\(payload)")
            r.apply(interrupt(payload))
            XCTAssertTrue(r.state.queued.isEmpty, "\(payload)")
        }
        XCTAssertFalse(TranscriptReducer.dropsQueue(RunEvent(seq: 1, type: .turnEnd, payload: .object([:]))))
    }

    // MARK: what may come back

    private func bubble(_ text: String, itemCard: OpenItemDelivery? = nil,
                        startedCard: ProjectStarted? = nil) -> UserBubble {
        UserBubble(id: "server-t1", text: text, turnId: "t1", pending: true, queued: true,
                   itemCard: itemCard, startedCard: startedCard)
    }

    func testWhatSomebodyTypedComesBackTrimmed() {
        XCTAssertEqual(ComposerLogic.restorableText(of: bubble("  and then deploy\n")), "and then deploy")
        XCTAssertNil(ComposerLogic.restorableText(of: bubble(" \n ")), "nothing to give back")
    }

    /// Every turn the queue draws as a card instead of a message stays out of the composer.
    func testATurnNobodyTypedNeverComesBack() {
        // The fixtures must be the cards they stand for, or the nils below prove nothing.
        XCTAssertNotNil(BackgroundWakeText.parse(Self.backgroundWake))
        XCTAssertNotNil(BackgroundWakeText.parse(Self.scheduledWakeup))
        XCTAssertNotNil(WatchWakeText.parse(WatchFixture.matchWake()))

        XCTAssertNil(ComposerLogic.restorableText(of: bubble(Self.backgroundWake)))
        XCTAssertNil(ComposerLogic.restorableText(of: bubble(Self.scheduledWakeup)))
        XCTAssertNil(ComposerLogic.restorableText(of: bubble(WatchFixture.matchWake())))
        XCTAssertNil(ComposerLogic.restorableText(of: bubble(
            "Merging your branch into the integration line hit a conflict.",
            itemCard: OpenItemDelivery(itemId: "i1", kind: .integrationConflict, title: "Conflict"))))
        XCTAssertNil(ComposerLogic.restorableText(of: bubble(
            "Your project was started.",
            startedCard: ProjectStarted(by: .confirmation, projectId: "p1", projectTitle: "Priority"))))
    }

    /// The turns that look like anybody's message — an acceptance round, a task's brief, a
    /// coordinator's delivery — are told apart by the server alone (`authoredByOrbit`), and that
    /// word reaches the rule above through the queue's own reading of the list.
    func testATurnTheServerSaysOrbitWroteNeverComesBack() throws {
        let listed = try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("""
            [{"turnId": "t-acceptance", "kind": "shell", "content": "npm test -w @orbit/web",
              "attachments": [], "authoredByOrbit": true},
             {"turnId": "t-brief", "kind": "message", "content": "请开始执行任务「Fix the race」。",
              "attachments": [], "authoredByOrbit": true},
             {"turnId": "t-typed", "kind": "message", "content": "and then deploy", "attachments": []}]
            """.utf8))
        XCTAssertEqual(listed.map(\.authoredByOrbit), [true, true, nil])

        var r = TranscriptReducer()
        r.reconcileQueuedTurns(listed, knownBefore: [])
        XCTAssertEqual(r.state.queued.map(\.authoredByOrbit), [true, true, false])
        XCTAssertEqual(r.state.queued.compactMap(ComposerLogic.restorableText(of:)), ["and then deploy"])

        // Kept across the queue's next reading, and across a transcript snapshot written before the
        // field existed (which has none to keep).
        r.reconcileQueuedTurns(listed, knownBefore: Set(listed.map(\.turnId)))
        XCTAssertEqual(r.state.queued.map(\.authoredByOrbit), [true, true, false])
        let stored = try JSONEncoder().encode(r.state.queued[0])
        XCTAssertTrue(try JSONDecoder().decode(UserBubble.self, from: stored).authoredByOrbit)
        let older = try JSONDecoder().decode(UserBubble.self, from: Data("""
            {"id": "server-t1", "text": "and then deploy", "pending": true, "queued": true}
            """.utf8))
        XCTAssertFalse(older.authoredByOrbit)
    }

    /// Another Orbit session's message waiting in the queue: the projection says who sent it
    /// (`sessionMessage`), the queue keeps that on the bubble it draws, and the words — somebody's,
    /// but not the reader's — never come back to the reader's composer, withdrawn or dropped by a Stop
    /// (docs/session-request-reply-contract.md §2.3, criterion 12).
    func testAnotherSessionsMessageIsDrawnAsItsCardAndNeverComesBack() throws {
        let listed = try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("""
            [{"turnId": "t-sent", "kind": "message", "content": "please review the migration",
              "attachments": [],
              "sessionMessage": {"fromSessionId": "34YCLEOsvlZDk31Ma1xAy", "fromTitle": "Worker: review",
                                 "fromAgentName": "orbit", "requestId": "34YgrQMXGzcFaGOglxvaO"}},
             {"turnId": "t-typed", "kind": "message", "content": "and then deploy", "attachments": []}]
            """.utf8))
        let card = SessionMessage(fromSessionId: "34YCLEOsvlZDk31Ma1xAy", fromTitle: "Worker: review",
                                  fromAgentName: "orbit", requestId: "34YgrQMXGzcFaGOglxvaO")
        XCTAssertEqual(listed.map(\.senderCard), [card, nil])
        XCTAssertEqual(listed.map(\.authoredByOrbit), [nil, nil], "somebody did write it: the other session")

        var r = TranscriptReducer()
        r.reconcileQueuedTurns(listed, knownBefore: [])
        XCTAssertEqual(r.state.queued.map(\.sessionMessage), [card, nil])
        XCTAssertEqual(r.state.queued.compactMap(ComposerLogic.restorableText(of:)), ["and then deploy"],
                       "the other session's words came back to the reader's composer")

        // Kept across the queue's next reading, which takes the exact bubble it drew, and across the
        // transcript snapshot the console stores.
        r.reconcileQueuedTurns(listed, knownBefore: Set(listed.map(\.turnId)))
        XCTAssertEqual(r.state.queued.map(\.sessionMessage), [card, nil])
        let stored = try JSONEncoder().encode(r.state.queued[0])
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: stored).sessionMessage, card)

        // The rule is the card, not the words: the same words with none are the reader's own.
        XCTAssertEqual(ComposerLogic.restorableText(of: bubble("please review the migration")),
                       "please review the migration")
    }

    /// An optimistic send the reader made, that the queue's reading then names as its own row, is not
    /// another session's for having been matched: a row with no card leaves the bubble with none.
    func testTheReadersOwnSendIsNotGivenAnotherSessionsCard() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "and then deploy", queued: true)
        r.reconcileQueuedTurns([QueuedTurnInfo(turnId: "t-typed", content: "and then deploy")], knownBefore: [])
        XCTAssertEqual(r.state.queued.map(\.turnId), ["t-typed"])
        XCTAssertNil(r.state.queued[0].sessionMessage)
        XCTAssertEqual(ComposerLogic.restorableText(of: r.state.queued[0]), "and then deploy")
    }

    // MARK: the console is wired to both rules

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees what the "
                    + "console hands back to the composer."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file, so a match somewhere else cannot answer for the part asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// `ConsoleModel.swift` is compiled only by the macOS and iOS jobs, so the two paths that write
    /// the composer from the queue are held to the rules above over their source.
    func testTheConsoleFoldsBackOnlyWhatAStopDroppedAndSomebodyTyped() throws {
        let console = try source(Self.consolePath)
        let fold = try section(console, from: "private func foldQueuedBackIntoComposer(before ev: RunEvent) {",
                               to: "func attachFile(url: URL) async {")
        XCTAssertTrue(fold.contains("guard TranscriptReducer.dropsQueue(ev),"),
                      "folds back only on an interrupt that dropped the queue — not a runner restart")
        XCTAssertTrue(fold.contains(".compactMap(ComposerLogic.restorableText(of:))"),
                      "and only the words somebody typed")

        let cancel = try section(console, from: "func cancelQueued(_ bubble: UserBubble) async {",
                                 to: "private func foldQueuedBackIntoComposer")
        XCTAssertTrue(cancel.contains("if let body = ComposerLogic.restorableText(of: bubble),"),
                      "a withdrawn turn comes back only when somebody typed it")
        XCTAssertFalse(cancel.contains("WatchWakeText.parse") || fold.contains("WatchWakeText.parse"),
                       "one rule for both paths, not a list of exceptions kept in two places")
    }
}
