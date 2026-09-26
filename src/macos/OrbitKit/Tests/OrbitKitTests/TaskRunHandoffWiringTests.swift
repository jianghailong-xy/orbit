import Foundation
import XCTest
@testable import OrbitKit

/// The wires that carry a task-run refusal as STRUCTURE all the way to the screen.
///
/// `TaskRunHandoff` is proved next door (`TaskRunHandoffTests`) and held to the browser's wording
/// by `TaskRunHandoffCopyParityTests` — but none of that says the app is using it, and no compiler
/// on this platform can: SwiftUI does not exist here, and `ConsoleModel.swift` / `TasksModel.swift`
/// / the views are compiled only by the macOS and iOS jobs.
///
/// The reported failure was not in any logic. It was one line above it — `errorText =
/// friendly(error)`, which reduced a structured refusal to `body["message"]` — and a test of the
/// logic alone would have stayed green through the entire incident. So the wiring is asserted the
/// one way it can be from Linux, over the source, with each assertion written so that UNDOING the
/// wire is what turns it red:
///
///  - a failed Run keeps the refusal whole, and `friendly(error)` is now only the fallback;
///  - a send follows its message to the run that took it, instead of leaving a bubble that lied;
///  - a run that is letting go is waited out, and the wait is bounded;
///  - nothing stops a run except the reader's own answer to the question about that run;
///  - the auto-retry card is handed its own refusal, and the composer says when a pick takes hold;
///  - the task entries are drawn from `TaskRunHandoff.entry`, so a live run wins over `status`.
///
/// The same instrument, and the same limits, as `ComposerHandoffWiringTests`: it cannot see layout.
final class TaskRunHandoffWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the clients still read these refusals as structure."
            }
        }
    }

    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"
    private static let consoleModel = app + "ConsoleModel.swift"
    private static let tasksModel = app + "TasksModel.swift"
    private static let tasksView = app + "Views/TasksView.swift"
    private static let consoleView = app + "Views/Console/ConsoleView.swift"
    private static let autoRetryCard = app + "Views/Console/AutoRetryCard.swift"
    private static let handoffCard = app + "Views/TaskRunHandoffCard.swift"

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

    /// One stretch of a file — from a marker to the next occurrence of another — so a match
    /// somewhere else cannot answer for the part being asserted about. (A bare `contains` over a
    /// whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    // MARK: the root: a refusal is no longer flattened

    /// The line the incident came through. `mutate` is every task button's one exit, so this is the
    /// single place a Run's answer is decided — and `friendly(error)` has to be what happens when
    /// nothing else can be said, not what happens first.
    func testAFailedRunKeepsTheRefusalWholeAndOnlyFallsBackToTheSentence() throws {
        let model = try source(Self.tasksModel)
        let mutate = try section(model, from: "private func mutate(", to: "private func friendly(")

        XCTAssertTrue(mutate.contains("TaskRunHandoff.readConflict(error)"),
                      "the refusal is read as structure before anything else is done with it")
        XCTAssertTrue(mutate.contains("runConflict = conflict"))
        // The fallback survives, and is a fallback: an `else`, not the unconditional assignment
        // that used to be the whole handler.
        XCTAssertTrue(mutate.contains("else { errorText = friendly(error) }"),
                      "a code this build has no words for still shows the server's own sentence")
        XCTAssertFalse(mutate.contains("catch {\n            errorText = friendly(error)"),
                       "this is the exact line the reported failure came through")

        // And it is readable by a view, which is what "reaches the render layer" means here.
        XCTAssertTrue(model.contains("private(set) var runConflict: TaskRunHandoff.Conflict?"))
        XCTAssertTrue(model.contains("func clearRunConflict()"))
    }

    /// Same root, the other client surface: a typed message's refusal.
    func testASendReadsItsRefusalAsStructureAndKeepsTheSentenceAsFallback() throws {
        let model = try source(Self.consoleModel)
        let handler = try section(model, from: "if let held = error as? TaskRunStillHeld",
                                  to: "/// Answer the one question")
        XCTAssertTrue(handler.contains("TaskRunHandoff.readConflict(error)"))
        XCTAssertTrue(handler.contains("runConflict = conflict"))
        XCTAssertTrue(handler.contains("statusMessage = ComposerLogic.sendFailureMessage(error)"),
                      "an unknown code, an older server and a dead connection still read the "
                          + "words they always did")
        XCTAssertTrue(model.contains("private(set) var runConflict: TaskRunHandoff.Conflict?"))
    }

    // MARK: §2.1 the message follows the task

    /// The success that used to be a refusal. Two things have to happen together: the bubble comes
    /// back down, because the message is NOT in this session, and the reader is told where it went.
    /// Leaving the bubble would be the worse half of the old bug — a message that looks delivered
    /// here and is being worked on somewhere else.
    func testASendFollowsItsMessageToTheRunThatTookIt() throws {
        let model = try source(Self.consoleModel)
        let routed = try section(model, from: "if let routed = TaskRunHandoff.routedToSession(accepted)",
                                 to: "if let tid = accepted.turnId")
        XCTAssertTrue(routed.contains("reducer.removeOptimisticUser(clientTurnId: clientTurnId)"),
                      "the bubble is not here, so it does not stay here")
        XCTAssertTrue(routed.contains("handedOverSessionID = routed"))

        // …and the view puts one press on it.
        let view = try source(Self.consoleView)
        XCTAssertTrue(view.contains("TaskRunHandedOverCard("))
        XCTAssertTrue(view.contains("sessionID: routed"))
        XCTAssertTrue(view.contains("onOpenRun: { appModel.route(to: .session($0)) }"),
                      "following the message is a route to that run, not a sentence about it")
    }

    // MARK: §2.3 waiting, and its bound

    /// A run that is letting go frees the task by itself, so the client waits rather than handing
    /// the reader a refusal about a situation that is already resolving — and the wait is bounded,
    /// because a client that went on resending would poll for as long as the window stays open.
    func testARunThatIsLettingGoIsWaitedOutAndTheWaitIsBounded() throws {
        let model = try source(Self.consoleModel)
        let post = try section(model, from: "private func postTurn(", to: "/// Run a send that is safe")

        XCTAssertTrue(post.contains("conflict.kind == .ending"),
                      "read the field, not the status: a cancelled run is still RUNNING")
        XCTAssertTrue(post.contains("waits < TaskRunHandoff.resendMaxAttempts"))
        XCTAssertTrue(post.contains("TaskRunHandoff.stillHeldAfterWaiting(conflict)"),
                      "once the resends are spent the card says the true thing instead")
        XCTAssertTrue(post.contains("TaskRunHandoff.resendAfter"))
        // The wait shows where its outcome will: one message, one place it is being answered.
        XCTAssertTrue(post.contains("runConflictFromRetry = sendingAutoRetry"))
        // The identical request goes back out, which is the only reason resending is safe at all.
        XCTAssertTrue(post.contains("let resumeRequest = ResumeRequest(clientTurnId: clientTurnId"))
    }

    // MARK: §2.2 nothing is stopped without being asked

    /// Rule 2, as a wire: the only value that can ever reach `stopSessionId` came out of
    /// `stopSessionID(_:confirmed:)`, which answers nil for every conflict that is not the question
    /// about stopping and for every question that has not been answered.
    func testOnlyTheReadersOwnAnswerCanStopARunThatIsWorking() throws {
        let model = try source(Self.consoleModel)

        XCTAssertTrue(model.contains("stopSessionId: confirmedStopSessionID"),
                      "the request carries the confirmation and nothing else")
        let stop = try section(model, from: "func stopAndContinue() async {", to: "func keepRunning()")
        XCTAssertTrue(stop.contains("TaskRunHandoff.stopSessionID(runConflict, confirmed: true)"))
        XCTAssertTrue(stop.contains("guard let stop"),
                      "no answer, no stop — the guard is the rule")
        XCTAssertTrue(stop.contains("defer { confirmedStopSessionID = nil }"),
                      "the authorisation is spent by the one send it was given for; a remembered "
                          + "one would stop a later run nobody was asked about")

        // The other answer exists and is the harmless one.
        let keep = try section(model, from: "func keepRunning()", to: "func dismissRunConflict()")
        XCTAssertTrue(keep.contains("runConflict = nil"))
        XCTAssertFalse(keep.contains("await send"), "'keep it running' sends nothing")

        // Nowhere else may fill that field in.
        XCTAssertEqual(model.components(separatedBy: "confirmedStopSessionID = ").count - 1, 2,
                       "confirmedStopSessionID is written exactly twice — set by the answer, "
                           + "cleared after the send it authorised — and a third write is how a "
                           + "stop would come to be authorised by something other than that answer")

        // And the question is not dismissible into silence: a card the reader can only X away
        // would leave the message unsent with no record of what was asked.
        let view = try source(Self.consoleView)
        XCTAssertTrue(view.contains("let dismiss: (() -> Void)? = conflict.kind == .confirmSwitch"))
    }

    // MARK: (d) the three places the answer shows

    /// The auto-retry card is handed its OWN refusal, and shows it where the button was.
    func testTheAutoRetryCardIsHandedItsOwnRefusal() throws {
        let card = try source(Self.autoRetryCard)
        XCTAssertTrue(card.contains("takenOver: console.autoRetryTakenOver"),
                      "the card's state is computed WITH the refusal, not decorated after it")
        let rendered = try section(card, from: "if let takenOver = s.takenOver", to: "}\n        .padding(10)")
        XCTAssertTrue(rendered.contains("TaskRunHandoffCard(conflict: takenOver"))
        XCTAssertTrue(rendered.contains("app.route(to: .session($0))"))

        // …and only its own: a typed message's refusal belongs by the composer, and a question
        // about a provider is answered where the provider was picked.
        let model = try source(Self.consoleModel)
        let taken = try section(model, from: "var autoRetryTakenOver:", to: "/// The same refusal when")
        XCTAssertTrue(taken.contains("runConflictFromRetry"))
        XCTAssertTrue(taken.contains("runConflict?.kind != .confirmSwitch"))
    }

    /// The composer says WHEN a provider pick takes hold — the part the old four-second line left
    /// out, and the whole question, because a run keeps its provider for its whole life.
    func testTheComposerSaysWhenAProviderPickTakesHold() throws {
        let model = try source(Self.consoleModel)
        let select = try section(model, from: "func selectProvider(", to: "func pickDraftProvider(")
        XCTAssertTrue(select.contains("TaskRunHandoff.providerSwitchNote(from: from, to: slug, liveRun: isLive)"))
        XCTAssertTrue(select.contains("let from = provider"),
                      "read before the assignment, or the note describes a move from X to X")

        let view = try source(Self.consoleView)
        XCTAssertTrue(view.contains("if let note = console.providerSwitchNote"))
        // Spent when the pick has done what it said it would, not on a timer.
        XCTAssertTrue(model.contains("providerSwitchNote = nil"))
    }

    /// The entries. Both the row and the detail ask `TaskRunHandoff.entry`, which reads the live
    /// run rather than the `status` label that lagged — and with nothing going, both still draw
    /// exactly what they drew before.
    func testTheTaskEntriesAreDrawnFromTheLiveRunAndNotFromTheStatusLabel() throws {
        let view = try source(Self.tasksView)

        let row = try section(view, from: "private func rowMenu(", to: "private func emptyOverlay(")
        XCTAssertTrue(row.contains("TaskRunHandoff.entry(for: task)"))
        XCTAssertTrue(row.contains("entry.kind == .openRun"))
        // A list row names no run, so it opens the task rather than guessing at one.
        XCTAssertTrue(row.contains("model.route(to: .task(task.id))"))
        XCTAssertTrue(row.contains("model.route(to: .session(id))"))
        // …and with nothing going it is still the same press it always was.
        XCTAssertTrue(row.contains("Task { _ = await tasks.execute(task.id) }"),
                      "no live run ⇒ the Run/Retry press is unchanged")
        XCTAssertTrue(row.contains("entry.kind == .retry ? \"arrow.clockwise\" : \"play.fill\""))
        XCTAssertFalse(row.contains("task.status == .failed ? \"Retry\" : \"Run\""),
                       "the label came off `status`, which is the thing that lags")

        let detail = try section(view, from: "private func actionRow(_ task: TaskItem)",
                                 to: "private func runDisabledHint")
        XCTAssertTrue(detail.contains("TaskRunHandoff.entry(for: task)"))
        XCTAssertTrue(detail.contains("TaskDetailLogic.actionRow("), "one rule lays the presses out")
        XCTAssertTrue(detail.contains("model.route(to: .session(sessionID))"),
                      "the detail carries the sessions, so it links to the run itself")
        // The live run's press already says where it goes; the sentence that stood under it said the
        // same thing again (the owner's redesign, 2026-09-26). Only a press that cannot be taken says why.
        XCTAssertFalse(detail.contains("Text(entry.hint)"))
        XCTAssertTrue(detail.contains("let hint = runDisabledHint(task)"))
        XCTAssertTrue(detail.contains("Task { _ = await tasks.execute(task.id) }"))
        XCTAssertFalse(detail.contains("task.status == .failed ? \"Retry\" : \"Run\""))

        // The refusal a press does meet, over the list and over the detail.
        XCTAssertTrue(view.contains("if let conflict = tasks.runConflict"))
        XCTAssertTrue(view.contains("onClearPin:"), "the pin refusal's second way out edits the task")
    }

    /// The card writes no words of its own.
    ///
    /// It is the last place a sentence could be introduced at one end only — the parity test reads
    /// `TaskRunHandoff.swift` and would never see it. So every visible string in the view comes
    /// from the conflict or from the shared constants, and what is left is SF Symbol names and one
    /// accessibility label.
    func testTheCardIntroducesNoCopyOfItsOwn() throws {
        let card = try source(Self.handoffCard)
        let stripped = card
            .replacingOccurrences(of: "///[^\n]*", with: "", options: .regularExpression)
            .replacingOccurrences(of: "//[^\n]*", with: "", options: .regularExpression)
        let literals = stripped.components(separatedBy: "\"")
            .enumerated().filter { $0.offset % 2 == 1 }.map(\.element)

        let allowed: Set<String> = [
            // SF Symbols, which are identifiers rather than words.
            "xmark", "clock.fill", "questionmark.circle.fill", "exclamationmark.triangle.fill",
            "checkmark.circle.fill", "arrow.clockwise",
            // The one sentence that is about this card and not about the refusal, plus the label
            // a screen reader needs for a glyph.
            "Re-sending as soon as it lets go", "Dismiss",
        ]
        for literal in literals {
            XCTAssertTrue(allowed.contains(literal),
                          "\(literal.debugDescription) is copy written in the view. Refusal "
                              + "wording belongs in TaskRunHandoff, where the parity test reads it.")
        }
        // …and it does take its words from there.
        XCTAssertTrue(card.contains("TaskRunHandoff.handedOverTitle"))
        XCTAssertTrue(card.contains("TaskRunHandoff.handedOverBody"))
        XCTAssertTrue(card.contains("TaskRunHandoff.openTheRun"))
        XCTAssertTrue(card.contains("Text(conflict.title)"))
        XCTAssertTrue(card.contains("Text(conflict.body)"))
    }
}
