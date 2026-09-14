import Foundation

/// Contract §3's watch state machine as a client acts on it: which states are terminal, which moves
/// are legal, and so which controls a watch offers. `WatchContractTests` holds `terminal` and
/// `transitions` to `contracts/watch.contract.json`, so no control can offer a move the server's
/// machine doesn't have.
public enum WatchStateMachine {
    public static let terminal: Set<WatchState> = [.matched, .expired, .cancelled, .revoked, .unresolvable]

    /// Every legal move, in the contract's order.
    public static let transitions: [(from: WatchState, to: WatchState)] = [
        (.active, .paused),
        (.paused, .active),
        (.active, .matched),
        (.active, .expired),
        (.paused, .expired),
        (.active, .cancelled),
        (.paused, .cancelled),
        (.active, .revoked),
        (.active, .unresolvable),
    ]

    public static func canTransition(from: WatchState, to: WatchState) -> Bool {
        transitions.contains { $0.from == from && $0.to == to }
    }

    /// Still watching, so still pausable, resumable, editable and stoppable — the server's `LIVE_STATES`.
    public static func isLive(_ state: WatchState) -> Bool {
        state == .active || state == .paused
    }

    /// The controls a watch in this state offers, in display order. View is always there: an ended
    /// watch is still its own audit record.
    public static func controls(for state: WatchState) -> [WatchControl] {
        switch state {
        case .active: return [.view, .edit, .pause, .stop]
        case .paused: return [.view, .edit, .resume, .stop]
        default: return [.view]
        }
    }
}

/// One thing the owner can do to a watch from its card.
public enum WatchControl: String, CaseIterable, Sendable {
    case view, edit, pause, resume, stop

    public var title: String {
        switch self {
        case .view: return "View"
        case .edit: return "Edit"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .stop: return "Stop"
        }
    }

    /// Where the server's machine moves the watch, or nil for the controls that don't move it. Stop
    /// is the contract's CANCELLED: the one unmatched end that wakes nobody (§3).
    public var resultingState: WatchState? {
        switch self {
        case .pause: return .paused
        case .resume: return .active
        case .stop: return .cancelled
        case .view, .edit: return nil
        }
    }
}
