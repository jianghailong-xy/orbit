import Foundation

/// The one status glyph shown at the leading edge of a session row — a direct port of the web Agent
/// console's `StatusIcon`. Colour carries the meaning: brand = working, warning = needs a human
/// decision, success = done, error = a real failure, neutral = a benign terminal / queued state.
///
/// Kept in OrbitKit (not the SwiftUI view) so the exact web mapping is shared by macOS + iOS and
/// unit-tested. The view turns `shape`/`tone` into an SF Symbol (or spinner) and a colour.
///
/// New servers provide `sessionState`, the authoritative user-facing lifecycle. The tab-derived
/// `completed` / `deleted` flags and low-level `status` / `endReason` mapping remain for older
/// servers that omit it.
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

    /// The glyph for a session, mirroring web `StatusIcon({ session, completed })`.
    /// `completed` = the Completed (archived) tab is showing this row; `deleted` = the Trash tab.
    public static func make(for s: Session, completed: Bool = false, deleted: Bool = false) -> SessionStatusGlyph {
        make(status: s.effectiveRunStatus, sessionState: s.sessionState,
             completed: completed, deleted: deleted,
             pendingApprovals: s.pendingApprovals, runningBgCount: s.runningBgCount,
             error: s.error, endReason: s.endReason)
    }

    /// The same mapping over plain fields, for callers that hold something other than a list-shaped
    /// `Session` — the ⌘K search hit, whose payload is deliberately thinner. Faking a `Session` to
    /// call the overload above would mean getting a long memberwise init exactly right for no gain.
    public static func make(status: RunStatus,
                            sessionState: SessionState? = nil,
                            completed: Bool = false,
                            deleted: Bool = false,
                            pendingApprovals: Int? = nil,
                            runningBgCount: Int? = nil,
                            error: String? = nil,
                            endReason: String? = nil) -> SessionStatusGlyph {
        if let sessionState, sessionState != .unknown {
            return make(sessionState: sessionState,
                        pendingApprovals: pendingApprovals,
                        runningBgCount: runningBgCount,
                        error: error)
        }

        // Trash tab: a soft-deleted session reads as deleted regardless of its settled status —
        // web branches on `deletedAt` first with the same neutral ⊖ + "Deleted" tooltip.
        if deleted {
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Deleted")
        }
        // Completed tab: the user deliberately filed this session, so it reads as done even though
        // its status settles to CANCELLED async. A genuine FAILED still falls through to its glyph.
        if completed && status != .failed {
            return .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Completed")
        }
        switch status {
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
            return .init(shape: .symbol("checkmark.circle.fill"), tone: .success, label: "Completed")

        case .failed:
            let err = (error ?? "").lowercased()
            if err.contains("offline") {
                return .init(shape: .symbol("wifi.slash"), tone: .neutral,
                             label: "Disconnected — runner went offline")
            }
            let detail = (error?.isEmpty == false) ? error! : "Failed"
            return .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: detail)

        case .cancelled, .interrupted:
            // Default to dormant (resumable); ⊖ only for a positively-terminal end. A legacy row
            // with an unknown reason fails to the neutral, resumable read.
            let reason = endReason ?? ""
            let terminalCancel =
                reason == "orphaned" || reason == "deleted" || reason == "completed" ||
                reason == "cancelled" || (status == .interrupted && reason.isEmpty)
            if !terminalCancel {
                return .init(shape: .symbol("pause.circle"), tone: .neutral,
                             label: "Dormant — send a message to resume")
            }
            let label = reason == "orphaned" ? "Ended — task already finished"
                      : status == .interrupted ? "Interrupted"
                      : "Cancelled"
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: label)

        case .pending:
            return .init(shape: .symbol("clock"), tone: .neutral, label: "Queued")
        }
    }

    /// Authoritative mapping for the control plane's normalized, user-facing lifecycle.
    private static func make(sessionState: SessionState,
                             pendingApprovals: Int?,
                             runningBgCount: Int?,
                             error: String?) -> SessionStatusGlyph {
        switch sessionState {
        case .queued:
            return .init(shape: .symbol("clock"), tone: .neutral, label: "Queued")

        case .running:
            if (pendingApprovals ?? 0) > 0 {
                return .init(shape: .symbol("pause.circle"), tone: .warning,
                             label: "Waiting for approval")
            }
            return .init(shape: .spinner, tone: .brand, label: "Running")

        case .awaitingInput:
            if (runningBgCount ?? 0) > 0 {
                return .init(shape: .spinner, tone: .brand,
                             label: SessionLine.bgRunningLabel(runningBgCount ?? 0))
            }
            return .init(shape: .symbol("message"), tone: .neutral,
                         label: "Waiting for your reply")

        case .dormant:
            return .init(shape: .symbol("pause.circle"), tone: .neutral,
                         label: "Dormant — send a message to resume")

        case .completed:
            return .init(shape: .symbol("checkmark.circle.fill"), tone: .success,
                         label: "Completed")

        case .failed:
            let err = (error ?? "").lowercased()
            if err.contains("offline") {
                return .init(shape: .symbol("wifi.slash"), tone: .neutral,
                             label: "Disconnected — runner went offline")
            }
            let detail = (error?.isEmpty == false) ? error! : "Failed"
            return .init(shape: .symbol("xmark.circle.fill"), tone: .error, label: detail)

        case .cancelled:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Cancelled")

        case .interrupted:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Interrupted")

        case .ended:
            return .init(shape: .symbol("minus.circle"), tone: .neutral,
                         label: "Ended — task already finished")

        case .deleted:
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Deleted")

        case .unknown:
            // Filtered by the caller so an unknown future state uses the legacy mapping.
            assertionFailure("Unknown session state must use the legacy status fallback")
            return .init(shape: .symbol("minus.circle"), tone: .neutral, label: "Ended")
        }
    }
}
