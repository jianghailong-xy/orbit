import Foundation

/// The one status glyph shown at the leading edge of a session row — a direct port of the web Agent
/// console's `StatusIcon`. Colour carries the meaning: brand = working, warning = needs a human
/// decision, success = done, error = a real failure, neutral = a benign terminal / queued state.
///
/// Kept in OrbitKit (not the SwiftUI view) so the exact web mapping is shared by macOS + iOS and
/// unit-tested. The view turns `shape`/`tone` into an SF Symbol (or spinner) and a colour.
///
/// New servers provide `runState`, which is deliberately independent from Open / Completed / Trash.
/// Older servers fall back through the mixed `sessionState` and raw runner status in the DTO.
public struct SessionStatusGlyph: Equatable, Sendable {
    /// How the view should draw the glyph. `.spinner` is the animated "working" indicator (web's
    /// `LoadingOutlined spin`); `.symbol` names an SF Symbol.
    public enum Shape: Equatable, Sendable {
        case spinner
        case symbol(String)
    }
    /// Semantic colour role; the view maps these to concrete colours (matching the web tokens
    /// `--brand` / `--success-solid` / `--warning-solid` / `--error` / `--text-3`).
    public enum Tone: String, Equatable, Sendable {
        case brand    // working (blue)
        case success  // done (green)
        case warning  // needs a decision (amber)
        case error    // failed (red)
        case neutral  // idle / terminal / queued (grey)
    }
    public let shape: Shape
    public let tone: Tone
    /// Accessibility label / tooltip, matching the web tooltip wording so the glyph reads the same.
    public let label: String
    /// Whether the view draws this glyph breathing (a slow opacity pulse) — the one motion in the
    /// vocabulary that is neither rotation nor a dot, and the web's `status-glyph-active`.
    ///
    /// It is set for exactly one state: a parked session with a background JOB in flight. The
    /// claim it makes is narrower than the spinning one — "there is work happening here", not "the
    /// agent is working" — which is why the shape and the tone stay the ones that mean *not*
    /// working. A process the workspace merely left up (a `service`) is in the same glyph with
    /// `pulse == false`, so what moves is the fact, not the state.
    public let pulse: Bool

    public init(shape: Shape, tone: Tone, label: String, pulse: Bool = false) {
        self.shape = shape
        self.tone = tone
        self.label = label
        self.pulse = pulse
    }

    /// The glyph for a session. Lifecycle location never overrides the run's actual state.
    /// `watching` is the session as an observer (see `SessionHeader.statusWord`).
    public static func make(for s: Session, watching: WatchSessionSummary? = nil,
                            now: Date = Date()) -> SessionStatusGlyph {
        make(runState: s.effectiveRunState,
             pendingApprovals: s.pendingApprovals,
             runningBgCount: s.runningBgCount,
             runningBgJobCount: s.runningBgJobCount,
             runningSubagentCount: s.runningSubagentCount,
             engineTurnActive: s.engineTurnActive == true,
             error: s.error,
             retryPending: s.retryPending(now: now),
             watchingLabel: watching?.word,
             waitingKind: s.waitingKind)
    }

    /// Compatibility overload for callers that hold legacy plain fields rather than a Session.
    public static func make(status: RunStatus,
                            runState: SessionRunState? = nil,
                            sessionState: SessionState? = nil,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            runningBgJobCount: Int? = nil,
                            engineTurnActive: Bool = false,
                            error: String? = nil,
                            endReason: String? = nil,
                            retryPending: Bool = false) -> SessionStatusGlyph {
        make(runState: SessionRunState.resolve(runState, legacy: sessionState,
                                               status: status, endReason: endReason),
             pendingApprovals: pendingApprovals,
             runningBgCount: runningBgCount,
             runningBgJobCount: runningBgJobCount,
             engineTurnActive: engineTurnActive,
             error: error,
             retryPending: retryPending)
    }

    /// The shared presentation mapping for the orthogonal execution state. The end reason is
    /// deliberately absent: it is consumed by `SessionRunState.resolve` and never reaches the
    /// glyph, because no two deliberate ends deserve different symbols. Prose (the ended banner)
    /// is where the reason still gets spelled out.
    public static func make(runState: SessionRunState,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            runningBgJobCount: Int? = nil,
                            runningSubagentCount: Int? = nil,
                            engineTurnActive: Bool = false,
                            error: String? = nil,
                            retryPending: Bool = false,
                            watchingLabel: String? = nil,
                            waitingKind: SessionWaitingKind? = nil) -> SessionStatusGlyph {
        // Somebody waiting on YOU outranks everything else — first, and outside the generating gate,
        // exactly as it is in the word beside this glyph (`SessionHeader.statusWord`) and in the web
        // `StatusIcon` both mirror. The two are read together on one row: a pause glyph labelled
        // "Waiting for your reply" over a question the reader can answer is that same disagreement in
        // a different medium.
        if (pendingApprovals ?? 0) > 0 {
            return .init(shape: .symbol("pause.circle"), tone: .warning,
                         label: waitingKind == .ownerConfirmation
                            ? OwnerConfirmations.waitingForConfirmation : "Waiting for approval")
        }
        // The working glyph, shared by the two states that mean the agent is generating.
        func generating() -> SessionStatusGlyph {
            .init(shape: .spinner, tone: .brand, label: "Running")
        }
        switch runState {
        case .queued:
            return .init(shape: .symbol("clock"), tone: .neutral, label: "Queued")

        case .running:
            return generating()

        case .awaitingInput:
            // A turn the runtime started for itself is the agent working, so it earns the same
            // spinner a dispatched turn gets — and it outranks a background process left up
            // below, which is not the agent working at all.
            if engineTurnActive { return generating() }
            // A sub-agent or workflow it started is the workspace itself still working, so it keeps
            // the working spinner — unlike a process left up below (web `StatusIcon`).
            if let n = runningSubagentCount, n > 0 {
                return .init(shape: .spinner, tone: .brand, label: SessionLine.subagentRunningLabel(n))
            }
            // Parked on a live watch (`watchingLabel` is its "Watching 7 targets"): a wake is coming,
            // so neither the reply bubble nor the background process's console glyph fits — unless
            // somebody is waiting on you, which a watch never hides.
            if let watchingLabel, (pendingApprovals ?? 0) == 0 {
                return .init(shape: .symbol("eye"), tone: .neutral, label: watchingLabel)
            }
            if (runningBgCount ?? 0) > 0 {
                // Not the agent working: a dev server or watcher the agent left up never exits,
                // so the working spinner would mark the session busy for the rest of its life.
                // A muted console glyph says "still something running" without it — and breathes
                // when at least one of those processes is a job with an end, because that is work
                // the session is actually waiting on (see `runningBgJobCount`). The words and the
                // shape are the same either way; only the motion differs, so a left-up `service`
                // can never make the row look busy.
                return .init(shape: .symbol("terminal"), tone: .neutral,
                             label: SessionLine.bgRunningLabel(runningBgCount ?? 0),
                             pulse: (runningBgJobCount ?? 0) > 0)
            }
            return .init(shape: .symbol("message"), tone: .neutral, label: "Waiting for your reply")

        case .succeeded:
            return .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Succeeded")

        case .failed:
            // A failure the server is about to undo by itself is not red: the situation is
            // handled and nothing is being asked of the reader (the same reasoning the
            // transcript's auto-retry card draws neutral until the retries run out). Red would
            // put the row in the list's "look at me" set for the 30 seconds before it fixes
            // itself — including the runner-offline case, whose retry waits out a restart.
            if retryPending {
                return .init(shape: .symbol("clock.arrow.circlepath"), tone: .neutral,
                             label: "Retrying — the run resumes on its own")
            }
            let err = (error ?? "").lowercased()
            if err.contains("offline") {
                return .init(shape: .symbol("wifi.slash"), tone: .neutral,
                             label: "Disconnected — runner went offline")
            }
            let detail = (error?.isEmpty == false) ? error! : "Failed"
            return .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: detail)

        case .interrupted:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Interrupted")

        case .ended:
            // Every deliberate end — filed, ended, stopped, task-driven — draws the same neutral
            // check. Grey rather than green because the run reported no verdict of its own, and
            // one glyph rather than three because resume eligibility never depended on which act
            // ended it.
            return .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Ended")

        case .unknown:
            // DTO resolution filters this case. A direct caller still gets a safe terminal glyph.
            return .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Ended")
        }
    }
}
