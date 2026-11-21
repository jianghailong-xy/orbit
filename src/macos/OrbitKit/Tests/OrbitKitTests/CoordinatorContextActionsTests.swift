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
                       .writing(startedAt: RelativeTime.parse(start), label: "Writing the handoff note"))
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

    /// Board 02 ⑥: the engine compacts before it can write the note — the row says so, same clock.
    func testAWritingHandoffReadsCompactingWhileTheEngineCompacts() throws {
        let start = "2026-11-14T10:00:00Z"
        let startedAt = try XCTUnwrap(RelativeTime.parse(start), "the timer keeps its start")
        let writing = SessionCoordinatorHandoff(state: .writing, startedAt: start)
        XCTAssertEqual(CoordinatorHandoffRow.resolve(writing, enginePhase: "compacting"),
                       .writing(startedAt: startedAt, label: "Compacting…"))
        XCTAssertEqual(CoordinatorHandoffRow.resolve(writing, enginePhase: nil),
                       .writing(startedAt: startedAt, label: "Writing the handoff note"))
        XCTAssertEqual(CoordinatorHandoffRow.resolve(writing, enginePhase: "warming"),
                       .writing(startedAt: startedAt, label: "Writing the handoff note"))
        // Only WRITING turns: handing over is handing over, whatever the engine does.
        XCTAssertEqual(CoordinatorHandoffRow.resolve(.init(state: .handingOver, startedAt: start),
                                                     enginePhase: "compacting"), .handingOver)
    }

    func testTheNoteTurnIsNotDrawnAsTheOwnersMessage() {
        XCTAssertTrue(CoordinatorContextActions.isHandoffTurn(clientTurnId: "coordinator-handoff:v1:h1:1"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffTurn(clientTurnId: "c-123"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffTurn(clientTurnId: nil))
    }

    /// An echo of the note prompt with no `clientTurnId` is still the platform's: no message is drawn
    /// for it, and the reply that follows is drawn as usual.
    func testANotePromptEchoWithoutItsTurnIdIsNotDrawnButItsReplyIs() {
        XCTAssertTrue(CoordinatorContextActions.isHandoffPrompt("From Orbit · handoff note\n\nThe owner…"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffPrompt("Did Orbit write the handoff note?"))
        XCTAssertFalse(CoordinatorContextActions.isHandoffPrompt(nil))
        var reducer = TranscriptReducer()
        reducer.apply(RunEvent(seq: 1, type: .user, turnId: "t1", payload: .object(["text": .string(
            "From Orbit · handoff note\n\nThe owner is handing this project over to a new coordinator conversation.")])))
        reducer.apply(RunEvent(seq: 2, type: .assistant, turnId: "t1",
                               payload: .object(["text": .string("## Where things stand\n- 4 of 6 tasks done.")])))
        let users = reducer.state.items.filter { if case .user = $0 { return true } else { return false } }
        XCTAssertTrue(users.isEmpty, "the prompt's echo draws no message: \(users)")
        let replies = reducer.state.items.compactMap { item -> String? in
            if case .assistant(let b) = item { return b.text } else { return nil }
        }
        XCTAssertEqual(replies.count, 1)
        XCTAssertTrue(replies.first?.contains("Where things stand") == true, "the reply is drawn: \(replies)")
    }

    // MARK: Wire

    func testSuccessorRequestBody() throws {
        let encoder = JSONEncoder()
        let emptyBody = try encoder.encode(CoordinatorHandoffRequest(successor: nil))
        XCTAssertEqual(String(decoding: emptyBody, as: UTF8.self), "{}")

        let pick = CoordinatorHandoffSuccessor(engine: "claude", provider: "claude")
        let body = try encoder.encode(CoordinatorHandoffRequest(successor: pick))
        let fields = try JSONDecoder().decode([String: [String: String]].self, from: body)
        XCTAssertEqual(fields, ["successor": ["engine": "claude", "provider": "claude"]])

        // "Same as this one" said on purpose clears a saved pick.
        let same = try encoder.encode(CoordinatorHandoffRequest(successor: .same))
        XCTAssertEqual(String(decoding: same, as: UTF8.self), #"{"successor":null}"#)
    }

    func testSuccessorDecodesOnSessionAndHandoffResponse() throws {
        let row = try session("""
            {"id":"s1","status":"FAILED","pendingApprovals":0,
             "coordinatorHandoff":{"state":"FAILED","successor":{"engine":"claude","provider":"claude","model":"claude-opus-5-5"}}}
            """)
        let expected = CoordinatorHandoffSuccessor(engine: "claude", provider: "claude", model: "claude-opus-5-5")
        XCTAssertEqual(row.coordinatorHandoff?.successor, expected)

        let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"FAILED","pendingApprovals":0,
             "coordinatorHandoff":{"state":"FAILED","successor":{"engine":"codex","provider":"codex"}}}
            """.utf8))
        let updated = CoordinatorHandoffSuccessor(engine: "codex", provider: "codex")
        XCTAssertEqual(row.applying(summary).coordinatorHandoff?.successor, updated)

        let response = try JSONDecoder().decode(CoordinatorHandoffView.self, from: Data("""
            {"projectId":"p1","sessionId":"s1","state":"FAILED","successor":{"engine":"codex","provider":"codex"}}
            """.utf8))
        XCTAssertEqual(response.successor, updated)
        let olderResponse = try JSONDecoder().decode(CoordinatorHandoffView.self, from: Data("""
            {"projectId":"p1","sessionId":"s1","state":"FAILED"}
            """.utf8))
        XCTAssertNil(olderResponse.successor)

        let withoutSuccessor = try session("""
            {"id":"s1","status":"FAILED","pendingApprovals":0,
             "coordinatorHandoff":{"state":"FAILED","successor":null}}
            """)
        XCTAssertEqual(withoutSuccessor.coordinatorHandoff?.state, .failed)
        XCTAssertNil(withoutSuccessor.coordinatorHandoff?.successor)
    }

    func testTheSessionFieldsDecodeAndTheSummaryOwnsThem() throws {
        let row = try session("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0,"projectId":"p1",
             "coordinatorHandoff":{"state":"FAILED","startedAt":"2026-11-14T10:00:00Z","failureCode":"EMPTY_NOTE",
             "failureReason":"The handoff note wasn't written: the reply was empty.","handedOverToSessionId":null}}
            """)
        XCTAssertEqual(row.coordinatorHandoff?.state, .failed)
        XCTAssertEqual(row.coordinatorHandoff?.failureCode, .emptyNote)
        XCTAssertNil(row.coordinatorHandoff?.successor)
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

        // The engine phase the WRITING row reads: from the list row, kept by a summary that says
        // nothing of it, and ended by one whose null says the compaction is over.
        let compacting = try session("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0,"enginePhase":"compacting"}
            """)
        XCTAssertEqual(compacting.enginePhase, "compacting")
        XCTAssertEqual(compacting.applying(older).enginePhase, "compacting")
        let phaseOver = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"RUNNING","pendingApprovals":0,"enginePhase":null}
            """.utf8))
        XCTAssertNil(compacting.applying(phaseOver).enginePhase)

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

            **Rulings not yet recorded**
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
        XCTAssertEqual(CoordinatorHandoffCopy.successorRowTitle, "New coordinator runs on")
        XCTAssertEqual(CoordinatorHandoffCopy.successorKeep, "Same as this one")
        XCTAssertEqual(CoordinatorHandoffCopy.successorRowDetail,
                       "Pick another if this one's model or provider has stopped working.")
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

    // MARK: Pending work's kind — handoff v2 §1

    /// The confirm (the Mac's sheet, the iPhone's Alert) and the successor's moved-here list name each
    /// wait's kind after its label; a watch, and a wait from a server without `kind`, read as before.
    func testEachPendingWaitNamesItsKindInTheConfirmAndTheMovedList() throws {
        let preview = try JSONDecoder().decode([CoordinatorPendingWait].self, from: Data("""
            [{"id":"r1","kind":"SUBAGENT","label":"Deploy 55a189aa3 to production","paused":false},
             {"id":"sw1","kind":"WAKEUP","label":"Check the deploy","paused":false},
             {"id":"bgj_1","kind":"JOB","label":"pnpm test","paused":false},
             {"id":"l1","kind":"LOOP","label":"Babysit CI","paused":false},
             {"id":"w1","kind":"WATCH","label":"Waiting for Fix login redirect","paused":true}]
            """.utf8))
        XCTAssertEqual(preview.map(\.kind), [.subagent, .wakeup, .job, .loop, .watch])
        let lines = ["Deploy 55a189aa3 to production · SubAgent", "Check the deploy · Scheduled wakeup",
                     "pnpm test · Background job", "Babysit CI · Wakeup loop", "Waiting for Fix login redirect (paused)"]
        // The Mac's confirm: one line per wait.
        XCTAssertEqual(preview.map(CoordinatorHandoffCopy.waitLine), lines)
        // The iPhone's Alert: the body, then each wait on its own line.
        XCTAssertEqual(CoordinatorContextCopy.phoneConfirmMessage(waits: Array(preview.prefix(2)), running: false),
                       "This coordinator writes a handoff note, then the project continues in a new conversation. "
                       + "2 pending waits move over. Nothing is deleted.\n\n"
                       + "Deploy 55a189aa3 to production · SubAgent\nCheck the deploy · Scheduled wakeup")

        // The successor's moved-here list.
        let successor = try session("""
            {"id":"s2","status":"RUNNING","pendingApprovals":0,"projectId":"p1",
             "coordinatorHandoffReceived":{"handoffFromSessionId":"s1","note":null,"handedOverAt":"2026-11-14T10:42:00Z",
             "movedWaits":[{"id":"r1","kind":"SUBAGENT","label":"Deploy 55a189aa3 to production","paused":false},
                           {"id":"sw1","kind":"WAKEUP","label":"Check the deploy","paused":false}]}}
            """)
        XCTAssertEqual(successor.coordinatorHandoffReceived?.movedWaits.map(CoordinatorHandoffCopy.waitLine),
                       ["Deploy 55a189aa3 to production · SubAgent", "Check the deploy · Scheduled wakeup"])
    }

    /// An older server sends no `kind` (and a newer one may send one this build does not know): each reads
    /// as a watch, so the confirm and the moved-here list say what they said before kinds — and the
    /// iPhone's Alert keeps the waits a count only.
    func testAWaitWithoutAKindReadsAsBefore() throws {
        let older = try JSONDecoder().decode([CoordinatorPendingWait].self, from: Data("""
            [{"id":"w1","label":"Waiting for Fix login redirect","paused":false},
             {"id":"w2","label":"Session Payment retries finishing its turn","paused":true},
             {"id":"x1","kind":"SOMETHING_NEW","label":"Something new","paused":false}]
            """.utf8))
        XCTAssertEqual(older.map(\.kind), [.watch, .watch, .watch])
        XCTAssertEqual(older.map(CoordinatorHandoffCopy.waitLine),
                       ["Waiting for Fix login redirect", "Session Payment retries finishing its turn (paused)", "Something new"])
        XCTAssertEqual(CoordinatorContextCopy.phoneConfirmMessage(waits: older, running: false),
                       CoordinatorContextCopy.phoneConfirmBody(waits: 3, running: false))
        let successor = try session("""
            {"id":"s2","status":"RUNNING","pendingApprovals":0,"projectId":"p1",
             "coordinatorHandoffReceived":{"handoffFromSessionId":"s1","note":null,"handedOverAt":"2026-11-14T10:42:00Z",
             "movedWaits":[{"id":"w1","label":"Waiting for Fix login redirect","paused":false}]}}
            """)
        XCTAssertEqual(successor.coordinatorHandoffReceived?.movedWaits.map(CoordinatorHandoffCopy.waitLine),
                       ["Waiting for Fix login redirect"])
    }

    /// A refused press reads web's toast title, then why (`APIClient.failureReason`).
    func testARefusedPressSaysCouldntHandOver() {
        XCTAssertEqual(CoordinatorHandoffCopy.refused, "Couldn't hand over")
        XCTAssertEqual(CoordinatorHandoffCopy.refusal("the connection dropped"),
                       "Couldn't hand over: the connection dropped.")
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
