import Foundation

/// The row a transcript was opened at, held in place while the rest of the conversation lands. That
/// row is the waiting card a project row's tap opened it on, or the record a link named (web parity:
/// `landingRef` / `keepLanding` in WorkspaceView.tsx; Android `CardFocus.Held`).
///
/// Placing the row once was not enough. The rest of the first page, the cards read beside it,
/// translations and images all land after it and push it out of view. A self-sizing List also places
/// rows it has not laid out yet by their estimated heights, so the first landing is off by however
/// wrong those estimates were. So the row is put back (`keep`) on every publish and every change in
/// the content's height (a row measured, an image loaded, a reply translated). The hold ends when the
/// reader takes the scroller, jumps to the latest, sends, or opens another session, and the
/// transcript drops it then. It also ends once nothing has moved the row for `quiet`. While it holds,
/// the transcript is not pinned to its tail (`TailPinning`).
public struct TranscriptLanding: Equatable, Sendable {
    /// Where in the viewport the row is held: a waiting card by its top (its header and title), a
    /// record in the middle.
    public enum Place: Equatable, Sendable {
        case top
        case center
    }

    /// How long the row is held with nothing moving it (web `LANDING_QUIET_MS`). Long enough for the
    /// rest of the first page, its cards, translations and images to land above it. Short enough that
    /// a reader who never touches the scroller is not held against a conversation that keeps changing.
    public static let quiet: TimeInterval = 5

    /// How long a request to open at a waiting card stands with no such card drawn (web
    /// `WAITING_REVEAL_EXPIRES_MS`). A card answered elsewhere before the open is never drawn, and a
    /// request left standing fired on whatever waiting card appeared later. That moved a reader who
    /// was by then reading something else. It used to stand for 60 s.
    public static let waitingRequestLifetime: TimeInterval = 10

    /// Whether a request to open at a waiting card, made at `askedAt`, may still be followed at `now`.
    public static func waitingRequestStands(askedAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(askedAt) < waitingRequestLifetime
    }

    public let rowID: String
    public let sessionID: String
    public let place: Place
    /// When the row was placed, or last had to be put back because the content moved it.
    public private(set) var movedAt: Date
    /// The content height the row was last put back against: a new one is what moves it.
    private var contentHeight: Double?

    public init(rowID: String, sessionID: String, place: Place, at now: Date) {
        self.rowID = rowID
        self.sessionID = sessionID
        self.place = place
        self.movedAt = now
    }

    /// The conversation changed under the held row: a publish, or a geometry reading. Answers
    /// whether the row is still held, and so is to be put back. False for another session's
    /// transcript, and once nothing has moved the row for `quiet`. The transcript drops the hold then.
    ///
    /// `contentHeight` is the content's height when the reading says it changed, and nil when nothing
    /// resized (a publish, or a scroll frame). Only a new height restarts the quiet wait, because only
    /// content of a new height moves the row (web restarts it only when its put-back moved
    /// `scrollTop`). A row already in place under a conversation that keeps publishing is let go on
    /// time instead of being held for as long as anything else changes.
    public mutating func keep(in sessionID: String, contentHeight: Double?, at now: Date) -> Bool {
        guard sessionID == self.sessionID, now.timeIntervalSince(movedAt) < Self.quiet else { return false }
        if let contentHeight, contentHeight != self.contentHeight {
            self.contentHeight = contentHeight
            movedAt = now
        }
        return true
    }
}
