import Foundation

/// Which sign-in cards and account-switch lines the conversation has moved past (web parity: the
/// `settled` marks `Transcript.tsx` sets while building its nodes).
///
/// Only the latest failure whose outcome is still open is a remedy. One above a later message is
/// superseded — its Retry re-sends the session's latest message, no longer the one this failure
/// ate — and one the agent worked after is resolved, even past a later message, since that work is
/// what signing in was for. Either way the card is history: a muted row with no actions. An account
/// switch drops to the same tone once anything follows it.
///
/// Read off the items rather than kept by the reducer, so a page of older events, a trim, or a
/// rehydrated snapshot can never leave a mark behind on the wrong row.
public struct TranscriptSettlement: Equatable, Sendable {
    public enum Auth: Equatable, Sendable { case resolved, superseded }

    public private(set) var auth: [String: Auth] = [:]
    public private(set) var settledNotices: Set<String> = []

    public init(_ items: [TranscriptItem]) {
        var openAuth: String?
        var openSwitches: [String] = []
        func settleSwitches() {
            settledNotices.formUnion(openSwitches)
            openSwitches.removeAll()
        }
        for item in items {
            switch item {
            case .authError(let id, _):
                if let open = openAuth, auth[open] == nil { auth[open] = .superseded }
                openAuth = id
            case .user:
                if let open = openAuth, auth[open] == nil { auth[open] = .superseded }
                settleSwitches()
            case .assistant, .toolCall:
                if let open = openAuth { auth[open] = .resolved }
                openAuth = nil
                settleSwitches()
            case .notice(let id, _, let accountSwitch):
                if accountSwitch { openSwitches.append(id) }
            default:
                break
            }
        }
    }
}
