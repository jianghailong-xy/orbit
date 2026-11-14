import Foundation

// Compact and Start a new coordinator from the composer's context gauge
// (docs/mocks/coordinator-context-actions boards 01–03), and the handoff a coordinator goes through
// once Start a new coordinator is confirmed (docs/coordinator-handoff.md). UI-free, so the rules
// the macOS popover and the iOS sheet share are tested on Linux.

/// The context panel's action rows (boards 01 and 03). The same words on every client.
public enum CoordinatorContextCopy {
    public static let title = "Context"
    public static let compact = "Compact"
    public static let compactDetail = "Summarize earlier turns and keep going here."
    /// Compact's detail while a turn runs, when the row is greyed out.
    public static let compactWhileRunning = "Available when this turn ends."
    public static let newCoordinator = "Start a new coordinator"
    public static let newCoordinatorDetail =
        "This one writes a handoff note, then the project continues in a fresh conversation."
    /// While a turn runs: still pressable, and the handoff waits for the turn to end.
    public static let newCoordinatorWhileRunning =
        "Begins after this turn ends: a handoff note, then a fresh conversation."

    /// The phone's system Alert body (board 03 iOS 2): the confirm's words, with the waits as a count
    /// only — and no count when there are none.
    public static func phoneConfirmBody(waits: Int, running: Bool) -> String {
        let lead = running
            ? "After the current turn ends, this coordinator writes a handoff note"
            : "This coordinator writes a handoff note"
        let moves = waits > 0 ? " \(CoordinatorHandoffCopy.waitsRowTitle(waits))." : ""
        return "\(lead), then the project continues in a new conversation.\(moves) Nothing is deleted."
    }
}

/// Board 02's copy, verbatim: `COORDINATOR_HANDOFF_COPY` in src/shared/src/coordinator-handoff.ts.
public enum CoordinatorHandoffCopy {
    public static let confirmTitle = "Hand over to a new coordinator?"
    public static func confirmBody(_ projectTitle: String) -> String {
        "This coordinator writes a handoff note, then \(projectTitle) continues in a new conversation that starts from that note. This one is completed — nothing is deleted."
    }
    public static func confirmBodyWhileRunning(_ projectTitle: String) -> String {
        "After the current turn ends, this coordinator writes a handoff note, then \(projectTitle) continues in a new conversation that starts from that note. This one is completed — nothing is deleted."
    }
    public static let noteRowTitle = "Handoff note"
    public static let noteRowDetail = "Written by this coordinator before it hands over. Usually under a minute."
    public static func waitsRowTitle(_ count: Int) -> String {
        count == 1 ? "1 pending wait moves over" : "\(count) pending waits move over"
    }
    /// A paused wait in the macOS confirm's list (the handoff task's note: phones show only the count).
    public static let pausedSuffix = " (paused)"
    public static let cancel = "Cancel"
    public static let handOver = "Hand over"
    public static let badgeHandingOver = "Handing over"
    public static let writing = "Writing the handoff note"
    public static let compacting = "Compacting…"
    public static let skipNote = "Skip the note"
    public static let cancelHandover = "Cancel handover"
    public static let handingOver = "Handing over to a new coordinator…"
    public static let noteCardTitle = "Handoff from the previous coordinator"
    public static func waitsMovedHere(_ count: Int) -> String {
        count == 1 ? "1 wait moved here" : "\(count) waits moved here"
    }
    public static let handedOver = "Handed over to a new coordinator."
    public static let openIt = "Open it"
    public static let tryAgain = "Try again"
    public static let handOverWithoutNote = "Hand over without a note"
    public static let keepThisCoordinator = "Keep this coordinator"

    /// `COORDINATOR_HANDOFF_SECTIONS`: the note's four sections, in order.
    public static let sections = ["Where things stand", "Agreed with the owner", "Waiting on", "Next"]

    /// `COORDINATOR_HANDOFF_FAILURE_REASONS`, and the sentence a failure shows when the server sent
    /// none (`coordinatorHandoffFailureSentence`).
    public static let failureReasons: [CoordinatorHandoffFailureCode: String] = [
        .turnFailed: "the turn failed.",
        .turnStopped: "the turn was stopped.",
        .timedOut: "the turn timed out.",
        .emptyNote: "the reply was empty.",
        .replaceFailed: "the new coordinator could not be opened.",
    ]
    public static func failureSentence(_ code: CoordinatorHandoffFailureCode) -> String {
        "The handoff note wasn't written: \(failureReasons[code] ?? "")"
    }
}

/// One of the handoff's presses, and the endpoint it goes to.
public enum CoordinatorHandoffAction: String, Equatable, Sendable, CaseIterable {
    case start, skip, cancel, retry

    var pathSuffix: String { self == .start ? "" : "/\(rawValue)" }
}

/// Who may see which action, and when (board 01's notes ①–④, board 03's ④).
public enum CoordinatorContextActions {
    /// What Compact sends: the engine's own command, as if typed.
    public static let compactCommand = "/compact"

    /// The note turn's `clientTurnId` prefix (`COORDINATOR_HANDOFF_TURN_PREFIX`). The turn is the
    /// platform's, not the owner's, so the transcript does not draw it as a message.
    public static let handoffTurnPrefix = "coordinator-handoff:v1:"

    public static func isHandoffTurn(clientTurnId: String?) -> Bool {
        clientTurnId?.hasPrefix(handoffTurnPrefix) == true
    }

    /// Compact is offered only where the session's engine lists `compact` among its slash assets — so
    /// not on Codex (no registry) and not on Cursor, which lists none by that name.
    public static func offersCompact(slashItems: [SlashCommandInfo], engine: String?) -> Bool {
        ComposerSlash.forEngine(items: slashItems, engine: engine)
            .contains { $0.name == "compact" && $0.type != "local" }
    }

    /// Compact waits for the running turn to end (greyed out, "Available when this turn ends."), and
    /// for a handoff that has the composer locked.
    public static func compactEnabled(running: Bool, handoff: SessionCoordinatorHandoff? = nil) -> Bool {
        !running && !locksComposer(handoff)
    }

    /// Compact is drawn emphasised (accent icon, default focus) from 75% — where the ring turns orange.
    public static func emphasizesCompact(percent: Int) -> Bool { percent >= 75 }

    /// Start a new coordinator: only on the project's current coordinator (the session the project
    /// points at — `projectId`), only while it is not completed, and not while a handoff of it is
    /// already shown in the conversation (that row carries the presses that apply then).
    public static func offersNewCoordinator(_ session: Session?) -> Bool {
        guard let session, session.projectId != nil else { return false }
        guard session.effectiveLifecycleState == .open else { return false }
        return session.coordinatorHandoff == nil
    }

    /// The composer is disabled while the note is being written and while the replacement runs.
    public static func locksComposer(_ handoff: SessionCoordinatorHandoff?) -> Bool {
        handoff?.state == .writing || handoff?.state == .handingOver
    }
}

/// What the outgoing coordinator's conversation shows of its handoff (board 02 ②, ④, ⑤).
public enum CoordinatorHandoffRow: Equatable, Sendable {
    /// ② "Writing the handoff note 0:24", with Skip the note and Cancel handover.
    case writing(startedAt: Date?)
    /// ② "Handing over to a new coordinator…" — the note is in and the replacement runs.
    case handingOver
    /// ⑤ The reason, and the presses that can still work.
    case failed(reason: String, actions: [CoordinatorHandoffAction])
    /// ④ "Handed over to a new coordinator." with Open it, in place of the composer.
    case completed(successorSessionID: String)

    public static func resolve(_ handoff: SessionCoordinatorHandoff?) -> CoordinatorHandoffRow? {
        guard let handoff else { return nil }
        switch handoff.state {
        case .writing:
            return .writing(startedAt: RelativeTime.parse(handoff.startedAt))
        case .handingOver:
            return .handingOver
        case .failed:
            let reason = handoff.failureReason
                ?? handoff.failureCode.map(CoordinatorHandoffCopy.failureSentence)
                ?? CoordinatorHandoffCopy.failureSentence(.turnFailed)
            // The replacement threw after the outgoing coordinator was completed: there is nothing
            // to try again on and nothing to keep, so only the press that needs no note remains.
            let actions: [CoordinatorHandoffAction] = handoff.failureCode == .replaceFailed
                ? [.skip] : [.retry, .skip, .cancel]
            return .failed(reason: reason, actions: actions)
        case .completed:
            guard let successor = handoff.handedOverToSessionId else { return nil }
            return .completed(successorSessionID: successor)
        case .cancelled, .unknown:
            return nil
        }
    }

    /// The label each failure press carries.
    public static func label(_ action: CoordinatorHandoffAction) -> String {
        switch action {
        case .start: return CoordinatorHandoffCopy.handOver
        case .retry: return CoordinatorHandoffCopy.tryAgain
        case .skip: return CoordinatorHandoffCopy.handOverWithoutNote
        case .cancel: return CoordinatorHandoffCopy.keepThisCoordinator
        }
    }

    /// "0:24" — the WRITING timer, minutes and seconds.
    public static func clock(since start: Date?, now: Date = Date()) -> String {
        guard let start else { return "0:00" }
        let whole = max(0, Int(now.timeIntervalSince(start)))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }
}

/// The successor's note card (board 02 ③): the note split into its sections.
public struct CoordinatorHandoffNote: Equatable, Sendable {
    public struct Section: Equatable, Sendable {
        public let title: String
        public let items: [String]
    }
    public let sections: [Section]
    /// Text before the first section heading, or a note with no headings at all.
    public let preamble: String

    /// Reads markdown headings (`#`…, or a line that is a bold section name) and `-`/`*` bullets.
    public static func parse(_ note: String) -> CoordinatorHandoffNote {
        var sections: [Section] = []
        var preamble: [String] = []
        var title: String?
        var items: [String] = []
        func flush() {
            if let title { sections.append(Section(title: title, items: items)) }
            items = []
        }
        for raw in note.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if let heading = headingText(line) {
                flush()
                title = heading
                continue
            }
            var item = line
            for marker in ["- ", "* ", "• "] where item.hasPrefix(marker) {
                item = String(item.dropFirst(marker.count))
            }
            if title == nil { preamble.append(item) } else { items.append(item) }
        }
        flush()
        return CoordinatorHandoffNote(sections: sections, preamble: preamble.joined(separator: "\n"))
    }

    private static func headingText(_ line: String) -> String? {
        var text = line
        if text.hasPrefix("#") {
            text = String(text.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? nil : text.trimmingCharacters(in: CharacterSet(charactersIn: "*:"))
        }
        let bare = text.trimmingCharacters(in: CharacterSet(charactersIn: "*_:"))
            .trimmingCharacters(in: .whitespaces)
        return CoordinatorHandoffCopy.sections.contains(bare) ? bare : nil
    }
}
