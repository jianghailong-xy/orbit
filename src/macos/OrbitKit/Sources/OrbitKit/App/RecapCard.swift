import Foundation

/// The conversation's last row while it is at rest (the owner, 2026-10-22,
/// docs/mocks/session-recap-display/04-decided): the recap its list row reads in one line, here
/// whole, with when it was written. A port of the web's
/// `SessionRecapCard`, whose words `RecapCardCopyParityTests` holds these to.
public struct RecapCard: Equatable, Sendable {
    /// The recap, whole: the server stores one line of at most 80 characters.
    public let text: String
    /// When it was written (`whenWritten`), or nil for a recap that carries no time.
    public let when: String?

    public init(text: String, when: String?) {
        self.text = text
        self.when = when
    }

    /// The card for `session`, or nil while the conversation is not at rest for one (`rests`), in
    /// Trash, with no recap, or with the account's Session recaps switch off — the switch that
    /// governs the list row's recap governs this too — or when this device hid that very recap with
    /// the card's × (`hidden`, the `hideKey` it stored). `now` dates the time, injectable for tests.
    public static func make(for s: Session, recaps: Bool, hidden: String? = nil, now: Date = Date()) -> RecapCard? {
        guard recaps, s.effectiveLifecycleState != .trash, rests(s),
              let text = s.recapText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
              hidden != hideKey(recapAt: s.recapAt, text: text)
        else { return nil }
        return RecapCard(text: text, when: whenWritten(s.recapAt, now: now))
    }

    /// What a recap this device hid is remembered by (the owner, 2026-11-01,
    /// docs/mocks/session-recap-display/06-hide): when it was written, so the next one the server
    /// writes shows again — or its words, for a recap that came with no time. Web parity:
    /// `recapHideKey`.
    public static func hideKey(recapAt: String?, text: String) -> String {
        if let recapAt, !recapAt.isEmpty { return recapAt }
        return "text:\(text)"
    }

    /// Where this device keeps the recap it hid in a session: one UserDefaults entry per session, as
    /// the web keeps one per session in its browser's storage.
    public static func hiddenDefaultsKey(session id: String) -> String {
        "orbit.recap.hidden.\(id)"
    }

    /// Whether a conversation is at rest for its card: nothing it is doing or asking outranks the
    /// summary of what it did. The lines that outrank the recap on its row (`SessionLine.make`) and
    /// are work in hand — waiting on you, generating, queued, an agent it started — keep the card
    /// away. A watch it is parked on, or a process it left running, is no turn of its own and does
    /// not. Web parity: `restsForRecap`.
    public static func rests(_ s: Session) -> Bool {
        (s.pendingApprovals ?? 0) == 0
            && !s.isGenerating
            && s.effectiveRunState != .queued
            && (s.runningSubagentCount ?? 0) == 0
    }

    /// When the recap was written: "5:38 PM" today, "Wed, Aug 6, 5:38 PM" on another day, because a
    /// bare clock time on another day misleads. Nil for a recap that arrived with no time, from an
    /// older control plane. Web parity: `recapWhen`.
    public static func whenWritten(_ recapAt: String?, now: Date = Date()) -> String? {
        guard let recapAt, let at = RelativeTime.parse(recapAt) else { return nil }
        let clock = clockTime.string(from: at)
        return Calendar.current.isDate(at, inSameDayAs: now) ? clock : "\(dayTime.string(from: at)), \(clock)"
    }

    // MARK: words — the web's `RECAP_CARD_COPY` (components/SessionRecapCard.tsx)

    /// The card's name, over the recap.
    public static let word = "Recap"
    /// The × at the end of the recap that hides this recap in this conversation on this device, as
    /// VoiceOver reads it. It was a ⋯ menu with Refresh too; the owner, 2026-11-16: just the ×.
    public static let hide = "Hide recap"

    // Built once and reused, like `RelativeTime`'s: "5:38 PM" and "Wed, Aug 6" — what the web's
    // `toLocaleTimeString`/`toLocaleDateString` calls produce in its default locale.
    private static let clockTime: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        return f
    }()
    private static let dayTime: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()
}
