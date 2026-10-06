import Foundation

/// How the app polls the Open list: the delta read where the server has one, otherwise the
/// conditional full read it used before.
///
/// The delta (`APIClient.listOpenSessions(since:)`) is applied to the list exactly as the server
/// last sent it under the cursor, never to whatever the app has since folded events into, so what
/// comes out is the list a full read would have returned, in the server's order. When that cannot
/// hold — the server turns `since` down, answers the plain array (it predates the delta read), or a
/// delta does not fit its base — the poll falls back to `listOpenSessions(ifNoneMatch:)`, and asks
/// for the delta again `deltaRetryInterval` later, so a server upgraded under a running app is
/// picked up.
///
/// One read at a time: the caller serializes `read()` (AppModel's `loadSessions` single flight).
@MainActor
public final class OpenListReader {
    public enum Outcome: Equatable {
        /// The list the caller holds is still the server's: nothing to adopt or announce.
        case unchanged
        /// The server's Open list now.
        case list([Session])
    }

    private let api: APIClient
    private let now: () -> Date
    private let deltaRetryInterval: TimeInterval

    /// The full read's tag for the list the caller holds.
    private var etag: String?
    /// The delta read's cursor, and the list as the server sent it under that cursor.
    private var cursor: String?
    private var base: [Session] = []
    /// Whether the caller's list is still the last one handed out — the condition for answering an
    /// unchanged read with `.unchanged`. `invalidate()` clears it, `adopted()` sets it.
    private var current = false
    private var deltaRetryAt: Date?

    public init(api: APIClient, deltaRetryInterval: TimeInterval = 300, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.deltaRetryInterval = deltaRetryInterval
        self.now = now
    }

    /// The rows the last `.list` changed in place — a delta with no order and nothing removed, so
    /// every other row is the previous list's, where it was. nil for any other list.
    public private(set) var replacedRows: [Session]?

    /// Whether polls go out as the delta read (or would, at the next one).
    public var usesDelta: Bool { deltaRetryAt.map { now() >= $0 } ?? true }

    public func read() async throws -> Outcome {
        if usesDelta {
            switch try await api.listOpenSessions(since: cursor ?? "") {
            case .full(let list, let next)?:
                // No cursor: a server without the delta read answered the plain list.
                if next == nil { deltaUnavailable() }
                remember(list, cursor: next, etag: nil)
                return .list(list)
            case .delta(let delta)?:
                if delta.isEmpty, current {
                    cursor = delta.cursor
                    return .unchanged
                }
                if cursor != nil, let list = delta.applied(to: base) {
                    remember(list, cursor: delta.cursor, etag: nil)
                    if delta.order == nil && delta.removedIds.isEmpty { replacedRows = delta.upserts }
                    return .list(list)
                }
                // It does not fit the list it should apply to. Read the list whole; the next poll
                // starts a fresh cursor.
                forgetDelta()
            case nil:
                deltaUnavailable()
            }
        }
        guard let fresh = try await api.listOpenSessions(ifNoneMatch: current ? etag : nil) else {
            return .unchanged
        }
        remember(fresh.sessions, cursor: nil, etag: fresh.etag)
        return .list(fresh.sessions)
    }

    /// The caller's list was written some other way (an event folded in): no read may answer
    /// `.unchanged` for it until a read's list is adopted again.
    public func invalidate() { current = false }

    /// The caller adopted the list the last `read()` returned.
    public func adopted() { current = true }

    private func remember(_ list: [Session], cursor next: String?, etag tag: String?) {
        cursor = next
        base = next == nil ? [] : list
        replacedRows = nil
        etag = tag
        current = false
    }

    private func forgetDelta() {
        cursor = nil
        base = []
    }

    private func deltaUnavailable() {
        forgetDelta()
        deltaRetryAt = now().addingTimeInterval(deltaRetryInterval)
    }
}
