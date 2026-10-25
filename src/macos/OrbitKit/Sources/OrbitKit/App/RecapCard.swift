import Foundation

/// The conversation's last row while it is at rest (the owner, 2026-10-22,
/// docs/mocks/session-recap-display/04-decided): the recap its list row reads in one line, here
/// whole, with when it was written and a way to write it again now. A port of the web's
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
    /// governs the list row's recap governs this too. `now` dates the time, injectable for tests.
    public static func make(for s: Session, recaps: Bool, now: Date = Date()) -> RecapCard? {
        guard recaps, s.effectiveLifecycleState != .trash, rests(s),
              let text = s.recapText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
        else { return nil }
        return RecapCard(text: text, when: whenWritten(s.recapAt, now: now))
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

    /// What a refresh that wrote nothing says to the reader.
    public struct Notice: Equatable, Sendable {
        public let text: String
        /// A failure, which the reader may want to try again — drawn as one.
        public let failed: Bool
    }

    /// The notice for a pass that wrote nothing, by its reason (apiserver sessions/recap.ts
    /// `RecapSkipReason`). Nil when there is nothing to say: another pass wrote first, and reading
    /// the session again shows that one's line. Web parity: `recapRefreshNotice`.
    public static func notice(for reason: String) -> Notice? {
        switch reason {
        case "cas-lost":
            return nil
        case "no-events":
            return Notice(text: upToDate, failed: false)
        case "too-few-events":
            return Notice(text: tooLittle, failed: false)
        case "no-key", "disabled":
            return Notice(text: unavailable, failed: false)
        default:
            return Notice(text: failed, failed: true)
        }
    }

    // MARK: words — the web's `RECAP_CARD_COPY` (components/SessionRecapCard.tsx)

    /// The card's name, over the recap.
    public static let word = "Recap"
    /// The refresh button, as VoiceOver and the pointer's help read it.
    public static let refresh = "Refresh recap"
    public static let upToDate = "The recap is already up to date."
    public static let tooLittle = "There's too little to recap yet."
    public static let unavailable = "Recaps aren't available on this server."
    public static let failed = "Couldn't refresh the recap. Try again."

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
