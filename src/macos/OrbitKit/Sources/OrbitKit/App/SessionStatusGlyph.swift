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

    public init(shape: Shape, tone: Tone, label: String) {
        self.shape = shape
        self.tone = tone
        self.label = label
    }

    /// The glyph for a session. Lifecycle location never overrides the run's actual state.
    public static func make(for s: Session, now: Date = Date()) -> SessionStatusGlyph {
        make(runState: s.effectiveRunState,
             pendingApprovals: s.pendingApprovals,
             runningBgCount: s.runningBgCount,
             engineTurnActive: s.engineTurnActive == true,
             error: s.error,
             retryPending: s.retryPending(now: now))
    }

    /// Compatibility overload for callers that hold legacy plain fields rather than a Session.
    public static func make(status: RunStatus,
                            runState: SessionRunState? = nil,
                            sessionState: SessionState? = nil,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            engineTurnActive: Bool = false,
                            error: String? = nil,
                            endReason: String? = nil,
                            retryPending: Bool = false) -> SessionStatusGlyph {
        make(runState: SessionRunState.resolve(runState, legacy: sessionState,
                                               status: status, endReason: endReason),
             pendingApprovals: pendingApprovals,
             runningBgCount: runningBgCount,
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
                            engineTurnActive: Bool = false,
                            error: String? = nil,
                            retryPending: Bool = false) -> SessionStatusGlyph {
        // The working glyph, shared by the two states that mean the agent is generating.
        func generating() -> SessionStatusGlyph {
            if (pendingApprovals ?? 0) > 0 {
                return .init(shape: .symbol("pause.circle"), tone: .warning, label: "Waiting for approval")
            }
            return .init(shape: .spinner, tone: .brand, label: "Running")
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
            if (runningBgCount ?? 0) > 0 {
                // Not the agent working: a dev server or watcher the agent left up never exits,
                // so the working spinner would mark the session busy for the rest of its life.
                // A static, muted console glyph says "still something running" without it.
                return .init(shape: .symbol("terminal"), tone: .neutral,
                             label: SessionLine.bgRunningLabel(runningBgCount ?? 0))
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
