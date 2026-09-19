import Foundation
import XCTest
@testable import OrbitKit

/// A message sent into a run that no longer has the task, read as structure instead of as a
/// sentence.
///
/// The reported failure: a task's run died on a quota error, the platform re-dispatched the task
/// two seconds later on another provider, and the person still looking at the dead session sent a
/// message into it. What came back was
///
///     task 5Tkr… could not be started: session 6vVU… (RUNNING) holds its execution claim. Let
///     that run reach a terminal status of its own, then start the task again
///
/// put on screen verbatim, with the message never leaving the composer. Two ids, one index concept,
/// and nothing to press. The refusal had been structured the whole time — `APIError.http` carries
/// the entire body — and `friendly(error)` reduced it to `body["message"]` one layer above.
///
/// So these assert the structure, not the prose: a code in, words and a way out back. The English
/// sentence is asserted ABSENT, because "we also show the server's line underneath" would pass a
/// test about the new words while leaving the reported experience exactly as it was.
final class TaskRunHandoffTests: XCTestCase {

    /// The sentence the server writes for a program, and the one thing no reader should meet.
    private static let serverSentence =
        "task 5Tkrnx1kbOyLZdlRiVN4Og could not be started: session 6vVUlXGyjjJEQtxymaTkCM "
        + "(RUNNING) holds its execution claim. Let that run reach a terminal status of its own, "
        + "then start the task again"

    private func refusal(_ fields: String, status: Int = 409) -> APIError {
        .http(status: status, body: "{\(fields)}")
    }

    /// §2.3/§2.4's answer, and §2.2's, as the server actually sends them.
    private func alreadyRunning(ending: Bool = false) -> APIError {
        refusal("""
        "statusCode":409,"error":"Conflict","code":"TASK_ALREADY_RUNNING",
        "taskId":"5Tkrnx1kbOyLZdlRiVN4Og",
        "conflictingSessionId":"6vVUlXGyjjJEQtxymaTkCM",
        "conflictingSessionStatus":"RUNNING",
        "conflictingSessionEnding":\(ending),
        "retryable":\(ending),
        "message":"\(Self.serverSentence)"
        """)
    }

    private func task(_ json: String) -> TaskItem {
        try! JSONDecoder().decode(TaskItem.self, from: Data(json.utf8))
    }

    private func accepted(_ json: String) -> TurnAccepted {
        try! JSONDecoder().decode(TurnAccepted.self, from: Data(json.utf8))
    }

    // MARK: (a) TASK_ALREADY_RUNNING

    /// The reported case, end to end through this layer: words a person can act on, an action that
    /// names the run to open, and the server's sentence nowhere in any of it.
    func testAlreadyRunningIsReadAsWordsAndAWayOutRatherThanTheServersSentence() throws {
        let conflict = try XCTUnwrap(TaskRunHandoff.readConflict(alreadyRunning()),
                                     "TASK_ALREADY_RUNNING must reach this end as structure")

        XCTAssertEqual(conflict.kind, .held)
        XCTAssertEqual(conflict.title, "A newer run has this task")
        XCTAssertEqual(conflict.body, TaskRunHandoff.heldBody)

        // The whole point of the change: none of what is shown is the line the server wrote.
        XCTAssertFalse(conflict.title.contains("execution claim"))
        XCTAssertFalse(conflict.body.contains("execution claim"))
        XCTAssertNotEqual(conflict.body, Self.serverSentence)
        for fragment in ["execution claim", "terminal status", "5Tkrnx1kbOyLZdlRiVN4Og",
                         "6vVUlXGyjjJEQtxymaTkCM"] {
            XCTAssertFalse(conflict.title.contains(fragment) || conflict.body.contains(fragment),
                           "\(fragment.debugDescription) is for a program, not for a reader")
        }

        // …and there is somewhere to go, carrying the run the answer named.
        let open = try XCTUnwrap(conflict.actions.first { $0.kind == .openRun },
                                 "a refusal that names the run must offer to open it")
        XCTAssertEqual(open.label, "Open the run")
        XCTAssertEqual(open.sessionID, "6vVUlXGyjjJEQtxymaTkCM")

        // The structure survives the trip: the ids the view routes and edits with are still here,
        // which is exactly what `friendly(error)` used to throw away.
        XCTAssertEqual(conflict.sessionID, "6vVUlXGyjjJEQtxymaTkCM")
        XCTAssertEqual(conflict.taskID, "5Tkrnx1kbOyLZdlRiVN4Og")
    }

    /// §2.3: the same code, one field different, and a different situation — this one fixes itself,
    /// so the reader is told to wait rather than asked to do anything.
    func testARunOnItsWayOutIsWaitedOutRatherThanHandedToTheReader() throws {
        let ending = try XCTUnwrap(TaskRunHandoff.readConflict(alreadyRunning(ending: true)))
        XCTAssertEqual(ending.kind, .ending)
        XCTAssertEqual(ending.title, "That run is stopping")
        XCTAssertEqual(ending.body, TaskRunHandoff.endingBody)
        XCTAssertEqual(ending.resendAfter, 2)

        // `conflictingSessionStatus` is RUNNING in BOTH answers — a cancelled run keeps that status
        // until its engine lets go — so reading the status instead of the field would show the
        // "somebody else has this" card over a situation that clears itself in a second.
        let held = try XCTUnwrap(TaskRunHandoff.readConflict(alreadyRunning(ending: false)))
        XCTAssertEqual(held.kind, .held)
        XCTAssertNil(held.resendAfter, "nothing is going to free the task, so nothing is resent")
    }

    /// Waiting is a plan for a couple of seconds, not forever. Once the resends are spent this end
    /// re-reads its own answer — keeping the run it named, dropping the promise it can no longer
    /// make.
    func testWaitingStopsBeingAPlanAndTheCardSaysTheTrueThing() throws {
        let ending = try XCTUnwrap(TaskRunHandoff.readConflict(alreadyRunning(ending: true)))
        let settled = TaskRunHandoff.stillHeldAfterWaiting(ending)
        XCTAssertEqual(settled.kind, .held)
        XCTAssertEqual(settled.title, TaskRunHandoff.heldTitle)
        XCTAssertNil(settled.resendAfter, "a card that kept resending would poll for as long as "
                     + "the window stays open")
        XCTAssertEqual(settled.sessionID, "6vVUlXGyjjJEQtxymaTkCM", "the way out is unchanged")
        XCTAssertEqual(TaskRunHandoff.resendMaxAttempts, 5)
    }

    // MARK: (b) TASK_RUN_PIN_CONFLICT, and the fallback

    /// The pin refusal keeps the two provider names — they are what the reader is choosing between,
    /// and neither of them is an id — and offers the second way out the held card has no use for.
    func testPinConflictNamesTheProvidersAndOffersTheSecondWayOut() throws {
        let conflict = try XCTUnwrap(TaskRunHandoff.readConflict(refusal("""
        "statusCode":409,"code":"TASK_RUN_PIN_CONFLICT",
        "taskId":"5Tkrnx1kbOyLZdlRiVN4Og",
        "conflictingSessionId":"6vVUlXGyjjJEQtxymaTkCM",
        "pinnedTo":"deepseek","runningOn":"claude",
        "message":"task is pinned to deepseek but its run holds claude"
        """)))

        XCTAssertEqual(conflict.kind, .pin)
        XCTAssertEqual(conflict.title, "This task is pinned to a different provider")
        XCTAssertTrue(conflict.body.contains("deepseek"))
        XCTAssertTrue(conflict.body.contains("claude"))
        XCTAssertFalse(conflict.body.contains("execution claim"))
        XCTAssertEqual(conflict.actions.map(\.kind), [.openRun, .clearPin])
        XCTAssertEqual(conflict.actions.last?.label, "Clear the task's pin")
        XCTAssertEqual(conflict.taskID, "5Tkrnx1kbOyLZdlRiVN4Og",
                       "clearing a pin edits the TASK, so the card has to know which one")
    }

    /// The fallback, and why it is the point rather than a leftover: a refusal this build has never
    /// heard of is handed back untranslated so the caller shows the server's own words. Three ways
    /// that happens — a code from a newer server, a 409 from an older one that sends no code, and a
    /// status that was never this conversation at all.
    func testACodeThisBuildDoesNotKnowIsLeftToTheServersOwnWords() {
        XCTAssertNil(TaskRunHandoff.readConflict(refusal("""
        "statusCode":409,"code":"TASK_RUN_SOMETHING_INVENTED_LATER",
        "conflictingSessionId":"6vVUlXGyjjJEQtxymaTkCM",
        "message":"a refusal nobody has translated yet"
        """)), "an unknown code must fall through, not be guessed at")

        XCTAssertNil(TaskRunHandoff.readConflict(refusal(#""statusCode":409,"message":"older server""#)),
                     "an older server sends no code at all")

        XCTAssertNil(TaskRunHandoff.readConflict(refusal(#""code":"TASK_ALREADY_RUNNING""#, status: 500)),
                     "read by code AND status: 500 is not this conversation")

        XCTAssertNil(TaskRunHandoff.readConflict(APIError.unauthorized))
        XCTAssertNil(TaskRunHandoff.readConflict(URLError(.timedOut)))

        // §2.5: a cross-runtime switch is a 400, refused before anything is stopped. Offering a
        // "stop it and continue" button over it would confirm a choice that is answered the same
        // way however it is confirmed.
        XCTAssertNil(TaskRunHandoff.readConflict(refusal(
            #""statusCode":400,"message":"a claude session cannot switch to a provider that runs on codex""#,
            status: 400)))
    }

    // MARK: §2.1 the message follows the task, §2.2 the confirmation

    /// The success that used to be a refusal: the message went somewhere, and the answer says where.
    func testAnAnswerThatNamesAnotherRunIsWhereTheMessageWent() {
        XCTAssertEqual(
            TaskRunHandoff.routedToSession(accepted(#"""
            {"turnId":"t1","seq":12,"kind":"message","routedToSessionId":"6vVUlXGyjjJEQtxymaTkCM"}
            """#)),
            "6vVUlXGyjjJEQtxymaTkCM")

        // Absent means the ordinary resume — the message is in this session, as every build before
        // this one assumed unconditionally.
        XCTAssertNil(TaskRunHandoff.routedToSession(accepted(#"{"turnId":"t1","seq":12}"#)))
        XCTAssertNil(TaskRunHandoff.routedToSession(nil))
    }

    /// §2.2: "needs confirming" is a field, so this end writes its own question — and the answer it
    /// sends back names the run, not a boolean.
    func testAProviderSwitchAsksBeforeStoppingAnythingAndTheAnswerNamesTheRun() throws {
        let conflict = try XCTUnwrap(TaskRunHandoff.readConflict(refusal("""
        "statusCode":409,"code":"TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED",
        "confirmationRequired":true,
        "confirm":{"field":"stopSessionId","value":"6vVUlXGyjjJEQtxymaTkCM"},
        "runningProvider":"claude","requestedProvider":"deepseek",
        "taskId":"5Tkrnx1kbOyLZdlRiVN4Og",
        "conflictingSessionId":"6vVUlXGyjjJEQtxymaTkCM",
        "retryable":false,
        "message":"confirm stopping session 6vVU… and continuing on deepseek"
        """)))

        XCTAssertEqual(conflict.kind, .confirmSwitch)
        XCTAssertEqual(conflict.title, "Stop the run that is going?")
        XCTAssertTrue(conflict.body.contains("claude"))
        XCTAssertTrue(conflict.body.contains("deepseek"))
        XCTAssertTrue(conflict.body.contains("branch and worktree"),
                      "stopping a run is destructive; what survives it is the reader's question")
        XCTAssertEqual(conflict.actions.map(\.kind), [.stopAndContinue, .keepRunning])
        XCTAssertEqual(conflict.actions.first?.label, "Stop it and continue")
        XCTAssertEqual(conflict.actions.last?.label, "Keep it running")
        XCTAssertEqual(conflict.confirm, TaskRunHandoff.Confirm(field: "stopSessionId",
                                                                value: "6vVUlXGyjjJEQtxymaTkCM"))

        // Rule 2: nothing is stopped without the reader's own answer to this one question.
        XCTAssertEqual(TaskRunHandoff.stopSessionID(conflict, confirmed: true),
                       "6vVUlXGyjjJEQtxymaTkCM")
        XCTAssertNil(TaskRunHandoff.stopSessionID(conflict, confirmed: false),
                     "an unanswered question authorises nothing")
        XCTAssertNil(TaskRunHandoff.stopSessionID(nil, confirmed: true))
    }

    /// …and never derived from a conflict that merely happens to name a run. A HELD card names one
    /// too; treating that as permission would stop a run nobody was asked about.
    func testNoOtherRefusalCanAuthoriseStoppingARun() throws {
        let held = try XCTUnwrap(TaskRunHandoff.readConflict(alreadyRunning()))
        XCTAssertNotNil(held.sessionID)
        XCTAssertNil(TaskRunHandoff.stopSessionID(held, confirmed: true),
                     "only the question that asked about stopping can authorise a stop")
        XCTAssertFalse(held.actions.contains { $0.kind == .stopAndContinue })
    }

    // MARK: (d) the composer's note

    /// The composer says WHEN a pick takes hold, which is the whole question: a run keeps its
    /// provider for its whole life, so a pick made over something that is going lands on the next
    /// turn and not on this one.
    func testTheComposerSaysWhenAProviderPickTakesHold() {
        XCTAssertEqual(
            TaskRunHandoff.providerSwitchNote(from: "claude", to: "deepseek", liveRun: true),
            "The turn in flight finishes on claude. Your next one runs on deepseek.")
        XCTAssertEqual(
            TaskRunHandoff.providerSwitchNote(from: "claude", to: "deepseek", liveRun: false),
            "Your next message runs on deepseek.")

        // Nothing to say: picking what is already running is not a switch, and an end that does not
        // know what it is on cannot describe the change.
        XCTAssertNil(TaskRunHandoff.providerSwitchNote(from: "claude", to: "claude", liveRun: true))
        XCTAssertNil(TaskRunHandoff.providerSwitchNote(from: nil, to: "deepseek", liveRun: true))
        XCTAssertNil(TaskRunHandoff.providerSwitchNote(from: "claude", to: "", liveRun: false))
    }

    // MARK: (d) the entry a task offers

    /// A task that is going offers the run, not a press whose only possible answer is the 409.
    func testATaskWithALiveRunOffersTheRunAndNamesItWhenItCan() {
        let withSession = TaskRunHandoff.entry(for: task(#"""
        {"id":"t","title":"a","status":"FAILED","running":true,
         "sessions":[{"id":"dead","status":"FAILED"},{"id":"6vVUlXGyjjJEQtxymaTkCM","status":"RUNNING"}]}
        """#))
        XCTAssertEqual(withSession.kind, .openRun)
        XCTAssertEqual(withSession.label, "Open the run")
        XCTAssertEqual(withSession.hint, "A run of this task is going — open it")
        XCTAssertEqual(withSession.sessionID, "6vVUlXGyjjJEQtxymaTkCM")

        // A list row carries the flags but no sessions: same entry, no guess at which run.
        let rowOnly = TaskRunHandoff.entry(for: task(#"{"id":"t","title":"a","status":"FAILED","running":true}"#))
        XCTAssertEqual(rowOnly.kind, .openRun)
        XCTAssertNil(rowOnly.sessionID)

        // Queued counts: a run that has not started yet still holds the task.
        XCTAssertEqual(
            TaskRunHandoff.entry(for: task(#"{"id":"t","title":"a","status":"OPEN","queued":true}"#)).kind,
            .openRun)
    }

    /// The reported gap, stated as a test: the row's own `status` says FAILED and the platform
    /// re-dispatched the task two seconds ago. A status-driven Retry here is the button that can
    /// only be refused — so the SESSIONS decide, not the label.
    func testAStaleFailedStatusDoesNotDrawARetryOverALiveRun() {
        let stale = TaskRunHandoff.entry(for: task(#"""
        {"id":"t","title":"a","status":"FAILED",
         "sessions":[{"id":"old","status":"FAILED"},{"id":"6vVUlXGyjjJEQtxymaTkCM","status":"RUNNING"}]}
        """#))
        XCTAssertEqual(stale.kind, .openRun, "the row lags; the run rows do not")
        XCTAssertEqual(stale.sessionID, "6vVUlXGyjjJEQtxymaTkCM")

        let pending = TaskRunHandoff.entry(for: task(#"""
        {"id":"t","title":"a","status":"FAILED","sessions":[{"id":"next","status":"PENDING"}]}
        """#))
        XCTAssertEqual(pending.kind, .openRun)
        XCTAssertEqual(pending.sessionID, "next")
    }

    /// …and with nothing going, the entries are exactly what they were. This change is about the
    /// third case, not about the two that already worked.
    func testWithNothingGoingTheEntryIsUnchanged() {
        let failed = TaskRunHandoff.entry(for: task(#"""
        {"id":"t","title":"a","status":"FAILED","sessions":[{"id":"old","status":"FAILED"}]}
        """#))
        XCTAssertEqual(failed.kind, .retry)
        XCTAssertEqual(failed.label, "Retry")
        XCTAssertNil(failed.sessionID)

        let open = TaskRunHandoff.entry(for: task(#"{"id":"t","title":"a","status":"OPEN"}"#))
        XCTAssertEqual(open.kind, .run)
        XCTAssertEqual(open.label, "Run")
    }
}
