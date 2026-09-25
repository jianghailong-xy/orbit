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
