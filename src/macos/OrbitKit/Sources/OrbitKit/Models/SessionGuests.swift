import Foundation

/// One person who can reply in a session, as the owner's `GET /sessions/:id/guests` lists them.
/// Mirrors `@orbit/shared`'s `SessionGuestPerson` (docs/session-guests-design.md §3, §7).
public struct SessionGuestPerson: Codable, Equatable, Sendable, Identifiable {
    public let userId: String
    public let name: String
    public let email: String
    public let addedAt: String
    /// The guest's messages to this session since midnight UTC.
    public let messagesToday: Int
    /// Whether the guest has opened the session at least once.
    public let opened: Bool

    public var id: String { userId }

    public init(userId: String, name: String, email: String, addedAt: String,
                messagesToday: Int, opened: Bool) {
        self.userId = userId
        self.name = name
        self.email = email
        self.addedAt = addedAt
        self.messagesToday = messagesToday
        self.opened = opened
    }
}

/// What all three owner routes answer: the people as they now stand.
struct SessionGuestList: Decodable {
    let guests: [SessionGuestPerson]
}

struct InviteSessionGuestRequest: Encodable {
    let email: String
}
