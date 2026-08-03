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
    public static func make(for s: Session) -> SessionStatusGlyph {
        make(runState: s.effectiveRunState,
             pendingApprovals: s.pendingApprovals,
             runningBgCount: s.runningBgCount,
             error: s.error,
             endReason: s.endReason)
    }

    /// Compatibility overload for callers that hold legacy plain fields rather than a Session.
    public static func make(status: RunStatus,
                            runState: SessionRunState? = nil,
                            sessionState: SessionState? = nil,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            error: String? = nil,
                            endReason: String? = nil) -> SessionStatusGlyph {
        make(runState: SessionRunState.resolve(runState, legacy: sessionState,
                                               status: status, endReason: endReason),
             pendingApprovals: pendingApprovals,
             runningBgCount: runningBgCount,
             error: error,
             endReason: endReason)
    }

    /// The shared presentation mapping for the orthogonal execution state. `endReason` only ever
    /// refines wording within a state — it never selects a different one (see `.cancelled`).
    public static func make(runState: SessionRunState,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            error: String? = nil,
                            endReason: String? = nil) -> SessionStatusGlyph {
        switch runState {
        case .queued:
            return .init(shape: .symbol("clock"), tone: .neutral, label: "Queued")

        case .running:
            if (pendingApprovals ?? 0) > 0 {
                return .init(shape: .symbol("pause.circle"), tone: .warning, label: "Waiting for approval")
            }
            return .init(shape: .spinner, tone: .brand, label: "Running")

        case .awaitingInput:
            if (runningBgCount ?? 0) > 0 {
                return .init(shape: .spinner, tone: .brand, label: SessionLine.bgRunningLabel(runningBgCount ?? 0))
            }
            return .init(shape: .symbol("message"), tone: .neutral, label: "Waiting for your reply")

        case .succeeded:
            return .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Succeeded")

        case .failed:
            let err = (error ?? "").lowercased()
            if err.contains("offline") {
                return .init(shape: .symbol("wifi.slash"), tone: .neutral,
                             label: "Disconnected — runner went offline")
            }
            let detail = (error?.isEmpty == false) ? error! : "Failed"
            return .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: detail)

        case .dormant:
            return .init(shape: .symbol("pause.circle"), tone: .neutral,
                         label: "Dormant — send a message to resume")

        case .cancelled:
            // Filing a live session into Completed recycles its runtime, so it settles here with
            // endReason 'completed'. That's a deliberate wrap-up, not a stop: it gets a check
            // rather than the stop glyph — neutral, since the run never reported success itself.
            if runState.isCompletedByUser(endReason: endReason) {
                return .init(shape: .symbol("checkmark.circle"), tone: .neutral, label: "Completed")
            }
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Cancelled")

        case .interrupted:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Interrupted")

        case .ended:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Ended")

        case .unknown:
            // DTO resolution filters this case. A direct caller still gets a safe terminal glyph.
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Ended")
        }
    }
}
