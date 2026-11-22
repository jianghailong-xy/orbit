import Foundation
import XCTest
@testable import OrbitKit

/// Owner rule (2026-11-16): the right side of a conversation is only for words the person typed. A turn
/// Orbit opened whose note is a block no client knows used to fall through to the reader's own bubble —
/// empty, with "Orbit attached: context" over the raw block. It is a generic "From Orbit" line in the
/// agent's stream instead (`OrbitEvent`, `OrbitEventLineView`). Known blocks keep their own lines; typed
/// words keep their bubble. Web parity: `Transcript.orbitEvent.test.tsx`.
final class OrbitEventTests: XCTestCase {
    private typealias F = WatchFixture

    private static let future = "<orbit-future-thing>\n  Something the control plane will say one day.\n</orbit-future-thing>"

    private static let jobNote = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_13c53745a88a｜job｜bash scripts/run-pg-spec.sh｜pg matrix
              ended｜exited｜exit code 0
              output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–512
              (no output)
          The control plane recorded this for you; the user did not say it.
        </background-job-wake>
        """

    private static let wakeupNote = """
        <scheduled-wakeup>
          The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:
            2026-09-17T06:00:00.000Z scheduled 600 seconds out, due 2026-09-17T06:10:00.000Z
            reason: watching CI run
            what you left for this turn:
              read the CI result and fix what failed
          The control plane recorded this for you; the user did not say it.
        </scheduled-wakeup>
        """

    private static let subagentNote = """
        <orbit-subagent-finished>
          SubAgent Find every caller of pollQuota (run 34y5Qcall0000000000001) finished: DONE
          Result:
            Three callers, all in `quota/`: poller.ts, account.ts, limits.ts.
          The control plane opened this turn for it.
          The control plane recorded this for you; the user did not say it. Whatever a SubAgent changed is in your working tree, uncommitted: review it before you commit. To continue one, call delegate with resume set to its run id.
        </orbit-subagent-finished>
        """

    // MARK: 1. an unknown block

    func testAnUnknownBlockIsTheFromOrbitLineNotTheReadersBubble() {
        let b = UserBubble(id: "u1", text: "", pending: false, note: Self.future)
        XCTAssertTrue(OrbitEvent.draws(b))
        XCTAssertEqual(OrbitEvent.name(Self.future), "context")
        XCTAssertFalse(SteerDelivery.isReadersOwn(b), "it waits in no tray")
        XCTAssertFalse(StickySummary.isAnchor(text: b.text, note: b.note), "the bar does not point at it")
        XCTAssertNil(ComposerLogic.restorableText(of: b), "it never returns to the composer")
    }

    func testTheLineNamesWhatDescribeNoteNames() {
        let note = Self.future + "\n\n<orbit-session-reply>\n  a reply\n</orbit-session-reply>"
        XCTAssertEqual(OrbitEvent.name(note), "context, session reply")
        // A note naming nothing (the background-jobs inventory alone) is still `context`.
        XCTAssertEqual(OrbitEvent.name("<background-jobs>\n  none\n</background-jobs>"), "context")
    }

    // MARK: 2. the known blocks keep their own lines

    /// The row asks each dedicated line first; every known block is read by its own parser, so the
    /// generic line never takes it (order pinned in `testTheRowAsksTheGenericLineLastBeforeTheBubble`).
    func testKnownBlocksAreReadByTheirOwnLines() {
        XCTAssertNotNil(BackgroundWakeText.parse(Self.jobNote))
        XCTAssertNotNil(BackgroundWakeText.parse(Self.wakeupNote))
        XCTAssertNotNil(SubagentFinishedText.parse(Self.subagentNote))
        XCTAssertNotNil(WatchWakeText.parse(F.expiryWake()))
    }

    func testTheRowAsksTheGenericLineLastBeforeTheBubble() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var code: String?
        for _ in 0..<12 {
            let url = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/UserTurnRow.swift")
            if FileManager.default.fileExists(atPath: url.path) { code = try String(contentsOf: url, encoding: .utf8); break }
            dir = dir.deletingLastPathComponent()
        }
        let row = try XCTUnwrap(code, "UserTurnRow.swift was not found above this test file")
        func at(_ s: String) throws -> String.Index { try XCTUnwrap(row.range(of: s), s).lowerBound }
        let generic = try at("} else if queued == nil, OrbitEvent.draws(b) {")
        for known in ["} else if let wake = WatchWakeText.parse(b.text) {",
                      "} else if let subagent = SubagentFinishedText.parse(wakeNote) {",
                      "} else if let jobNews = BackgroundWakeText.parse(wakeNote) {"] {
            XCTAssertLessThan(try at(known), generic, "\(known) is asked after the generic line")
        }
        XCTAssertLessThan(generic, try at("} else if let sender = b.externalSender {"))
        XCTAssertTrue(row[generic...].hasPrefix("} else if queued == nil, OrbitEvent.draws(b) {")
                      && row[generic...].contains("OrbitEventLineView(note:"))
    }

    // MARK: 3. typed words keep their bubble

    func testTypedWordsStayTheReadersBubble() {
        let b = UserBubble(id: "u2", text: "Ship it", pending: false, note: Self.future)
        XCTAssertFalse(OrbitEvent.draws(b))
        XCTAssertTrue(SteerDelivery.isReadersOwn(b))
        XCTAssertTrue(StickySummary.isAnchor(text: b.text, note: b.note))
    }

    func testAttachmentsAloneAreStillTheReadersMessage() {
        let b = UserBubble(id: "u3", text: "", attachments: [TurnAttachment(id: "a1", mime: "image/png", name: "x.png")],
                           pending: false, note: Self.future)
        XCTAssertFalse(OrbitEvent.draws(b))
        XCTAssertFalse(OrbitEvent.draws(text: "", note: nil))
    }
}
