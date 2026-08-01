import Foundation

/// Exact session records fetched outside the currently loaded list scopes.
///
/// A cold deep link or global-search hit may target an Archived / Trash session, so it cannot be
/// recovered from the cross-agent Open snapshot. The app keeps that detail response here for the
/// console header, composer filing banner and server-derived capabilities. Loaded list snapshots
/// remain preferred because they are refreshed by the control plane; `reconcile(with:)` also writes
/// their newer copy through to an existing detail entry so the fallback cannot regress if the row
/// later leaves the visible list.
public struct SessionDetailCache: Sendable {
    private var records: [String: Session] = [:]

    public init() {}

    /// Resolve a session from freshest UI-owned snapshots first, then the exact-detail fallback.
    public func resolve(_ id: String, preferring snapshots: [Session]...) -> Session? {
        for snapshot in snapshots {
            if let session = snapshot.first(where: { $0.id == id }) { return session }
        }
        return records[id]
    }

    /// Retain a detail response that would otherwise be lost after routing resolves its owner.
    public mutating func store(_ session: Session) {
        records[session.id] = session
    }

    /// Refresh only records already owned by this cache. This avoids copying the whole Open list,
    /// while ensuring a newer list row replaces an older cold-fetch fallback for the same id.
    public mutating func reconcile(with snapshot: [Session]) {
        for session in snapshot where records[session.id] != nil {
            records[session.id] = session
        }
    }

    public mutating func remove(_ id: String) {
        records[id] = nil
    }

    public mutating func removeAll() {
        records.removeAll()
    }
}
