import Foundation

/// The Merge and Commit requests this client made whose result the runner hasn't reported yet, one
/// per session — the native port of web's `pendingSessionOperations` (`WorkspaceView`). Both finish
/// on a runner heartbeat, often after the console that asked has lost focus, so the app follows each
/// one from above the consoles and shows its result wherever the user is by then.
///
/// Only requests made here are followed, as on web: a merge an agent or another device started is
/// the bar's to show, not a card's. This is the bookkeeping; the poll around it is the app shell's
/// (`ConsoleRegistry`).
public struct PendingSessionOperations: Sendable {
    public enum Kind: Equatable, Sendable { case merge, commit }

    /// One accepted request. `token` tells two requests for the same session apart, so a read taken
    /// for the first can never settle the second.
    public struct Operation: Equatable, Sendable {
        public let sessionID: String
        public let kind: Kind
        public let token: Int
    }

    private var bySession: [String: Operation] = [:]
    private var lastToken = 0

    public init() {}

    public var isEmpty: Bool { bySession.isEmpty }
    /// Everything still waiting on the runner — what the next poll pass reads.
    public var operations: [Operation] { Array(bySession.values) }

    /// Follow a request the server just accepted. A newer request for the same session replaces the
    /// older one: its result is the one still to come.
    @discardableResult
    public mutating func track(_ kind: Kind, sessionID: String) -> Operation {
        lastToken += 1
        let operation = Operation(sessionID: sessionID, kind: kind, token: lastToken)
        bySession[sessionID] = operation
        return operation
    }

    /// Fold in a read of the session taken after `operation` was accepted. Once the runner has
    /// answered — the operation's status is no longer `pending` — it leaves and is returned, so its
    /// result is reported exactly once. A status that's gone altogether settles it too: something
    /// else (a Resume) superseded the request, and there's no result left to report. Nil while it's
    /// still pending, or when the read was for a request this session has since replaced.
    public mutating func settle(_ operation: Operation, with detail: SessionDetail) -> Operation? {
        guard bySession[operation.sessionID] == operation else { return nil }
        let status = operation.kind == .merge ? detail.mergeStatus : detail.commitStatus
        guard status != "pending" else { return nil }
        bySession[operation.sessionID] = nil
        return operation
    }

    /// The same for a read the app took anyway — the session's open console polling its bar — which
    /// answers whatever is pending there. The caller vouches the read started after that was accepted.
    public mutating func settle(sessionID: String, with detail: SessionDetail) -> Operation? {
        guard let operation = bySession[sessionID] else { return nil }
        return settle(operation, with: detail)
    }

    /// Stop following `operation` without a result: its session is gone, or so is the sign-in.
    public mutating func drop(_ operation: Operation) {
        if bySession[operation.sessionID] == operation { bySession[operation.sessionID] = nil }
    }
}
