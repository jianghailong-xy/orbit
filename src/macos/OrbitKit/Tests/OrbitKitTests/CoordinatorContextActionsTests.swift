import Foundation
import XCTest
@testable import OrbitKit

/// Compact and Start a new coordinator from the context gauge (boards 01–03): who sees which row,
/// when Compact is greyed out, and what the outgoing coordinator's conversation shows of its handoff.
final class CoordinatorContextActionsTests: XCTestCase {

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private let claudeCompact = SlashCommandInfo(name: "compact", type: "command", builtin: true)

    // MARK: Compact — board 01 ④, board 03 ④

    func testCompactIsOfferedOnlyWhereTheEnginesSlashAssetsListIt() {
        XCTAssertTrue(CoordinatorContextActions.offersCompact(slashItems: [claudeCompact], engine: "claude"))
        // Older runners leave the Claude entries untagged — still Claude Code's.
        XCTAssertTrue(CoordinatorContextActions.offersCompact(slashItems: [claudeCompact], engine: nil))
        // An engine with no slash registry has nothing to send it to.
        XCTAssertFalse(CoordinatorContextActions.offersCompact(slashItems: [claudeCompact], engine: "codex"))
        // Cursor and Kimi list their own; Claude's compact is not theirs.
        XCTAssertFalse(CoordinatorContextActions.offersCompact(slashItems: [claudeCompact], engine: "cursor"))
        let kimi = SlashCommandInfo(name: "compact", type: "command", provider: "kimi")
        XCTAssertTrue(CoordinatorContextActions.offersCompact(slashItems: [kimi], engine: "kimi"))
        // No `compact` among the assets — no row.
        XCTAssertFalse(CoordinatorContextActions.offersCompact(
            slashItems: [SlashCommandInfo(name: "review", type: "command")], engine: "claude"))
        // Orbit's own local commands are not the engine's.
        XCTAssertFalse(CoordinatorContextActions.offersCompact(
            slashItems: [SlashCommandInfo(name: "compact", type: "local")], engine: "claude"))
        XCTAssertEqual(CoordinatorContextActions.compactCommand, "/compact")
    }

    func testCompactIsDisabledWhileATurnRunsAndWhileAHandoffHoldsTheComposer() {
        XCTAssertTrue(CoordinatorContextActions.compactEnabled(running: false))
        XCTAssertFalse(CoordinatorContextActions.compactEnabled(running: true))
        let writing = SessionCoordinatorHandoff(state: .writing, startedAt: "2026-11-14T10:00:00Z")
        XCTAssertFalse(CoordinatorContextActions.compactEnabled(running: false, handoff: writing))
        let failed = SessionCoordinatorHandoff(state: .failed, startedAt: "2026-11-14T10:00:00Z",
                                               failureCode: .turnFailed)
        XCTAssertTrue(CoordinatorContextActions.compactEnabled(running: false, handoff: failed))
    }

    func testCompactIsEmphasisedFromSeventyFivePercent() {
        XCTAssertFalse(CoordinatorContextActions.emphasizesCompact(percent: 74))
        XCTAssertTrue(CoordinatorContextActions.emphasizesCompact(percent: 75))
        XCTAssertTrue(CoordinatorContextActions.emphasizesCompact(percent: 82))
    }

    // MARK: Start a new coordinator — board 01 ②

    func testStartANewCoordinatorIsOnlyForTheCurrentOpenCoordinator() throws {
        let current = try session("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":0,"lifecycleState":"OPEN",
             "projectId":"p1","projectTitle":"Checkout redesign"}
            """)
        XCTAssertTrue(CoordinatorContextActions.offersNewCoordinator(current))
        // An ordinary conversation, or one that once coordinated (the pointer moved on): no row.
        let ordinary = try session(#"{"id":"s2","status":"AWAITING_INPUT","pendingApprovals":0}"#)
        XCTAssertFalse(CoordinatorContextActions.offersNewCoordinator(ordinary))
        XCTAssertFalse(CoordinatorContextActions.offersNewCoordinator(nil))
        let completed = try session("""
            {"id":"s3","status":"AWAITING_INPUT","pendingApprovals":0,"lifecycleState":"COMPLETED","projectId":"p1"}
            """)
        XCTAssertFalse(CoordinatorContextActions.offersNewCoordinator(completed))
        // A handoff already under way carries its own presses in the conversation.
        let handingOver = try session("""
            {"id":"s4","status":"RUNNING","pendingApprovals":0,"lifecycleState":"OPEN","projectId":"p1",
             "coordinatorHandoff":{"state":"WRITING","startedAt":"2026-11-14T10:00:00Z","failureCode":null,
             "failureReason":null,"handedOverToSessionId":null}}
            """)
        XCTAssertFalse(CoordinatorContextActions.offersNewCoordinator(handingOver))
        // Running is not a reason to hide it: the handoff waits for the turn.
        let running = try session("""
            {"id":"s5","status":"RUNNING","runState":"RUNNING","pendingApprovals":0,"lifecycleState":"OPEN","projectId":"p1"}
            """)
        XCTAssertTrue(CoordinatorContextActions.offersNewCoordinator(running))
    }

    // MARK: Handoff states — board 02

    func testTheHandoffRowForEachState() {
        let start = "2026-11-14T10:00:00Z"
        XCTAssertEqual(CoordinatorHandoffRow.resolve(nil), nil)
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .writing, startedAt: start)),
                       .writing(startedAt: RelativeTime.parse(start)))
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .handingOver, startedAt: start)), .handingOver)
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .completed, startedAt: start,
                                                           handedOverToSessionId: "s9")),
                       .completed(successorSessionID: "s9"))
        let failed = SessionCoordinatorHandoff(state: .failed, startedAt: start, failureCode: .turnFailed,
                                               failureReason: "The handoff note wasn't written: the turn failed.")
        XCTAssertEqual(CoordinatorHandoffRow.resolve(failed),
                       .failed(reason: "The handoff note wasn't written: the turn failed.",
                               actions: [.retry, .skip, .cancel]))
        // No sentence from the server: the code's own.
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .failed, startedAt: start, failureCode: .timedOut)),
                       .failed(reason: "The handoff note wasn't written: the turn timed out.",
                               actions: [.retry, .skip, .cancel]))
        // The outgoing coordinator is already completed: only Hand over without a note can work.
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .failed, startedAt: start,
                                                           failureCode: .replaceFailed, failureReason: "x")),
                       .failed(reason: "x", actions: [.skip]))
        XCTAssertEqual(CoordinatorHandoffRow.label(.retry), "Try again")
        XCTAssertEqual(CoordinatorHandoffRow.label(.skip), "Hand over without a note")
        XCTAssertEqual(CoordinatorHandoffRow.label(.cancel), "Keep this coordinator")
    }

    func testTheComposerIsLockedWhileWritingAndHandingOver() {
        let start = "2026-11-14T10:00:00Z"
        XCTAssertTrue(CoordinatorContextActions.locksComposer(.init(state: .writing, startedAt: start)))
        XCTAssertTrue(CoordinatorContextActions.locksComposer(.init(state: .handingOver, startedAt: start)))
        XCTAssertFalse(CoordinatorContextActions.locksComposer(.init(state: .failed, startedAt: start)))
        XCTAssertFalse(CoordinatorContextActions.locksComposer(nil))
    }

    func testTheWritingClockCountsMinutesAndSeconds() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(CoordinatorHandoffRow.clock(since: start, now: start.addingTimeInterval(24)), "0:24")
        XCTAssertEqual(CoordinatorHandoffRow.clock(since: start, now: start.addingTimeInterval(65)), "1:05")
        XCTAssertEqual(CoordinatorHandoffRow.clock(since: nil), "0:00")
    }

    func testTheNoteTurnIsNotDrawnAsTheOwnersMessage() {
        XCTAssertTrue(CoordinatorContextActions.isHandoffTurn(clientTurnId: "coordinator-handoff:v1:h1:1"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffTurn(clientTurnId: "c-123"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffTurn(clientTurnId: nil))
    }

    // MARK: Wire

    func testTheSessionFieldsDecodeAndTheSummaryOwnsThem() throws {
        let row = try session("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0,"projectId":"p1",
             "coordinatorHandoff":{"state":"FAILED","startedAt":"2026-11-14T10:00:00Z","failureCode":"EMPTY_NOTE",
             "failureReason":"The handoff note wasn't written: the reply was empty.","handedOverToSessionId":null}}
            """)
        XCTAssertEqual(row.coordinatorHandoff?.state, .failed)
        XCTAssertEqual(row.coordinatorHandoff?.failureCode, .emptyNote)
        // An older control plane says nothing: the row keeps its handoff.
        let older = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0}
            """.utf8))
        XCTAssertEqual(row.applying(older).coordinatorHandoff?.state, .failed)
        // A cancel: null takes the row away.
        let cancelled = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0,"coordinatorHandoff":null}
            """.utf8))
        XCTAssertNil(row.applying(cancelled).coordinatorHandoff)

        let successor = try session("""
            {"id":"s2","status":"RUNNING","pendingApprovals":0,"projectId":"p1",
             "coordinatorHandoffReceived":{"handoffFromSessionId":"s1","note":"## Next\\n- Merge it.",
             "handedOverAt":"2026-11-14T10:42:00Z",
             "movedWaits":[{"id":"w1","label":"Waiting for Fix login redirect","paused":false},
                           {"id":"w2","label":"Session Payment retries finishing its turn","paused":true}]}}
            """)
        XCTAssertEqual(successor.coordinatorHandoffReceived?.handoffFromSessionId, "s1")
        XCTAssertEqual(successor.coordinatorHandoffReceived?.movedWaits.map(\.paused), [false, true])
        // A state this build does not know is no row, never a failed decode.
        let future = try session("""
            {"id":"s3","status":"RUNNING","pendingApprovals":0,
             "coordinatorHandoff":{"state":"SOMETHING_NEW","startedAt":"2026-11-14T10:00:00Z"}}
            """)
        XCTAssertNil(CoordinatorHandoffRow.resolve(future.coordinatorHandoff))
    }

    func testTheNoteSplitsIntoItsSections() {
        let note = CoordinatorHandoffNote.parse("""
            ## Where things stand
            - 4 of 6 tasks done; Fix login redirect in review.

            **Agreed with the owner**
            - Don't merge Payment retries before Friday's release.
            Waiting on
            * Evidence for Fix login redirect.
            ### Next
            - Ask for the merge once that evidence is in.
            """)
        XCTAssertEqual(note.sections.map(\.title), CoordinatorHandoffCopy.sections)
        XCTAssertEqual(note.sections[0].items, ["4 of 6 tasks done; Fix login redirect in review."])
        XCTAssertEqual(note.sections[2].items, ["Evidence for Fix login redirect."])
        XCTAssertEqual(note.preamble, "")
        XCTAssertEqual(CoordinatorHandoffNote.parse("Just a line.").preamble, "Just a line.")
    }

    // MARK: Copy constants

    /// Boards 01 and 03, word for word (commit 70ecb20c0, docs/mocks/coordinator-context-actions).
    func testThePopoverRowsCopy() {
        XCTAssertEqual(CoordinatorContextCopy.title, "Context")
        XCTAssertEqual(CoordinatorContextCopy.compact, "Compact")
        XCTAssertEqual(CoordinatorContextCopy.compactDetail, "Summarize earlier turns and keep going here.")
        XCTAssertEqual(CoordinatorContextCopy.compactWhileRunning, "Available when this turn ends.")
        XCTAssertEqual(CoordinatorContextCopy.newCoordinator, "Start a new coordinator")
        XCTAssertEqual(CoordinatorContextCopy.newCoordinatorDetail,
                       "This one writes a handoff note, then the project continues in a fresh conversation.")
        XCTAssertEqual(CoordinatorContextCopy.newCoordinatorWhileRunning,
                       "Begins after this turn ends: a handoff note, then a fresh conversation.")
    }

    func testTheConfirmsCopy() {
        XCTAssertEqual(CoordinatorHandoffCopy.waitsRowTitle(1), "1 pending wait moves over")
        XCTAssertEqual(CoordinatorHandoffCopy.waitsRowTitle(2), "2 pending waits move over")
        XCTAssertEqual(CoordinatorHandoffCopy.waitsMovedHere(1), "1 wait moved here")
        XCTAssertEqual(CoordinatorHandoffCopy.waitsMovedHere(2), "2 waits moved here")
        XCTAssertEqual(CoordinatorHandoffCopy.confirmBody("Checkout redesign"),
                       "This coordinator writes a handoff note, then Checkout redesign continues in a new "
                       + "conversation that starts from that note. This one is completed — nothing is deleted.")
        // Board 03 iOS 2, word for word: the waits as a count only.
        XCTAssertEqual(CoordinatorContextCopy.phoneConfirmBody(waits: 2, running: false),
                       "This coordinator writes a handoff note, then the project continues in a new "
                       + "conversation. 2 pending waits move over. Nothing is deleted.")
        // No waits: no count.
        XCTAssertEqual(CoordinatorContextCopy.phoneConfirmBody(waits: 0, running: false),
                       "This coordinator writes a handoff note, then the project continues in a new "
                       + "conversation. Nothing is deleted.")
        XCTAssertTrue(CoordinatorContextCopy.phoneConfirmBody(waits: 1, running: true)
            .hasPrefix("After the current turn ends, this coordinator writes a handoff note"))
    }
}

final class CoordinatorHandoffTranscriptTests: XCTestCase {
    /// The successor's note card is the conversation's first row once the first page is in, and the
    /// note turn the outgoing coordinator was asked in is never drawn as the owner's message.
    func testTheNoteCardOpensTheSuccessorAndTheNoteTurnIsHidden() {
        let received = SessionCoordinatorHandoffReceived(handoffFromSessionId: "s1", note: "## Next\n- Merge.",
                                                         handedOverAt: "2026-11-14T10:42:00Z")
        let rows = TranscriptRows.build(state: TranscriptState(), statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, handoffReceived: received)
        XCTAssertEqual(rows.first, .handoffReceived(received))
        let paged = TranscriptRows.build(state: TranscriptState(), statusCards: [], canPageOlder: true,
                                         showWorkingIndicator: false, handoffReceived: received)
        XCTAssertFalse(paged.contains(.handoffReceived(received)))

        var reducer = TranscriptReducer()
        reducer.apply(RunEvent(seq: 1, type: .user, turnId: "t1",
                               payload: .object(["text": .string("Write a handoff note…"),
                                                 "clientTurnId": .string("coordinator-handoff:v1:h1:1")])))
        reducer.apply(RunEvent(seq: 2, type: .user, turnId: "t2",
                               payload: .object(["text": .string("Hello"), "clientTurnId": .string("c-2")])))
        let users = reducer.state.items.compactMap { item -> String? in
            if case .user(let b) = item { return b.text } else { return nil }
        }
        XCTAssertEqual(users, ["Hello"])
    }
}
