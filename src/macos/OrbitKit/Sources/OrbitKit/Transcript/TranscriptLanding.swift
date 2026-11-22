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
/// transcript drops it then. It also ends once no put-back has had to move the row for `quiet`
/// (`read`). While it holds, the transcript is not pinned to its tail (`TailPinning`).
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
    /// When the row was placed, or last had to be put back because the content had moved it.
    public private(set) var movedAt: Date
    /// The list's content offset when the last put-back was made, until a reading says whether it
    /// moved the list.
    private var putBackFrom: Double?

    /// How far the offset has to move for a put-back to count as having moved the row: past rounding
    /// to the screen's pixels.
    static let moveSlop: Double = 1

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
    /// resized (a publish, or a scroll frame). A new height is why a put-back is made, but it is not
    /// evidence that the row moved: rows appended at the tail, or growing below the row, change the
    /// height and leave the row where it is. So it does not restart the quiet wait. Only a put-back
    /// that moved the list does (`puttingBack`, `read`). A conversation that keeps streaming under a
    /// row already in place lets the row go on time, and the tail pin with it.
    public func keep(in sessionID: String, contentHeight: Double?, at now: Date) -> Bool {
        sessionID == self.sessionID && now.timeIntervalSince(movedAt) < Self.quiet
    }

    /// A put-back of the row is being made, with the list's content at `offset`.
    public mutating func puttingBack(from offset: Double) {
        putBackFrom = offset
    }

    /// A reading of the list's content offset. The first one after a put-back says whether that
    /// put-back moved the list. If it did, the content had moved the row, and the quiet wait starts
    /// again from now. If it did not, the row was already in place and the wait runs on (web
    /// `keepLanding`: `if (root.scrollTop !== before)`; Android `CardFocus.moved`).
    public mutating func read(offset: Double, at now: Date) {
        guard let from = putBackFrom else { return }
        putBackFrom = nil
        if abs(offset - from) > Self.moveSlop { movedAt = now }
    }
}
