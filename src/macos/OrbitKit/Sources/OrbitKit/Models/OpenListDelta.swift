import Foundation

/// One answer to `GET /sessions?view=open&since=<cursor>` (`APIClient.listOpenSessions(since:)`).
public enum OpenListRead: Equatable, Sendable {
    /// The whole list, and the cursor to ask the next delta against. The server sends this for a
    /// first read and for any cursor it no longer holds. `cursor` is nil when the server has no
    /// delta read at all: an older one ignores `since` and answers the plain array.
    case full([Session], cursor: String?)
    /// What changed since the cursor the read was asked against.
    case delta(OpenListDelta)
}

/// The Open list's change since a cursor: rows whose content moved (new ones included), ids that
/// left the list (finished, trashed or deleted), and the whole id order — only when it moved.
public struct OpenListDelta: Equatable, Sendable, Decodable {
    public let upserts: [Session]
    public let removedIds: [String]
    public let order: [String]?
    public let cursor: String

    public init(upserts: [Session], removedIds: [String], order: [String]?, cursor: String) {
        self.upserts = upserts
        self.removedIds = removedIds
        self.order = order
        self.cursor = cursor
    }

    /// Nothing moved: the list under the new cursor is the one under the old.
    public var isEmpty: Bool { upserts.isEmpty && removedIds.isEmpty && order == nil }

    /// `base` — the list as the server last sent it under the cursor this answers — brought up to
    /// the server's list now, in the server's order. nil when the two cannot be the same list (a
    /// row the order names that neither side has, or an upsert outside the order), which the
    /// caller answers by reading the whole list again.
    public func applied(to base: [Session]) -> [Session]? {
        let fresh = Dictionary(upserts.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        if let order {
            let held = Dictionary(base.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            var list: [Session] = []
            list.reserveCapacity(order.count)
            for id in order {
                guard let row = fresh[id] ?? held[id] else { return nil }
                list.append(row)
            }
            guard Set(order).isSuperset(of: fresh.keys) else { return nil }
            return list
        }
        // No order: every row kept its place, so nothing can have been added.
        let removed = Set(removedIds)
        var list: [Session] = []
        list.reserveCapacity(base.count)
        var replaced = 0
        for row in base where !removed.contains(row.id) {
            if let update = fresh[row.id] {
                list.append(update)
                replaced += 1
            } else {
                list.append(row)
            }
        }
        return replaced == fresh.count ? list : nil
    }
}

extension OpenListRead {
    /// The wire body: the delta object, or — from a server that predates it — the plain array.
    static func decode(_ data: Data, with decoder: JSONDecoder) throws -> OpenListRead {
        if data.first(where: { !$0.isASCIIWhitespace }) == UInt8(ascii: "[") {
            return .full(try decoder.decode([Session].self, from: data), cursor: nil)
        }
        let wire = try decoder.decode(Wire.self, from: data)
        if wire.full {
            return .full(wire.sessions ?? [], cursor: wire.cursor)
        }
        return .delta(OpenListDelta(upserts: wire.upserts ?? [], removedIds: wire.removedIds ?? [],
                                    order: wire.order, cursor: wire.cursor))
    }

    private struct Wire: Decodable {
        let full: Bool
        let sessions: [Session]?
        let upserts: [Session]?
        let removedIds: [String]?
        let order: [String]?
        let cursor: String
    }
}

private extension UInt8 {
    var isASCIIWhitespace: Bool { self == 0x20 || self == 0x0A || self == 0x0D || self == 0x09 }
}
