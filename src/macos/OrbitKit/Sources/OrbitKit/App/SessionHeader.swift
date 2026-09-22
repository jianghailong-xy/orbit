import Foundation

/// The session console's header text — a 1:1 port of the web Agent console header (`AgentView.tsx`):
/// the session's title over a "run state · lifecycle · when" subtitle
/// ("Running · Open · 3m ago"). Kept in OrbitKit so
/// macOS + iOS share the exact web wording and it's unit-tested. `statusWord` mirrors web's
/// `statusLabel` (its wording agrees with `SessionStatusGlyph`'s tooltip but stays terse for the
/// subtitle); the time half reuses `RelativeTime`.
public enum SessionHeader {
    /// The header title: the session's own title, else its agent's name, else a neutral default —
    /// mirroring web's `selected?.title ?? headAgentName`.
    public static func title(for session: Session?, fallbackAgent: String?) -> String {
        if let t = session?.title, !t.isEmpty { return t }
        if let a = fallbackAgent, !a.isEmpty { return a }
        return "Session"
    }

    /// The short execution-state word. Lifecycle location is deliberately not consulted: a succeeded
    /// session remains "Succeeded" in Open, Completed and Trash alike. The DTO resolves old servers.
    /// `watching` is the session as an observer: parked with a live watch that will resume it, it
    /// reads "Watching 7 targets" — not "Waiting for your reply", and not a background process.
    public static func statusWord(for s: Session, watching: WatchSessionSummary? = nil,
                                  now: Date = Date()) -> String {
        // Somebody waiting on YOU outranks everything else the word could say, and — as in the web
        // `statusLabel` this mirrors — the check sits OUTSIDE the generating gate: an owner
        // confirmation is held open by no turn, so it is still waiting once the conversation parks.
        // Read here rather than per-branch, or a parked session with one waiting would answer
        // "Waiting for your reply" over a question the reader can answer.
        if (s.pendingApprovals ?? 0) > 0 { return waitingWord(for: s) }
        switch s.effectiveRunState {
        case .queued:
            return "Queued"
        case .running:
            return "Running"
        case .awaitingInput:
            // A turn the runtime started for itself keeps the run state parked for its whole
            // duration, so the parked branch is where it has to be caught (see `isGenerating`).
            if s.isGenerating {
                return "Running"
            }
            if let watching = parkedOnWatch(s, watching) { return watching.word }
            if (s.runningBgCount ?? 0) > 0 { return SessionLine.bgRunningLabel(s.runningBgCount ?? 0) }
            return "Waiting for your reply"
        case .succeeded:
            return "Succeeded"
        case .failed:
            // Not "Failed" while the server is still going to re-send it — see `retryPending`.
            if s.retryPending(now: now) { return "Retrying" }
            return (s.error ?? "").lowercased().contains("offline") ? "Disconnected" : "Failed"
        case .interrupted:
            return "Interrupted"
        case .ended, .unknown:
            return "Ended"
        }
    }

    /// What a session that is waiting on you says — the one word the console header and the list
    /// row share, in the words of whatever is actually waiting.
    ///
    /// The server names the kind when everything it counted is one kind with words of its own
    /// (`waitingKind`), and then the row says it: an OWNER_CONFIRMED task's run in the confirmation
    /// card's words, and one of the four owner items in the words the banner and the card use, so a
    /// person who pressed either arrives where the words came from. Anything else waiting on you —
    /// a blocked tool call, a proposal, a row counting two kinds at once — keeps the approval
    /// wording. Web parity: `waitingLabel` in `WorkspaceView.tsx`, which the copy-parity test reads.
    public static func waitingWord(for s: Session) -> String {
        switch s.waitingKind {
        case .ownerConfirmation: return OwnerConfirmations.waitingForConfirmation
        case .ownerItem:         return NeedsYouLogic.oldestItemWord(s.ownerItems) ?? unnamedWord
        default:                 return unnamedWord
        }
    }

    /// What a row waiting on you says when the server named no kind, or named one this build has no
    /// words for: somebody is waiting, and this is the row's own long-standing way of saying it.
    static let unnamedWord = "Waiting for approval"

    /// The full "run state · lifecycle · when" subtitle. Keeping both dimensions visible prevents
    /// "Succeeded" from being mistaken for Completed. `now` is injectable for deterministic tests.
    /// Returns nil when there's no session to describe (a fresh deep link) so the caller can fall
    /// back to the live stream's status.
    public static func subtitle(for session: Session?, watching: WatchSessionSummary? = nil,
                                now: Date = Date()) -> String? {
        guard let s = session else { return nil }
        let word = statusWord(for: s, watching: watching, now: now)
        let lifecycle = lifecycleWord(for: s)
        // The two axes no longer share any vocabulary — a filed session reads "Ended · Completed",
        // which is exactly the split this subtitle exists to show — so there is nothing to collapse.
        let head = "\(word) · \(lifecycle)"
        // Parked on a watch, the "when" that matters is the evaluator's last look at the targets, not
        // the last turn: "Background process running · 3m ago" is the reading this replaces.
        if let watching = parkedOnWatch(s, watching) {
            var parts = [head, watching.progress]
            if let evaluated = watching.lastEvaluated(now: now) { parts.append(evaluated) }
            return parts.joined(separator: " · ")
        }
        if let ts = s.lastTurnAt ?? s.createdAt, let rel = RelativeTime.format(ts, now: now) {
            return "\(head) · \(rel)"
        }
        return head
    }

    /// The watch a session is parked on, when that's what its header should say: nothing is
    /// generating and nobody is waiting on you — either of those is the more pressing word.
    private static func parkedOnWatch(_ s: Session, _ watching: WatchSessionSummary?) -> WatchSessionSummary? {
        guard s.effectiveRunState == .awaitingInput, !s.isGenerating, (s.pendingApprovals ?? 0) == 0 else {
            return nil
        }
        return watching
    }

    public static func lifecycleWord(for s: Session) -> String {
        switch s.effectiveLifecycleState {
        case .open, .unknown: return "Open"
        case .completed: return "Completed"
        case .trash: return "Trash"
        }
    }
}
